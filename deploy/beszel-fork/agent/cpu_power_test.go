//go:build testing

package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeRaplDomain(t *testing.T, dir, name string, energy, maxRange uint64) {
	t.Helper()
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "name"), []byte(name+"\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "energy_uj"), []byte(strconv.FormatUint(energy, 10)+"\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "max_energy_range_uj"), []byte(strconv.FormatUint(maxRange, 10)+"\n"), 0o644))
}

func setRaplEnergy(t *testing.T, dir string, energy uint64) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "energy_uj"), []byte(strconv.FormatUint(energy, 10)), 0o644))
}

// fakeClock returns a reader clock that advances only when told to.
func fakeClock(r *cpuPowerReader) func(time.Duration) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }
	return func(d time.Duration) { now = now.Add(d) }
}

func TestFindRaplPackagesOnlyPackages(t *testing.T) {
	// /sys/devices/virtual/powercap layout, as bind-mounted into the container
	root := t.TempDir()
	writeRaplDomain(t, filepath.Join(root, "intel-rapl", "intel-rapl:0"), "package-0", 1, 100)
	writeRaplDomain(t, filepath.Join(root, "intel-rapl", "intel-rapl:0", "intel-rapl:0:0"), "core", 1, 100)
	writeRaplDomain(t, filepath.Join(root, "intel-rapl", "intel-rapl:1"), "package-1", 1, 100)
	writeRaplDomain(t, filepath.Join(root, "intel-rapl", "intel-rapl:2"), "psys", 1, 100)

	domains := findRaplPackages(root)
	names := []string{}
	for _, d := range domains {
		names = append(names, d.name)
	}
	assert.ElementsMatch(t, []string{"package-0", "package-1"}, names)
}

func TestFindRaplPackagesClassLayoutAndUnreadable(t *testing.T) {
	// /sys/class/powercap layout: intel-rapl:N directly under the root
	root := t.TempDir()
	writeRaplDomain(t, filepath.Join(root, "intel-rapl:0"), "package-0", 1, 100)
	assert.Len(t, findRaplPackages(root), 1)

	// root-only counter (what a non-root agent sees): skipped
	require.NoError(t, os.Remove(filepath.Join(root, "intel-rapl:0", "energy_uj")))
	assert.Empty(t, findRaplPackages(root))
	assert.Empty(t, findRaplPackages(filepath.Join(root, "missing")))
}

func TestCpuPowerReadPerIntervalAndWrap(t *testing.T) {
	root := t.TempDir()
	pkg0 := filepath.Join(root, "intel-rapl", "intel-rapl:0")
	pkg1 := filepath.Join(root, "intel-rapl", "intel-rapl:1")
	writeRaplDomain(t, pkg0, "package-0", 1_000_000, 10_000_000)
	writeRaplDomain(t, pkg1, "package-1", 0, 10_000_000)
	t.Setenv("RAPL_PATH", root)
	r := newCpuPowerReader()
	require.NotNil(t, r)
	advance := fakeClock(r)

	_, ok := r.read(60000) // baseline
	assert.False(t, ok)
	_, ok = r.read(1000) // other interval keeps its own baseline
	assert.False(t, ok)

	// 2s later: package-0 used 6 J, package-1 4 J
	advance(2 * time.Second)
	setRaplEnergy(t, pkg0, 7_000_000)
	setRaplEnergy(t, pkg1, 4_000_000)
	watts, ok := r.read(60000)
	require.True(t, ok)
	assert.InDelta(t, 5.0, watts, 1e-9) // 10 J / 2 s

	// counter wrap: 7 J -> range end (10 J) -> 1 J = 4 J over 1 s
	advance(time.Second)
	setRaplEnergy(t, pkg0, 1_000_000)
	setRaplEnergy(t, pkg1, 4_000_000)
	watts, ok = r.read(60000)
	require.True(t, ok)
	assert.InDelta(t, 4.0, watts, 1e-9)

	// the 1000ms interval measures from its own baseline 3 s ago: package-0
	// is back at 1 J (a full wrap is invisible), package-1 used 4 J
	watts, ok = r.read(1000)
	require.True(t, ok)
	assert.InDelta(t, 4.0/3, watts, 1e-9)
}

func TestCpuPowerRejectsBadCounters(t *testing.T) {
	root := t.TempDir()
	pkg := filepath.Join(root, "intel-rapl:0")
	writeRaplDomain(t, pkg, "package-0", 5_000_000, 0) // no max range: a decrease can't be a wrap
	t.Setenv("RAPL_PATH", root)
	r := newCpuPowerReader()
	require.NotNil(t, r)
	advance := fakeClock(r)
	r.read(60000)

	advance(time.Second)
	setRaplEnergy(t, pkg, 1_000_000)
	_, ok := r.read(60000)
	assert.False(t, ok, "decrease without a known range")

	advance(time.Second)
	setRaplEnergy(t, pkg, 1_000_000+5_000_000_000) // 5000 J in 1 s
	_, ok = r.read(60000)
	assert.False(t, ok, "implausible power")

	advance(0)
	_, ok = r.read(60000)
	assert.False(t, ok, "no elapsed time")
}

// fakeMsr serves MSR reads from a map keyed by cpu and register.
type fakeMsr struct {
	regs map[[2]uint64]uint64
	fail bool
}

func (f *fakeMsr) read(cpu int, reg uint32) (uint64, error) {
	if f.fail {
		return 0, os.ErrPermission
	}
	v, ok := f.regs[[2]uint64{uint64(cpu), uint64(reg)}]
	if !ok {
		return 0, os.ErrNotExist
	}
	return v, nil
}

func (f *fakeMsr) set(cpu int, reg uint32, v uint64) { f.regs[[2]uint64{uint64(cpu), uint64(reg)}] = v }

// writeTopology fakes /sys/devices/system/cpu: one entry per cpu -> package.
func writeTopology(t *testing.T, packages map[int]int) string {
	t.Helper()
	root := t.TempDir()
	for cpu, pkg := range packages {
		dir := filepath.Join(root, "cpu"+strconv.Itoa(cpu), "topology")
		require.NoError(t, os.MkdirAll(dir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "physical_package_id"), []byte(strconv.Itoa(pkg)+"\n"), 0o644))
	}
	return root
}

// two sockets with cpus 0-1 on package 0 and 2-3 on package 1; ESU 14 (the
// usual 61 microjoule unit) on both
func twoSocketMsr(t *testing.T) (*fakeMsr, msrSource) {
	f := &fakeMsr{regs: map[[2]uint64]uint64{}}
	for _, cpu := range []int{0, 2} {
		f.set(cpu, msrRaplPowerUnit, 0xa0e03) // bits 12:8 = 0x0e = 14
		f.set(cpu, msrPkgEnergyStatus, 0)
	}
	return f, msrSource{
		read:       f.read,
		sysCPUDir:  writeTopology(t, map[int]int{0: 0, 1: 0, 2: 1, 3: 1}),
		cpuInfo:    filepath.Join(t.TempDir(), "missing"),
		configured: true,
	}
}

func TestCpuPackagesTopology(t *testing.T) {
	root := writeTopology(t, map[int]int{0: 0, 1: 0, 2: 1, 3: 1, 10: 1})
	assert.Equal(t, map[int]int{0: 0, 1: 2}, cpuPackages(root, "/nonexistent"))
}

func TestCpuPackagesFromCpuinfoAndCpu0Fallback(t *testing.T) {
	info := filepath.Join(t.TempDir(), "cpuinfo")
	require.NoError(t, os.WriteFile(info, []byte(
		"processor\t: 0\nmodel name\t: x\nphysical id\t: 0\n\n"+
			"processor\t: 1\nphysical id\t: 1\n\n"+
			"processor\t: 2\nphysical id\t: 0\n"), 0o644))
	assert.Equal(t, map[int]int{0: 0, 1: 1}, cpuPackages("/nonexistent", info))
	assert.Equal(t, map[int]int{0: 0}, cpuPackages("/nonexistent", "/nonexistent"))
}

func TestCpuPowerMsrSumsSocketsWithUnitsAndWrap(t *testing.T) {
	f, src := twoSocketMsr(t)
	r := newCpuPowerReaderFrom([]string{filepath.Join(t.TempDir(), "no-powercap")}, src)
	require.NotNil(t, r)
	require.Len(t, r.domains, 2)
	advance := fakeClock(r)

	_, ok := r.read(60000) // baseline
	assert.False(t, ok)

	// 2 s later each socket used 2^14 units = 1 J (the upper register bits
	// above the 32-bit counter are ignored)
	advance(2 * time.Second)
	f.set(0, msrPkgEnergyStatus, 1<<14|0xabcd<<32)
	f.set(2, msrPkgEnergyStatus, 1<<14)
	watts, ok := r.read(60000)
	require.True(t, ok)
	assert.InDelta(t, 1.0, watts, 1e-9) // 2 J / 2 s

	// socket 0 wraps its 32-bit counter: 2^32-2^14 -> 2^14 is 2 J; socket 1
	// is unchanged. Over 1 s that is 2 W
	f.set(0, msrPkgEnergyStatus, 0xffffffff-(1<<14)+1)
	advance(time.Second)
	_, _ = r.read(60000)
	f.set(0, msrPkgEnergyStatus, 1<<14)
	advance(time.Second)
	watts, ok = r.read(60000)
	require.True(t, ok)
	assert.InDelta(t, 2.0, watts, 1e-9)
}

func TestCpuPowerMsrEnergyUnitFromRegister(t *testing.T) {
	f, src := twoSocketMsr(t)
	f.set(0, msrRaplPowerUnit, 0xa1003) // ESU 16: 2^-16 J per unit
	r := newCpuPowerReaderFrom(nil, src)
	require.NotNil(t, r)
	advance := fakeClock(r)
	r.read(60000)
	advance(time.Second)
	f.set(0, msrPkgEnergyStatus, 1<<16)
	watts, ok := r.read(60000)
	require.True(t, ok)
	assert.InDelta(t, 1.0, watts, 1e-9)
}

func TestCpuPowerPowercapPreferredOverMsr(t *testing.T) {
	_, src := twoSocketMsr(t)
	root := t.TempDir()
	writeRaplDomain(t, filepath.Join(root, "intel-rapl:0"), "package-0", 1, 100)
	r := newCpuPowerReaderFrom([]string{root}, src)
	require.NotNil(t, r)
	require.Len(t, r.domains, 1)
	assert.Equal(t, "package-0", r.domains[0].name)
}

func TestCpuPowerMsrUnavailable(t *testing.T) {
	// unreadable registers (no /dev/cpu, no permission): no reader at all
	_, src := twoSocketMsr(t)
	src.read = (&fakeMsr{fail: true}).read
	assert.Nil(t, newCpuPowerReaderFrom(nil, src))
	assert.Nil(t, newCpuPowerReaderFrom(nil, msrSource{}))

	// one socket unreadable: no partial sum
	f, src := twoSocketMsr(t)
	delete(f.regs, [2]uint64{2, msrPkgEnergyStatus})
	assert.Nil(t, newCpuPowerReaderFrom(nil, src))
}

func TestCpuPowerMsrReadFailsLaterDegradesQuietly(t *testing.T) {
	f, src := twoSocketMsr(t)
	r := newCpuPowerReaderFrom(nil, src)
	require.NotNil(t, r)
	fakeClock(r)
	f.fail = true
	for i := 0; i < 3; i++ {
		_, ok := r.read(60000)
		assert.False(t, ok)
	}
	assert.True(t, r.warned)
}

func TestReadMsrDev(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "0"), 0o755))
	buf := make([]byte, msrPkgEnergyStatus+8)
	copy(buf[msrPkgEnergyStatus:], []byte{0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0})
	require.NoError(t, os.WriteFile(filepath.Join(dir, "0", "msr"), buf, 0o644))
	v, err := readMsrDev(dir)(0, msrPkgEnergyStatus)
	require.NoError(t, err)
	assert.Equal(t, uint64(0x12345678), v)
	_, err = readMsrDev(dir)(5, msrPkgEnergyStatus)
	assert.Error(t, err)
}
