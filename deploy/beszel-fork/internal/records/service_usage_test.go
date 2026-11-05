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
}
