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
