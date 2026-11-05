package records

// Service usage integration runs inside the Hub's existing system-update
// transaction.  Unlike the 30-day container_stats tiers, daily totals are
// permanent and the cursor is transactional, so restarting the Hub cannot
// replay an already-accounted interval.
import (
    "database/sql"
    "encoding/json"
    "errors"
    "math"
    "os"
    "path"
    "sort"
    "strings"
    "sync"
    "time"

    "github.com/henrygd/beszel/internal/entities/container"
    "github.com/pocketbase/dbx"
    "github.com/pocketbase/pocketbase/core"
)

const (
    ServiceUsageDailyCollection = "service_usage_daily"
    serviceUsageCursorCollection = "service_usage_cursor"
    serviceUsageMaxGap = 2 * time.Minute
)

type ServiceUsageSample struct {
    CPUHostPercent float64
    GPUUtilPercent float64
    VRAMMiB float64
    HasGPU bool
}

// Service usage groups are optional, explicit glob mappings. Without them,
// container names are distinct service identities; no unstable name heuristic
// silently merges unrelated workloads.
var serviceUsageGroups = sync.OnceValue(func() map[string][]string {
    var groups map[string][]string
    if err := json.Unmarshal([]byte(os.Getenv("SERVICE_USAGE_GROUPS")), &groups); err != nil {
        return nil
    }
    return groups
})

func ServiceUsageName(name string) string {
    groups := serviceUsageGroups()
    keys := make([]string, 0, len(groups))
    for service := range groups { keys = append(keys, service) }
    sort.Strings(keys) // deterministic priority if patterns overlap
    for _, service := range keys {
        if service == "" { continue }
        for _, pattern := range groups[service] {
            if ok, _ := path.Match(pattern, name); ok { return service }
        }
    }
    return name
}

func sumServiceUsage(samples []*container.Stats) map[string]ServiceUsageSample {
    result := make(map[string]ServiceUsageSample)
    for _, s := range samples {
        if s == nil || s.Name == "" { continue }
        key := ServiceUsageName(s.Name)
        usage := result[key]
        usage.CPUHostPercent += finiteNonNegative(s.Cpu)
        usage.GPUUtilPercent += finiteNonNegative(s.GpuUtilPercent)
        usage.VRAMMiB += finiteNonNegative(s.GpuMemMiB)
        usage.HasGPU = usage.HasGPU || s.GpuIndex != "" || s.GpuPid != "" || s.GpuMemMiB > 0 || s.GpuUtilPercent > 0
        result[key] = usage
    }
    return result
}

func finiteNonNegative(n float64) float64 {
    if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 { return 0 }
    return n
}

// RecordServiceUsage persists (previous successful poll, current poll], using
// the current reading as the sample estimate. Runs within createRecords'
// transaction, including the cursor update and each daily total upsert.
// Empty snapshots still advance the cursor so restarting an idle service does
// not attribute its new usage to the entire earlier idle period.
func RecordServiceUsage(app core.App, systemID, systemName string, at time.Time, logicalCPUs int, samples []*container.Stats, loc *time.Location) error {
    if systemID == "" { return nil }
    cursorCollection, err := app.FindCachedCollectionByNameOrId(serviceUsageCursorCollection)
    if err != nil { return err }
    cursor, err := app.FindFirstRecordByFilter(cursorCollection, "system_id = {:id}", dbx.Params{"id": systemID})
    if err != nil {
        if !errors.Is(err, sql.ErrNoRows) { return err }
        cursor = core.NewRecord(cursorCollection)
        cursor.Set("system_id", systemID)
    }
    prevMS := int64(cursor.GetFloat("at_ms"))
    atMS := at.UTC().UnixMilli()
    if atMS <= prevMS { return nil }
    cursor.Set("at_ms", atMS)
    if err := app.SaveNoValidate(cursor); err != nil { return err }
    if prevMS <= 0 { return nil }
    start := time.UnixMilli(prevMS)
    if at.Sub(start) > serviceUsageMaxGap { return nil }
    usage := sumServiceUsage(samples)
    if len(usage) == 0 { return nil }
    if loc == nil { loc = time.UTC }
    for start.Before(at) {
        local := start.In(loc)
        midnight := time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, loc)
        end := at
        if midnight.Before(end) { end = midnight }
        seconds := end.Sub(start).Seconds()
        day := local.Format("2006-01-02")
        for service, snapshot := range usage {
            if err := addServiceUsageDay(app, systemID, systemName, service, day, seconds, logicalCPUs, snapshot); err != nil {
                return err
            }
        }
        start = end
    }
    return nil
}

func addServiceUsageDay(app core.App, systemID, systemName, service, day string, seconds float64, logicalCPUs int, sample ServiceUsageSample) error {
    coll, err := app.FindCachedCollectionByNameOrId(ServiceUsageDailyCollection)
    if err != nil { return err }
    record, err := app.FindFirstRecordByFilter(coll,
        "system = {:sys} && service = {:svc} && day = {:day}",
        dbx.Params{"sys":systemID,"svc":service,"day":day})
    if err != nil {
        if !errors.Is(err, sql.ErrNoRows) { return err }
        record = core.NewRecord(coll)
        record.Set("system", systemID)
        record.Set("service", service)
        record.Set("day", day)
    }
    if strings.TrimSpace(systemName) != "" { record.Set("system_name", systemName) }
    // Agent reports host-normalized container CPU (% of all host CPU time).
    // Convert to core-seconds only when the host's logical CPU count exists.
    cpuFraction := math.Min(sample.CPUHostPercent, 100) / 100
    record.Set("seconds", record.GetFloat("seconds")+seconds)
    record.Set("cpu_host_seconds", record.GetFloat("cpu_host_seconds")+cpuFraction*seconds)
    if logicalCPUs > 0 {
        record.Set("cpu_core_seconds", record.GetFloat("cpu_core_seconds")+cpuFraction*float64(logicalCPUs)*seconds)
        record.Set("cpu_known_seconds", record.GetFloat("cpu_known_seconds")+seconds)
    }
    // GPU utilization is a SUM of process utilization across GPU devices,
    // not one bounded 0-100% host percentage. Do not clamp it to 100.
    if sample.HasGPU {
        record.Set("gpu_known_seconds", record.GetFloat("gpu_known_seconds")+seconds)
        record.Set("gpu_util_seconds", record.GetFloat("gpu_util_seconds")+sample.GPUUtilPercent/100*seconds)
        record.Set("vram_mib_seconds", record.GetFloat("vram_mib_seconds")+sample.VRAMMiB*seconds)
    }
    record.Set("peak_cpu_pct", math.Max(record.GetFloat("peak_cpu_pct"), sample.CPUHostPercent))
    record.Set("peak_gpu_pct", math.Max(record.GetFloat("peak_gpu_pct"), sample.GPUUtilPercent))
    record.Set("peak_vram_mib", math.Max(record.GetFloat("peak_vram_mib"), sample.VRAMMiB))
    record.Set("samples", record.GetInt("samples")+1)
    return app.SaveNoValidate(record)
}
