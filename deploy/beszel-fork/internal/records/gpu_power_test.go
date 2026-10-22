//go:build testing

package records_test

import (
	"testing"
	"time"

	"github.com/henrygd/beszel/internal/entities/system"
	"github.com/henrygd/beszel/internal/records"
	"github.com/henrygd/beszel/internal/tests"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func gpuPowerTestSystem(t *testing.T) (*tests.TestHub, *core.Record) {
	t.Helper()
	hub, err := tests.NewTestHub(t.TempDir())
	require.NoError(t, err)
	t.Cleanup(hub.Cleanup)
	user, err := tests.CreateUser(hub, "gpupower@example.com", "testtesttest")
	require.NoError(t, err)
	sys, err := tests.CreateRecord(hub, "systems", map[string]any{
		"name": "gpu-node", "host": "localhost", "port": "45876", "status": "up", "users": []string{user.Id},
	})
	require.NoError(t, err)
	return hub, sys
}

func gpuPowerRows(t *testing.T, hub *tests.TestHub, systemID string) map[string]*core.Record {
	t.Helper()
	recs, err := hub.FindAllRecords(records.GpuPowerCollection, dbx.HashExp{"system": systemID})
	require.NoError(t, err)
	rows := map[string]*core.Record{}
	for _, r := range recs {
		rows[r.GetString("gpu")+"@"+r.GetString("day")] = r
	}
	return rows
}

func gpus(power, usage float64) map[string]system.GPUData {
	return map[string]system.GPUData{"0": {Name: "RTX 4090", Power: power, Usage: usage}}
}

func TestGpuPowerAccumulatesAcrossFlushes(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	loc := time.UTC
	acc := records.NewGpuPowerAccumulator(hub, loc)
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, loc)

	acc.Add(sys.Id, t0, gpus(100, 0))                       // first poll only sets the start
	acc.Add(sys.Id, t0.Add(5*time.Second), gpus(200, 50))   // 5s at 200W, 50%
	acc.Add(sys.Id, t0.Add(10*time.Second), gpus(300, 100)) // 5s at 300W, 100%
	require.NoError(t, acc.Flush())

	acc.Add(sys.Id, t0.Add(16*time.Second), gpus(360, 0)) // 6s at 360W
	require.NoError(t, acc.Flush())
	require.NoError(t, acc.Flush()) // nothing pending: no change

	rows := gpuPowerRows(t, hub, sys.Id)
	require.Len(t, rows, 1)
	row := rows["0@2026-10-01"]
	require.NotNil(t, row)
	assert.InDelta(t, (200*5+300*5+360*6)/3600.0, row.GetFloat("energy_wh"), 1e-9)
	assert.InDelta(t, 16, row.GetFloat("seconds"), 1e-9)
	assert.InDelta(t, 2.5+5, row.GetFloat("busy_seconds"), 1e-9)
	assert.Equal(t, 360.0, row.GetFloat("max_w"))
	assert.Equal(t, "gpu-node", row.GetString("system_name"))
	assert.Equal(t, "RTX 4090", row.GetString("name"))
	assert.False(t, row.GetBool("estimated"))
}

func TestGpuPowerSkipsGapsAndOldSamples(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	acc := records.NewGpuPowerAccumulator(hub, time.UTC)
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

	acc.Add(sys.Id, t0, gpus(100, 0))
	acc.Add(sys.Id, t0.Add(10*time.Minute), gpus(100, 0))                // agent was down: not counted
	acc.Add(sys.Id, t0.Add(10*time.Minute), gpus(999, 0))                // duplicate time: ignored
	acc.Add(sys.Id, t0.Add(5*time.Minute), gpus(999, 0))                 // out of order: ignored
	acc.Add(sys.Id, t0.Add(10*time.Minute+30*time.Second), gpus(100, 0)) // 30s counted
	require.NoError(t, acc.Flush())

	row := gpuPowerRows(t, hub, sys.Id)["0@2026-10-01"]
	require.NotNil(t, row)
	assert.InDelta(t, 30, row.GetFloat("seconds"), 1e-9)
	assert.InDelta(t, 100*30/3600.0, row.GetFloat("energy_wh"), 1e-9)
}

func TestGpuPowerSplitsAtLocalMidnight(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	taipei := time.FixedZone("UTC+8", 8*3600)
	acc := records.NewGpuPowerAccumulator(hub, taipei)
	// 23:59:58 -> 00:00:03 Taipei time: 2s on Oct 1, 3s on Oct 2
	t0 := time.Date(2026, 10, 1, 23, 59, 58, 0, taipei)
	acc.Add(sys.Id, t0, gpus(100, 0))
	acc.Add(sys.Id, t0.Add(5*time.Second), gpus(360, 0))
	require.NoError(t, acc.Flush())

	rows := gpuPowerRows(t, hub, sys.Id)
	require.Len(t, rows, 2)
	assert.InDelta(t, 2, rows["0@2026-10-01"].GetFloat("seconds"), 1e-9)
	assert.InDelta(t, 3, rows["0@2026-10-02"].GetFloat("seconds"), 1e-9)
	assert.InDelta(t, 360*3/3600.0, rows["0@2026-10-02"].GetFloat("energy_wh"), 1e-9)
}

func TestGpuPowerKeepsTotalsWhenSaveFails(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	acc := records.NewGpuPowerAccumulator(hub, time.UTC)
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	acc.Add(sys.Id, t0, gpus(100, 0))
	acc.Add(sys.Id, t0.Add(10*time.Second), gpus(100, 0))

	// make the save fail by dropping the collection, then bring it back
	collection, err := hub.FindCollectionByNameOrId(records.GpuPowerCollection)
	require.NoError(t, err)
	require.NoError(t, hub.Delete(collection))
	assert.Error(t, acc.Flush())
	collection.MarkAsNew()
	require.NoError(t, hub.Save(collection))

	require.NoError(t, acc.Flush())
	row := gpuPowerRows(t, hub, sys.Id)["0@2026-10-01"]
	require.NotNil(t, row)
	assert.InDelta(t, 10, row.GetFloat("seconds"), 1e-9)
}

func TestGpuPowerHookReadsStatsRecords(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	acc := records.NewGpuPowerAccumulator(hub, time.UTC)
	acc.BindHooks()

	collection, err := hub.FindCollectionByNameOrId("system_stats")
	require.NoError(t, err)
	save := func(recordType string, power float64) {
		rec := core.NewRecord(collection)
		rec.Set("system", sys.Id)
		rec.Set("type", recordType)
		// same shape the hub saves: the Stats struct, not a JSON string
		rec.Set("stats", system.Stats{GPUData: gpus(power, 40)})
		require.NoError(t, hub.SaveNoValidate(rec))
	}
	save("1m", 250)
	time.Sleep(1100 * time.Millisecond) // created has millisecond precision
	save("1m", 250)
	save("10m", 9999) // longer records are ignored
	require.NoError(t, acc.Flush())

	rows := gpuPowerRows(t, hub, sys.Id)
	require.Len(t, rows, 1)
	for _, row := range rows {
		assert.Greater(t, row.GetFloat("seconds"), 1.0)
		assert.Less(t, row.GetFloat("seconds"), 5.0)
		assert.InDelta(t, 250*row.GetFloat("seconds")/3600, row.GetFloat("energy_wh"), 1e-6)
		assert.Equal(t, 250.0, row.GetFloat("max_w"))
	}
}

func TestBackfillGpuPowerDaily(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	require.NoError(t, tests.ClearCollection(t, hub, records.GpuPowerCollection))
	now := time.Now().UTC()
	statsCollection, err := hub.FindCollectionByNameOrId("system_stats")
	require.NoError(t, err)
	create := func(recordType string, created time.Time, power float64) {
		rec := core.NewRecord(statsCollection)
		rec.Set("system", sys.Id)
		rec.Set("type", recordType)
		rec.Set("stats", map[string]any{"g": map[string]any{"0": map[string]any{"n": "RTX 4090", "p": power, "u": 50}}})
		// autodate keeps a manually set created only when set with SetRaw
		dt, err := types.ParseDateTime(created)
		require.NoError(t, err)
		rec.SetRaw("created", dt)
		require.NoError(t, hub.SaveNoValidate(rec))
	}
	// 120m records cover the last 4h; the 480m record overlaps them and only
	// its part before the earliest 120m record (4h..8h ago) may count.
	create("120m", now.Add(-2*time.Hour), 100)
	create("120m", now, 100)
	create("480m", now, 400)

	require.NoError(t, records.BackfillGpuPowerDaily(hub, time.UTC))

	recs, err := hub.FindAllRecords(records.GpuPowerCollection, dbx.HashExp{"system": sys.Id})
	require.NoError(t, err)
	var energy, seconds float64
	for _, r := range recs {
		assert.True(t, r.GetBool("estimated"))
		energy += r.GetFloat("energy_wh")
		seconds += r.GetFloat("seconds")
	}
	assert.InDelta(t, 8*3600, seconds, 1)
	assert.InDelta(t, 100*4+400*4, energy, 0.5)
}

func TestGpuPowerHistorySurvivesSystemDeletion(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	acc := records.NewGpuPowerAccumulator(hub, time.UTC)
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	acc.Add(sys.Id, t0, gpus(100, 0))
	acc.Add(sys.Id, t0.Add(10*time.Second), gpus(100, 0))
	require.NoError(t, acc.Flush())

	require.NoError(t, hub.Delete(sys))

	recs, err := hub.FindAllRecords(records.GpuPowerCollection, dbx.HashExp{"system_name": "gpu-node"})
	require.NoError(t, err)
	require.Len(t, recs, 1)
	assert.Equal(t, "", recs[0].GetString("system"))
	assert.InDelta(t, 10, recs[0].GetFloat("seconds"), 1e-9)
}

func TestGpuPowerClampsBogusReadings(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	acc := records.NewGpuPowerAccumulator(hub, time.UTC)
	t0 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	acc.Add(sys.Id, t0, gpus(100, 0))
	acc.Add(sys.Id, t0.Add(10*time.Second), gpus(-5, 49183.28))
	require.NoError(t, acc.Flush())

	row := gpuPowerRows(t, hub, sys.Id)["0@2026-10-01"]
	require.NotNil(t, row)
	assert.Equal(t, 0.0, row.GetFloat("energy_wh"))
	assert.InDelta(t, 10, row.GetFloat("busy_seconds"), 1e-9) // capped at 100%
}

func TestGpuPowerRecordsCpuPackage(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	acc := records.NewGpuPowerAccumulator(hub, time.UTC)
	acc.BindHooks()
	collection, err := hub.FindCollectionByNameOrId("system_stats")
	require.NoError(t, err)
	save := func(stats system.Stats) {
		rec := core.NewRecord(collection)
		rec.Set("system", sys.Id)
		rec.Set("type", "1m")
		rec.Set("stats", stats)
		require.NoError(t, hub.SaveNoValidate(rec))
	}
	save(system.Stats{Cpu: 30, CpuPower: 65, GPUData: gpus(250, 40)})
	time.Sleep(1100 * time.Millisecond)
	save(system.Stats{Cpu: 30, CpuPower: 65, GPUData: gpus(250, 40)})
	require.NoError(t, acc.Flush())

	recs, err := hub.FindAllRecords(records.GpuPowerCollection, dbx.HashExp{"system": sys.Id})
	require.NoError(t, err)
	byDevice := map[string]*core.Record{}
	for _, r := range recs {
		byDevice[r.GetString("gpu")] = r
	}
	require.Len(t, byDevice, 2)
	cpu := byDevice[records.CpuPowerDeviceID]
	require.NotNil(t, cpu)
	assert.Equal(t, "CPU", cpu.GetString("name"))
	assert.Equal(t, 65.0, cpu.GetFloat("max_w"))
	assert.InDelta(t, 65*cpu.GetFloat("seconds")/3600, cpu.GetFloat("energy_wh"), 1e-6)
	assert.InDelta(t, 0.3*cpu.GetFloat("seconds"), cpu.GetFloat("busy_seconds"), 1e-6)
	assert.Equal(t, 250.0, byDevice["0"].GetFloat("max_w"))
}

func TestGpuPowerSkipsCpuWithoutReading(t *testing.T) {
	hub, sys := gpuPowerTestSystem(t)
	acc := records.NewGpuPowerAccumulator(hub, time.UTC)
	acc.BindHooks()
	collection, err := hub.FindCollectionByNameOrId("system_stats")
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		rec := core.NewRecord(collection)
		rec.Set("system", sys.Id)
		rec.Set("type", "1m")
		// older agent / no RAPL access: cpw absent
		rec.Set("stats", system.Stats{Cpu: 30, GPUData: gpus(250, 40)})
		require.NoError(t, hub.SaveNoValidate(rec))
		time.Sleep(1100 * time.Millisecond)
	}
	require.NoError(t, acc.Flush())
	recs, err := hub.FindAllRecords(records.GpuPowerCollection, dbx.HashExp{"system": sys.Id, "gpu": records.CpuPowerDeviceID})
	require.NoError(t, err)
	assert.Empty(t, recs)
}
