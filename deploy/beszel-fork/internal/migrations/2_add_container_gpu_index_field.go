package migrations

// gpu-monitoring fork addition (not upstream): adds the gpuIndex column so
// cluster-wide views can count distinct occupied GPUs (by system+index)
// instead of just distinct containers using a GPU.

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("containers")
		if err != nil {
			return err
		}
		collection.Fields.Add(&core.TextField{Name: "gpuIndex"})
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("containers")
		if err != nil {
			return err
		}
		collection.Fields.RemoveByName("gpuIndex")
		return app.Save(collection)
	})
}
