package migrations

// gpu-monitoring fork addition (not upstream): adds the portMap column, the
// container's published ports as "host→container" text, so the GPU process
// panel can show which service listens on which host port. The existing
// upstream ports column only holds the host side.

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
		collection.Fields.Add(&core.TextField{Name: "portMap"})
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("containers")
		if err != nil {
			return err
		}
		collection.Fields.RemoveByName("portMap")
		return app.Save(collection)
	})
}
