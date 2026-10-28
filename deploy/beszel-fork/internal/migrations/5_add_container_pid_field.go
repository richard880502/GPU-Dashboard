package migrations

// gpu-monitoring fork addition (not upstream): adds the pid column, the
// container's main process PID as the host sees it (docker inspect State.Pid),
// so the Containers page can show it next to the GPU PIDs. 0 means not known,
// e.g. an agent older than this field.

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
		collection.Fields.Add(&core.NumberField{Name: "pid", OnlyInt: true})
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("containers")
		if err != nil {
			return err
		}
		collection.Fields.RemoveByName("pid")
		return app.Save(collection)
	})
}
