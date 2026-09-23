package migrations

// gpu-monitoring fork addition (not upstream): adds the GPU columns to the
// existing "containers" collection so they persist and are queryable/
// sortable like every other container stat, instead of a separate table.

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("containers")
		if err != nil {
			return err
		}
		collection.Fields.Add(
			&core.TextField{Name: "gpuPid"},
			&core.NumberField{Name: "gpuMemMiB", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "gpuMemPercent", Min: types.Pointer(0.0), Max: types.Pointer(100.0)},
			&core.NumberField{Name: "gpuUtilPercent", Min: types.Pointer(0.0), Max: types.Pointer(100.0)},
		)
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("containers")
		if err != nil {
			return err
		}
		collection.Fields.RemoveByName("gpuPid")
		collection.Fields.RemoveByName("gpuMemMiB")
		collection.Fields.RemoveByName("gpuMemPercent")
		collection.Fields.RemoveByName("gpuUtilPercent")
		return app.Save(collection)
	})
}
