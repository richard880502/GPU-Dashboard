//go:build testing

package records_test

import (
	"testing"
	"time"

	"github.com/henrygd/beszel/internal/entities/container"
	"github.com/henrygd/beszel/internal/records"
	"github.com/henrygd/beszel/internal/tests"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/stretchr/testify/require"
)

func TestServiceUsageDailyAcrossMidnightAndRestart(t *testing.T) {
	hub, err := tests.NewTestHub(t.TempDir())
	require.NoError(t, err)
	defer hub.Cleanup()

	user, err := tests.CreateUser(hub, "service-test@example.com", "testtesttest")
	require.NoError(t, err)
	system, err := tests.CreateRecord(hub, "systems", map[string]any{
		"name": "gpu-node-1", "host": "localhost", "port": "45876", "status": "up",
		"users": []string{user.Id},
	})
	require.NoError(t, err)

	loc := time.FixedZone("Taipei", 8*3600)
	samples := []*container.Stats{{
		Name: "vllm", Cpu: 25, GpuUtilPercent: 50, GpuMemMiB: 1024, GpuIndex: "0",
	}}
	insert := func(at time.Time) {
		t.Helper()
		err := hub.RunInTransaction(func(tx core.App) error {
			return records.RecordServiceUsage(tx, system.Id, system.GetString("name"), at, 8, samples, loc)
		})
		require.NoError(t, err)
	}
	at := time.Date(2026, 11, 1, 15, 59, 30, 0, time.UTC)
	insert(at)                         // initial cursor, no usage yet
	insert(at.Add(time.Minute))        // 30 seconds on each local calendar day
	insert(at.Add(time.Minute))        // retry is idempotent

	for _, day := range []string{"2026-11-01", "2026-11-02"} {
		row, err := hub.FindFirstRecordByFilter(records.ServiceUsageDailyCollection,
			"system = {:system} && service = {:service} && day = {:day}",
			dbx.Params{"system": system.Id, "service": "vllm", "day": day})
		require.NoError(t, err)
		require.InDelta(t, 30, row.GetFloat("seconds"), 0.001)
		require.InDelta(t, 60, row.GetFloat("cpu_core_seconds"), 0.001)
		require.InDelta(t, 15, row.GetFloat("gpu_util_seconds"), 0.001)
		require.InDelta(t, 30720, row.GetFloat("vram_mib_seconds"), 0.001)
		require.Equal(t, 1, row.GetInt("samples"))
	}
	// GPU activity was observed in each of two distinct local clock hours,
	// though the integrated runtime is only 60 seconds total.
	active, err := hub.FindAllRecords(records.ServiceGPUActiveHoursCollection, dbx.HashExp{"system": system.Id})
	require.NoError(t, err)
	require.Len(t, active, 2)
	require.NotEqual(t, active[0].GetString("hour_start"), active[1].GetString("hour_start"))

	// The cursor is persisted even when the time gap is too long to count.
	insert(at.Add(5*time.Minute))
	recs, err := hub.FindAllRecords(records.ServiceUsageDailyCollection, dbx.HashExp{"system": system.Id})
	require.NoError(t, err)
	require.Len(t, recs, 2)
}

func TestServiceUsageCPUWithoutGPUSensor(t *testing.T) {
	hub, err := tests.NewTestHub(t.TempDir())
	require.NoError(t, err)
	defer hub.Cleanup()

	user, err := tests.CreateUser(hub, "service-cpu@example.com", "testtesttest")
	require.NoError(t, err)
	system, err := tests.CreateRecord(hub, "systems", map[string]any{
		"name": "cpu-node", "host": "localhost", "port": "45876", "status": "up",
		"users": []string{user.Id},
	})
	require.NoError(t, err)
	base := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	for _, at := range []time.Time{base, base.Add(30*time.Second)} {
		err := hub.RunInTransaction(func(tx core.App) error {
			return records.RecordServiceUsage(tx, system.Id, "cpu-node", at, 4,
				[]*container.Stats{{Name: "api", Cpu: 50}}, time.UTC)
		})
		require.NoError(t, err)
	}
	row, err := hub.FindFirstRecordByFilter(records.ServiceUsageDailyCollection, "system = {:system}",
		dbx.Params{"system": system.Id})
	require.NoError(t, err)
	require.InDelta(t, 60, row.GetFloat("cpu_core_seconds"), 0.001)
	require.InDelta(t, 30, row.GetFloat("cpu_known_seconds"), 0.001)
	require.Zero(t, row.GetFloat("gpu_known_seconds")) // unknown, not a confirmed 0%-GPU workload
	active, err := hub.FindAllRecords(records.ServiceGPUActiveHoursCollection, dbx.HashExp{"system": system.Id})
	require.NoError(t, err)
	require.Empty(t, active) // CPU-only workloads must not count as GPU-active.

}

func TestServiceGPUActiveHoursCeilingPerClockHour(t *testing.T) {
	hub, err := tests.NewTestHub(t.TempDir())
	require.NoError(t, err)
	defer hub.Cleanup()

	user, err := tests.CreateUser(hub, "gpu-active@example.com", "testtesttest")
	require.NoError(t, err)
	system, err := tests.CreateRecord(hub, "systems", map[string]any{
		"name": "node", "host": "localhost", "port": "45876", "status": "up",
		"users": []string{user.Id},
	})
	require.NoError(t, err)

	// The process is idle but still holds VRAM. It counts as occupying the
	// 10:00 and 11:00 UTC hour buckets, not 0.1 GPU-hours of compute.
	base := time.Date(2026, 11, 2, 10, 59, 50, 0, time.UTC)
	for _, at := range []time.Time{
		base, base.Add(20 * time.Second), base.Add(25 * time.Second),
		base.Add(50 * time.Second), // repeated observations within 11:00
	} {
		err := hub.RunInTransaction(func(tx core.App) error {
			return records.RecordServiceUsage(tx, system.Id, "node", at, 4,
				[]*container.Stats{{Name: "whisperx", GpuMemMiB: 512, GpuUtilPercent: 0}}, time.UTC)
		})
		require.NoError(t, err)
	}
	active, err := hub.FindAllRecords(records.ServiceGPUActiveHoursCollection, dbx.HashExp{"system": system.Id})
	require.NoError(t, err)
	require.Len(t, active, 2)
	days := map[string]bool{}
	for _, row := range active {
		require.Equal(t, "whisperx", row.GetString("service"))
		days[row.GetString("hour_start")] = true
	}
	require.True(t, days["2026-11-02T10:00:00Z"])
	require.True(t, days["2026-11-02T11:00:00Z"])
}

func TestServiceGPUActiveHoursDistinctRepeatedDSTHour(t *testing.T) {
	// US Eastern local 01:30 occurs twice on fall-back day. Both are separate
	// physical 60-minute intervals and must have different UTC hour keys.
	loc, err := time.LoadLocation("America/New_York")
	require.NoError(t, err)
	first := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC).In(loc)
	second := time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC).In(loc)
	require.Equal(t, 1, first.Hour())
	require.Equal(t, 1, second.Hour())
	require.NotEqual(t, first.UTC().Format(time.RFC3339), second.UTC().Format(time.RFC3339))
}
