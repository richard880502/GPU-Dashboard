package records

// gpu-monitoring fork addition (not upstream): permanent per-GPU daily power
// history in the gpu_power_daily collection.
//
// system_stats keeps at most 30 days (and only 8-hour averages by then), which
// is too short and too coarse for usage statistics. Instead, every incoming
// 1m stats record (one per agent poll, every few seconds) is integrated over
// the real time since that system's previous poll and accumulated per
// system / GPU / day in memory, then added to the matching gpu_power_daily row
// once a minute. Days are calendar days in the hub's local time zone (TZ env).
// gpu_power_daily is never pruned.

import (
	"database/sql"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/henrygd/beszel/internal/entities/system"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	GpuPowerCollection = "gpu_power_daily"
	// A longer gap between two polls means the agent or hub was down; that
	// time is left out of the day's coverage instead of being guessed.
	gpuPowerMaxGap = 2 * time.Minute
	gpuDayLayout   = "2006-01-02"
)

type gpuPowerKey struct {
	system string
	gpu    string
	day    string
}

type gpuPowerTotals struct {
	name        string
	energyWs    float64 // watt-seconds
	seconds     float64 // time covered by samples
	busySeconds float64 // seconds weighted by utilization
	maxW        float64
}

func (t *gpuPowerTotals) add(o *gpuPowerTotals) {
	if o.name != "" {
		t.name = o.name
	}
	t.energyWs += o.energyWs
	t.seconds += o.seconds
	t.busySeconds += o.busySeconds
	t.maxW = max(t.maxW, o.maxW)
}

type gpuPowerMap map[gpuPowerKey]*gpuPowerTotals

// addInterval attributes the GPU readings to (start, end], split at local
// midnights so each part lands on its own day.
func (m gpuPowerMap) addInterval(systemID string, start, end time.Time, loc *time.Location, gpus map[string]system.GPUData) {
	for start.Before(end) {
		local := start.In(loc)
		nextMidnight := time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, loc)
		segEnd := end
		if nextMidnight.Before(segEnd) {
			segEnd = nextMidnight
		}
		secs := segEnd.Sub(start).Seconds()
		day := local.Format(gpuDayLayout)
		for id, gpu := range gpus {
			// an occasional bogus reading (e.g. 49183% utilization) would
			// otherwise skew a whole day's average
			power := max(gpu.Power, 0)
			usage := min(max(gpu.Usage, 0), 100)
			key := gpuPowerKey{system: systemID, gpu: id, day: day}
			t := m[key]
			if t == nil {
				t = &gpuPowerTotals{}
				m[key] = t
			}
			t.add(&gpuPowerTotals{
				name:        gpu.Name,
				energyWs:    power * secs,
				seconds:     secs,
				busySeconds: usage / 100 * secs,
				maxW:        power,
			})
		}
		start = segEnd
	}
}

// GpuPowerAccumulator collects GPU energy from live stats records.
type GpuPowerAccumulator struct {
	app     core.App
	loc     *time.Location
	mu      sync.Mutex
	last    map[string]time.Time // system id -> time of its previous poll
	pending gpuPowerMap
}

func NewGpuPowerAccumulator(app core.App, loc *time.Location) *GpuPowerAccumulator {
	return &GpuPowerAccumulator{app: app, loc: loc, last: map[string]time.Time{}, pending: gpuPowerMap{}}
}

// BindHooks feeds every new 1m system_stats record into the accumulator.
func (a *GpuPowerAccumulator) BindHooks() {
	a.app.OnRecordAfterCreateSuccess("system_stats").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("type") == "1m" {
			var stats struct {
				GPUData map[string]system.GPUData `json:"g"`
			}
			if err := e.Record.UnmarshalJSONField("stats", &stats); err == nil {
				at := e.Record.GetDateTime("created").Time()
				if at.IsZero() {
					at = time.Now()
				}
				a.Add(e.Record.GetString("system"), at, stats.GPUData)
			}
		}
		return e.Next()
	})
}

// Add integrates one poll: the readings taken at `at` stand for the time
// since the same system's previous poll.
func (a *GpuPowerAccumulator) Add(systemID string, at time.Time, gpus map[string]system.GPUData) {
	a.mu.Lock()
	defer a.mu.Unlock()
	prev, ok := a.last[systemID]
	if !at.After(prev) {
		return
	}
	a.last[systemID] = at
	if !ok || len(gpus) == 0 || at.Sub(prev) > gpuPowerMaxGap {
		return
	}
	a.pending.addInterval(systemID, prev, at, a.loc, gpus)
}

// Flush adds everything accumulated since the last flush to gpu_power_daily.
// On failure the totals are kept and retried on the next flush.
func (a *GpuPowerAccumulator) Flush() error {
	a.mu.Lock()
	pending := a.pending
	a.pending = gpuPowerMap{}
	a.mu.Unlock()
	if len(pending) == 0 {
		return nil
	}
	err := a.app.RunInTransaction(func(txApp core.App) error {
		return upsertGpuPowerDaily(txApp, pending, false)
	})
	if err != nil {
		a.mu.Lock()
		for key, t := range pending {
			if cur := a.pending[key]; cur != nil {
				t.add(cur)
			}
			a.pending[key] = t
		}
		a.mu.Unlock()
		slog.Error("Failed to save GPU power history", "err", err)
	}
	return err
}

// upsertGpuPowerDaily adds the totals to the existing day rows, creating
// missing ones.
func upsertGpuPowerDaily(app core.App, totals gpuPowerMap, estimated bool) error {
	collection, err := app.FindCollectionByNameOrId(GpuPowerCollection)
	if err != nil {
		return err
	}
	systemNames := map[string]string{}
	for key, t := range totals {
		name, ok := systemNames[key.system]
		if !ok {
			if rec, err := app.FindRecordById("systems", key.system); err == nil {
				name = rec.GetString("name")
			}
			systemNames[key.system] = name
		}
		rec, err := app.FindFirstRecordByFilter(collection, "system = {:system} && gpu = {:gpu} && day = {:day}",
			dbx.Params{"system": key.system, "gpu": key.gpu, "day": key.day})
		if err != nil {
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			rec = core.NewRecord(collection)
			rec.Set("system", key.system)
			rec.Set("gpu", key.gpu)
			rec.Set("day", key.day)
		}
		if name != "" {
			rec.Set("system_name", name)
		}
		if t.name != "" {
			rec.Set("name", t.name)
		}
		rec.Set("energy_wh", rec.GetFloat("energy_wh")+t.energyWs/3600)
		rec.Set("seconds", rec.GetFloat("seconds")+t.seconds)
		rec.Set("busy_seconds", rec.GetFloat("busy_seconds")+t.busySeconds)
		rec.Set("max_w", max(rec.GetFloat("max_w"), t.maxW))
		if estimated {
			rec.Set("estimated", true)
		}
		if err := app.SaveNoValidate(rec); err != nil {
			return err
		}
	}
	return nil
}

// BackfillGpuPowerDaily estimates day rows for the history still held in the
// averaged system_stats records (10m back to 480m, i.e. up to 30 days), so
// the history does not start empty. Each tier only covers the time before the
// earliest record of the finer tier. Rows are flagged as estimated: the
// averages hide peaks (max_w is a peak of averages) and gaps.
func BackfillGpuPowerDaily(app core.App, loc *time.Location) error {
	tiers := []struct {
		recordType string
		duration   time.Duration
	}{
		{"10m", 10 * time.Minute},
		{"20m", 20 * time.Minute},
		{"120m", 120 * time.Minute},
		{"480m", 480 * time.Minute},
	}
	systems, err := app.FindAllRecords("systems")
	if err != nil {
		return err
	}
	totals := gpuPowerMap{}
	for _, sys := range systems {
		coveredFrom := time.Now()
		for _, tier := range tiers {
			records, err := app.FindRecordsByFilter("system_stats", "system = {:system} && type = {:type}", "created", 0, 0,
				dbx.Params{"system": sys.Id, "type": tier.recordType})
			if err != nil {
				return err
			}
			earliest := coveredFrom
			for _, rec := range records {
				end := rec.GetDateTime("created").Time()
				start := end.Add(-tier.duration)
				if !start.Before(coveredFrom) {
					continue
				}
				if end.After(coveredFrom) {
					end = coveredFrom
				}
				var stats struct {
					GPUData map[string]system.GPUData `json:"g"`
				}
				if err := rec.UnmarshalJSONField("stats", &stats); err != nil || len(stats.GPUData) == 0 {
					continue
				}
				totals.addInterval(sys.Id, start, end, loc, stats.GPUData)
				if start.Before(earliest) {
					earliest = start
				}
			}
			coveredFrom = earliest
		}
	}
	return upsertGpuPowerDaily(app, totals, true)
}
