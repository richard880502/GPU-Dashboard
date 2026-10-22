package agent

// gpu-monitoring fork addition (not upstream): CPU package power from the
// Linux powercap RAPL energy counters (Intel, and AMD Zen via the same
// driver).
//
// Each package domain exposes a monotonically increasing energy_uj counter
// that wraps at max_energy_range_uj; power is the energy used since the
// previous reading of the same stats interval divided by the elapsed time.
// Only top-level "package-N" domains are summed: their subdomains (core,
// uncore, dram) are parts of the package, and "psys" overlaps with it.
//
// The counters are root-only, and Docker masks /sys/devices/virtual/powercap
// inside containers, so the containerized agent needs the host directory
// bind-mounted, by default at /host/powercap:
//
//	-v /sys/devices/virtual/powercap:/host/powercap:ro
//
// RAPL_PATH overrides where to look.

import (
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/henrygd/beszel/agent/utils"
)

var defaultRaplRoots = []string{"/host/powercap", "/sys/class/powercap"}

type raplDomain struct {
	name       string
	energyPath string
	maxRange   uint64
}

type raplSample struct {
	at     time.Time
	energy []uint64
}

type cpuPowerReader struct {
	mu      sync.Mutex
	domains []raplDomain
	last    map[uint16]raplSample // per stats interval (cacheTimeMs)
	now     func() time.Time
}

// newCpuPowerReader returns nil when no readable RAPL package domain exists.
func newCpuPowerReader() *cpuPowerReader {
	roots := defaultRaplRoots
	if path, ok := utils.GetEnv("RAPL_PATH"); ok && path != "" {
		roots = []string{path}
	}
	for _, root := range roots {
		if domains := findRaplPackages(root); len(domains) > 0 {
			names := make([]string, len(domains))
			for i, d := range domains {
				names[i] = d.name
			}
			slog.Info("CPU power from RAPL", "path", root, "domains", names)
			return &cpuPowerReader{domains: domains, last: map[uint16]raplSample{}, now: time.Now}
		}
	}
	slog.Debug("CPU power not available (no readable RAPL package domain)")
	return nil
}

// findRaplPackages lists readable top-level package domains under root, which
// may be either /sys/class/powercap (intel-rapl:N links) or the
// /sys/devices/virtual/powercap directory (intel-rapl/intel-rapl:N).
func findRaplPackages(root string) []raplDomain {
	var dirs []string
	for _, pattern := range []string{"intel-rapl:*", "intel-rapl/intel-rapl:*"} {
		matches, _ := filepath.Glob(filepath.Join(root, pattern))
		dirs = append(dirs, matches...)
	}
	seen := map[string]bool{}
	var domains []raplDomain
	for _, dir := range dirs {
		base := filepath.Base(dir)
		// intel-rapl:0 is a package, intel-rapl:0:0 one of its subdomains
		if strings.Count(base, ":") != 1 || seen[base] {
			continue
		}
		name := raplReadString(filepath.Join(dir, "name"))
		if !strings.HasPrefix(name, "package") {
			continue
		}
		energyPath := filepath.Join(dir, "energy_uj")
		if _, err := raplReadUint(energyPath); err != nil {
			continue
		}
		maxRange, _ := raplReadUint(filepath.Join(dir, "max_energy_range_uj"))
		seen[base] = true
		domains = append(domains, raplDomain{name: name, energyPath: energyPath, maxRange: maxRange})
	}
	return domains
}

// read returns the average CPU package power in watts since the previous call
// for the same interval. The first call per interval only records a baseline.
func (r *cpuPowerReader) read(cacheTimeMs uint16) (float64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur := raplSample{at: r.now(), energy: make([]uint64, len(r.domains))}
	for i, d := range r.domains {
		v, err := raplReadUint(d.energyPath)
		if err != nil {
			return 0, false
		}
		cur.energy[i] = v
	}
	prev, ok := r.last[cacheTimeMs]
	r.last[cacheTimeMs] = cur
	if !ok {
		return 0, false
	}
	seconds := cur.at.Sub(prev.at).Seconds()
	if seconds <= 0 {
		return 0, false
	}
	var microjoules float64
	for i, d := range r.domains {
		delta := cur.energy[i] - prev.energy[i]
		if cur.energy[i] < prev.energy[i] {
			if d.maxRange == 0 || prev.energy[i] > d.maxRange {
				return 0, false
			}
			delta = d.maxRange - prev.energy[i] + cur.energy[i] // counter wrapped
		}
		microjoules += float64(delta)
	}
	watts := microjoules / 1e6 / seconds
	// a reading far beyond any desktop/server CPU means a bad counter, not power
	if watts < 0 || watts > 2000 {
		return 0, false
	}
	return watts, true
}

func raplReadString(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func raplReadUint(path string) (uint64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
}
