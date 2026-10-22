//go:build testing

package hub_test

import (
	"testing"

	"github.com/henrygd/beszel/internal/records"
	beszelTests "github.com/henrygd/beszel/internal/tests"
	"github.com/pocketbase/pocketbase/core"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// gpu_power_daily: a user sees the rows of their own systems and rows left
// behind by removed systems, but not other users' systems.
func TestGpuPowerDailyReadRule(t *testing.T) {
	hub, err := beszelTests.NewTestHub(t.TempDir())
	require.NoError(t, err)
	defer hub.Cleanup()

	alice, err := beszelTests.CreateUser(hub, "alice@example.com", "testtesttest")
	require.NoError(t, err)
	bob, err := beszelTests.CreateUser(hub, "bob@example.com", "testtesttest")
	require.NoError(t, err)
	newSystem := func(name, owner string) *core.Record {
		rec, err := beszelTests.CreateRecord(hub, "systems", map[string]any{
			"name": name, "host": name, "port": "45876", "status": "up", "users": []string{owner},
		})
		require.NoError(t, err)
		return rec
	}
	newRow := func(systemID, systemName string) *core.Record {
		rec, err := beszelTests.CreateRecord(hub, records.GpuPowerCollection, map[string]any{
			"system": systemID, "system_name": systemName, "gpu": "0", "day": "2026-10-01", "energy_wh": 1,
		})
		require.NoError(t, err)
		return rec
	}
	aliceRow := newRow(newSystem("alice-node", alice.Id).Id, "alice-node")
	bobRow := newRow(newSystem("bob-node", bob.Id).Id, "bob-node")
	orphanRow := newRow("", "removed-node")

	collection, err := hub.FindCollectionByNameOrId(records.GpuPowerCollection)
	require.NoError(t, err)
	require.NotNil(t, collection.ListRule)
	canSee := func(user, row *core.Record) bool {
		row, err := hub.FindRecordById(records.GpuPowerCollection, row.Id)
		require.NoError(t, err)
		ok, err := hub.CanAccessRecord(row, &core.RequestInfo{Auth: user}, collection.ListRule)
		require.NoError(t, err)
		return ok
	}
	assert.True(t, canSee(alice, aliceRow))
	assert.False(t, canSee(alice, bobRow))
	assert.True(t, canSee(alice, orphanRow))
	assert.True(t, canSee(bob, bobRow))
	assert.False(t, canSee(nil, aliceRow), "anonymous")
}
