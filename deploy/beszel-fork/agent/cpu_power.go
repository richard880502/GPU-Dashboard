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
//
// MSR fallback: some CPUs are newer than the kernel's intel_rapl driver (e.g.
// Xeon 6 on RHEL 9.2: "driver does not support CPU family 6 model 173"), so
// no powercap directory exists although the hardware counter does. Without
// powercap the agent then reads MSR_PKG_ENERGY_STATUS (0x611) itself from
// /dev/cpu/N/msr, one CPU per physical package, and sums the packages. The
// counter is 32 bits wide in units of 2^-ESU joules, ESU being bits 12:8 of
// MSR_RAPL_POWER_UNIT (0x606). It needs the host's msr module (modprobe msr),
// the /dev/cpu directory passed into the container, and CAP_SYS_RAWIO:
//
//	--device /dev/cpu:/dev/cpu --cap-add SYS_RAWIO

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/henrygd/beszel/agent/utils"
)

var defaultRaplRoots = []string{"/host/powercap", "/sys/class/powercap"}

const (
	msrRaplPowerUnit   = 0x606
	msrPkgEnergyStatus = 0x611
	defaultMsrDir      = "/dev/cpu"
	defaultSysCPUDir   = "/sys/devices/system/cpu"
	defaultCPUInfoPath = "/proc/cpuinfo"
)

// raplDomain is one package's monotonically increasing energy counter.
// readEnergy returns it in counter units, unit is joules per unit, and
// maxRange is the value after which the counter wraps (0 if unknown).
type raplDomain struct {
	name       string
	readEnergy func() (uint64, error)
	unit       float64
	maxRange   uint64
}

// msrSource reads model-specific registers, and finds the CPUs to read them
// from. Fields are injectable for tests.
type msrSource struct {
	read       func(cpu int, reg uint32) (uint64, error)
	sysCPUDir  string
	cpuInfo    string
	configured bool // /dev/cpu exists, so a failure is worth a warning
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
	warned  bool // a failing read has been logged
}

// newCpuPowerReader returns nil when neither a readable RAPL package domain
// nor the MSR fallback is available.
func newCpuPowerReader() *cpuPowerReader {
	roots := defaultRaplRoots
	if path, ok := utils.GetEnv("RAPL_PATH"); ok && path != "" {
		roots = []string{path}
	}
	return newCpuPowerReaderFrom(roots, defaultMsrSource())
}

func newCpuPowerReaderFrom(roots []string, msr msrSource) *cpuPowerReader {
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
	if domains := findMsrPackages(msr); len(domains) > 0 {
		names := make([]string, len(domains))
		for i, d := range domains {
			names[i] = d.name
		}
		slog.Info("CPU power from MSR (no powercap)", "packages", names)
		return &cpuPowerReader{domains: domains, last: map[uint16]raplSample{}, now: time.Now}
	}
	slog.Debug("CPU power not available (no readable RAPL package domain or MSR)")
	return nil
}

func defaultMsrSource() msrSource {
	_, err := os.Stat(defaultMsrDir)
	return msrSource{
		read:       readMsrDev(defaultMsrDir),
		sysCPUDir:  defaultSysCPUDir,
		cpuInfo:    defaultCPUInfoPath,
		configured: err == nil,
	}
}

// readMsrDev reads 8 bytes at offset reg of dir/N/msr (the msr module's
// interface: the file offset is the register number).
func readMsrDev(dir string) func(int, uint32) (uint64, error) {
	return func(cpu int, reg uint32) (uint64, error) {
		f, err := os.Open(filepath.Join(dir, strconv.Itoa(cpu), "msr"))
		if err != nil {
			return 0, err
		}
		defer f.Close()
		var buf [8]byte
		if _, err := f.ReadAt(buf[:], int64(reg)); err != nil {
			return 0, err
		}
		return binary.LittleEndian.Uint64(buf[:]), nil
	}
}

// findMsrPackages returns one domain per physical package, read through the
// lowest-numbered CPU of that package. All packages must be readable: a sum
// over only some of them would silently under-report.
func findMsrPackages(src msrSource) []raplDomain {
	if src.read == nil {
		return nil
	}
	sockets := cpuPackages(src.sysCPUDir, src.cpuInfo)
	ids := make([]int, 0, len(sockets))
	for id := range sockets {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	domains := make([]raplDomain, 0, len(ids))
	for _, id := range ids {
		cpu := sockets[id]
		units, err := src.read(cpu, msrRaplPowerUnit)
		if err == nil {
			_, err = src.read(cpu, msrPkgEnergyStatus)
		}
		if err != nil {
			if src.configured {
				slog.Warn("CPU power MSR not readable (needs `modprobe msr`, SYS_RAWIO and --device /dev/cpu)", "cpu", cpu, "err", err)
			}
			return nil
		}
		esu := (units >> 8) & 0x1f
		domains = append(domains, raplDomain{
			name: fmt.Sprintf("package-%d(cpu%d)", id, cpu),
			readEnergy: func() (uint64, error) {
				v, err := src.read(cpu, msrPkgEnergyStatus)
				return v & 0xffffffff, err
			},
			unit:     1 / float64(uint64(1)<<esu),
			maxRange: 1 << 32,
		})
	}
	return domains
}

// cpuPackages maps each physical package id to its lowest online CPU number,
// from sysfs topology, else /proc/cpuinfo, else just cpu0.
func cpuPackages(sysCPUDir, cpuInfo string) map[int]int {
	pkgs := map[int]int{}
	add := func(pkg, cpu int) {
		if pkg < 0 {
			return
		}
		if cur, ok := pkgs[pkg]; !ok || cpu < cur {
			pkgs[pkg] = cpu
		}
	}
	matches, _ := filepath.Glob(filepath.Join(sysCPUDir, "cpu[0-9]*", "topology", "physical_package_id"))
	for _, m := range matches {
		cpu, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(filepath.Dir(filepath.Dir(m))), "cpu"))
		pkg, err2 := strconv.Atoi(raplReadString(m))
		if err == nil && err2 == nil {
			add(pkg, cpu)
		}
	}
	if len(pkgs) > 0 {
		return pkgs
	}
	// /proc/cpuinfo blocks: "processor : N" ... "physical id : M"
	if b, err := os.ReadFile(cpuInfo); err == nil {
		cpu := -1
		for _, line := range strings.Split(string(b), "\n") {
			key, val, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			val = strings.TrimSpace(val)
			switch strings.TrimSpace(key) {
			case "processor":
				if n, err := strconv.Atoi(val); err == nil {
					cpu = n
				}
			case "physical id":
				if n, err := strconv.Atoi(val); err == nil && cpu >= 0 {
					add(n, cpu)
				}
			}
		}
	}
	if len(pkgs) == 0 {
		slog.Debug("CPU topology unknown, reading MSR of cpu0 only")
		pkgs[0] = 0
	}
	return pkgs
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
		domains = append(domains, raplDomain{
			name:       name,
			readEnergy: func() (uint64, error) { return raplReadUint(energyPath) },
			unit:       1e-6, // energy_uj is in microjoules
			maxRange:   maxRange,
		})
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
		v, err := d.readEnergy()
		if err != nil {
			if !r.warned {
				r.warned = true
				slog.Warn("CPU power counter not readable, no CPU power reported", "domain", d.name, "err", err)
			}
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
	var joules float64
	for i, d := range r.domains {
		delta := cur.energy[i] - prev.energy[i]
		if cur.energy[i] < prev.energy[i] {
			if d.maxRange == 0 || prev.energy[i] > d.maxRange {
				return 0, false
			}
			delta = d.maxRange - prev.energy[i] + cur.energy[i] // counter wrapped
		}
		joules += float64(delta) * d.unit
	}
	watts := joules / seconds
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
