package agent

// gpu-monitoring fork addition (not upstream): attributes GPU usage to the
// Docker container each GPU process belongs to, and merges it directly onto
// Beszel's existing per-container stats (agent/docker.go), so the stock
// Containers page shows at a glance which containers are using which GPU
// and how much -- no separate process-level page needed.
//
// Deliberately does NOT re-derive PID -> container mapping from
// /proc/<pid>/cgroup + the Docker socket in Go here -- this project already
// has that logic running, tested, and verified correct in production as
// gpu-process-exporter (:5052), and per-process GPU memory/utilization is
// already exposed by nvitop-exporter (:5051). Both already run on every GPU
// host this agent runs on, so just read their Prometheus text output.

import (
	"bufio"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/henrygd/beszel/internal/entities/container"
	"github.com/henrygd/beszel/internal/entities/system"
)

var promLabelRegex = regexp.MustCompile(`(\w+)="([^"]*)"`)

var promHTTPClient = &http.Client{Timeout: 5 * time.Second}

// containerGPUStats accumulates GPU usage for one container, summed across
// every GPU-using PID that belongs to it (usually just one, but a single
// process can also legitimately show up on more than one GPU -- e.g. a
// multi-GPU job holding the same PID on each device it uses).
type containerGPUStats struct {
	pids       []string
	pidSeen    map[string]struct{}
	indices    map[string]struct{}
	memMiB     float64
	memPercent float64
	utilPct    float64
}

// collectContainerGPUStats joins gpu-process-exporter's (PID,GPU index)->container
// map with nvitop-exporter's per-process GPU memory/utilization, and returns
// the result grouped by container name.
func collectContainerGPUStats() map[string]*containerGPUStats {
	containerByPID := fetchContainerByPID("http://127.0.0.1:5052/metrics")
	if containerByPID == nil {
		return nil // gpu-process-exporter not reachable; don't report partial/stale data
	}
	usageByPID, memTotalByIndex := fetchNvitopData("http://127.0.0.1:5051/metrics")

	result := make(map[string]*containerGPUStats)
	for key, pc := range containerByPID {
		stats, ok := result[pc.container]
		if !ok {
			stats = &containerGPUStats{indices: make(map[string]struct{}), pidSeen: make(map[string]struct{})}
			result[pc.container] = stats
		}
		if _, seen := stats.pidSeen[key.pid]; !seen {
			stats.pidSeen[key.pid] = struct{}{}
			stats.pids = append(stats.pids, key.pid)
		}
		if key.index != "" {
			stats.indices[key.index] = struct{}{}
		}
		if u, ok := usageByPID[key]; ok {
			stats.memMiB += u.memMiB
			stats.utilPct += u.utilPct
			// process_gpu_memory_utilization_Percentage (NVML's per-process
			// memory-bandwidth sample) is NOT "% of GPU memory used" -- it's
			// usually ~0 even for a process holding most of the GPU's memory.
			// Compute the real occupancy percentage ourselves instead.
			if total, ok := memTotalByIndex[key.index]; ok && total > 0 {
				stats.memPercent += u.memMiB / total * 100
			}
		}
	}
	return result
}

// applyContainerGPUStats merges the collected GPU stats onto Beszel's own
// per-container stats slice, matched by container name.
func applyContainerGPUStats(containers []*container.Stats) {
	gpuStats := collectContainerGPUStats()
	if gpuStats == nil {
		return
	}
	for _, c := range containers {
		stats, ok := gpuStats[c.Name]
		if !ok {
			continue
		}
		c.GpuPid = strings.Join(stats.pids, ",")
		c.GpuMemMiB = stats.memMiB
		c.GpuMemPercent = stats.memPercent
		c.GpuUtilPercent = stats.utilPct

		indices := make([]string, 0, len(stats.indices))
		for idx := range stats.indices {
			indices = append(indices, idx)
		}
		sort.Strings(indices)
		c.GpuIndex = strings.Join(indices, ",")
	}
}

// attachGPUProcesses fills in each GPU's Processes list (PID, container name
// -- "host" if not containerized -- memory, and utilization), so the UI can
// show what's actually running on a specific GPU when drilled into, not
// just an aggregate per-container view.
func attachGPUProcesses(gpuData map[string]system.GPUData) {
	containerByPID := fetchContainerByPID("http://127.0.0.1:5052/metrics")
	if containerByPID == nil {
		return // gpu-process-exporter not reachable; don't report partial/stale data
	}
	usageByPID, memTotalByIndex := fetchNvitopData("http://127.0.0.1:5051/metrics")

	byIndex := make(map[string][]system.GPUProcess)
	for key, pc := range containerByPID {
		u := usageByPID[key]
		memPercent := 0.0
		if total, ok := memTotalByIndex[key.index]; ok && total > 0 {
			memPercent = u.memMiB / total * 100
		}
		byIndex[key.index] = append(byIndex[key.index], system.GPUProcess{
			PID:           key.pid,
			Container:     pc.container,
			MemoryMiB:     u.memMiB,
			UtilPercent:   u.utilPct,
			MemoryPercent: memPercent,
			Username:      pc.username,
		})
	}
	for index, procs := range byIndex {
		entry, ok := gpuData[index]
		if !ok {
			continue
		}
		entry.Processes = procs
		gpuData[index] = entry
	}
}

// pidIndex identifies one process's usage of one specific GPU. A PID alone
// isn't unique here -- a multi-GPU job holds the same PID on every device it
// uses, each reported as its own line in both exporters' metrics -- so every
// map keyed by "just the PID" below was silently collapsing those onto
// whichever GPU's line happened to be read last, dropping the process from
// its other GPU(s) entirely.
type pidIndex struct {
	pid   string
	index string
}

type pidContainer struct {
	container string
	username  string
}

// fetchContainerByPID parses gpu_process_container_info{...,index="0",pid="123",...,container_name="foo"} 1
func fetchContainerByPID(url string) map[pidIndex]pidContainer {
	resp, err := promHTTPClient.Get(url)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return nil
	}
	defer resp.Body.Close()

	result := make(map[pidIndex]pidContainer)
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "gpu_process_container_info{") {
			continue
		}
		labels := promLabels(line)
		if labels == nil || labels["pid"] == "" || labels["container_name"] == "" {
			continue
		}
		result[pidIndex{pid: labels["pid"], index: labels["index"]}] = pidContainer{
			container: labels["container_name"],
			username:  labels["username"],
		}
	}
	return result
}

type processGPUUsage struct {
	memMiB  float64
	utilPct float64
}

// fetchNvitopData does a single GET+scan of nvitop-exporter's metrics and
// extracts both the per-process gauges and the per-GPU memory totals in one
// pass. Both collectContainerGPUStats and attachGPUProcesses need this data
// every collection tick; nvitop-exporter's /metrics is expensive to
// regenerate (it walks live process handles), and firing multiple
// concurrent scrapes at it from the same tick was pushing some of them past
// promHTTPClient's timeout on busier, multi-process hosts -- silently
// dropping just the second/third fetch's data (e.g. VRAM % came back empty
// while memory/PID from the first fetch succeeded).
//
//	process_gpu_memory_MiB{...,pid="123",...} 1868.0
//	process_gpu_sm_utilization_Percentage{...,pid="123",...} 17.0
//	gpu_memory_total_MiB{...,index="0",...} 24564.0
func fetchNvitopData(url string) (usageByPID map[pidIndex]processGPUUsage, memTotalByIndex map[string]float64) {
	usageByPID = make(map[pidIndex]processGPUUsage)
	memTotalByIndex = make(map[string]float64)

	resp, err := promHTTPClient.Get(url)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return usageByPID, memTotalByIndex
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		spaceIdx := strings.LastIndexByte(line, ' ')
		if spaceIdx < 0 {
			continue
		}

		switch {
		case strings.HasPrefix(line, "process_gpu_memory_MiB{"):
			labels := promLabels(line)
			if labels == nil || labels["pid"] == "" {
				continue
			}
			key := pidIndex{pid: labels["pid"], index: labels["index"]}
			if v, err := strconv.ParseFloat(line[spaceIdx+1:], 64); err == nil {
				u := usageByPID[key]
				u.memMiB = v
				usageByPID[key] = u
			}
		case strings.HasPrefix(line, "process_gpu_sm_utilization_Percentage{"):
			labels := promLabels(line)
			if labels == nil || labels["pid"] == "" {
				continue
			}
			key := pidIndex{pid: labels["pid"], index: labels["index"]}
			if v, err := strconv.ParseFloat(line[spaceIdx+1:], 64); err == nil {
				u := usageByPID[key]
				u.utilPct = v
				usageByPID[key] = u
			}
		case strings.HasPrefix(line, "gpu_memory_total_MiB{"):
			labels := promLabels(line)
			if labels == nil || labels["index"] == "" {
				continue
			}
			if v, err := strconv.ParseFloat(line[spaceIdx+1:], 64); err == nil {
				memTotalByIndex[labels["index"]] = v
			}
		}
	}
	return usageByPID, memTotalByIndex
}

// promLabels extracts the label set from one Prometheus text-exposition
// line, e.g. `metric_name{a="1",b="2"} 3.4` -> {"a":"1", "b":"2"}.
func promLabels(line string) map[string]string {
	start := strings.IndexByte(line, '{')
	end := strings.IndexByte(line, '}')
	if start < 0 || end < 0 || end < start {
		return nil
	}
	labels := make(map[string]string)
	for _, m := range promLabelRegex.FindAllStringSubmatch(line[start:end], -1) {
		labels[m[1]] = m[2]
	}
	return labels
}
