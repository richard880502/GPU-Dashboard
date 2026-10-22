package migrations

// gpu-monitoring fork addition (not upstream): gpu_power_daily keeps one row
// per system / GPU / day forever (see internal/records/gpu_power.go). The
// system relation does not cascade, so a removed system's history stays
// (with system_name) instead of being deleted with it. Read rules are set in
// hub/collections.go like the other system-scoped collections.

import (
	"time"

	"github.com/henrygd/beszel/internal/records"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		systems, err := app.FindCollectionByNameOrId("systems")
		if err != nil {
			return err
		}
		collection := core.NewBaseCollection(records.GpuPowerCollection)
		collection.Fields.Add(
			&core.RelationField{Name: "system", CollectionId: systems.Id, MaxSelect: 1},
			&core.TextField{Name: "system_name"},
			&core.TextField{Name: "gpu", Required: true},
			&core.TextField{Name: "name"},
			&core.TextField{Name: "day", Required: true, Pattern: `^\d{4}-\d{2}-\d{2}$`},
			&core.NumberField{Name: "energy_wh", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "max_w", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "seconds", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "busy_seconds", Min: types.Pointer(0.0)},
			&core.BoolField{Name: "estimated"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		collection.AddIndex("idx_gpu_power_daily_system_gpu_day", true, "`system`, `system_name`, `gpu`, `day`", "")
		collection.AddIndex("idx_gpu_power_daily_day", false, "`day`", "")
		if err := app.Save(collection); err != nil {
			return err
		}
		// Hub time zone (TZ env), the same one the live accumulation uses.
		return records.BackfillGpuPowerDaily(app, time.Local)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId(records.GpuPowerCollection)
		if err != nil {
			return nil
		}
		return app.Delete(collection)
	})
}
