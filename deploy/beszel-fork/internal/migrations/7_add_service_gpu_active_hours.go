package migrations

// Adds a permanent record per monitored host, logical service, and active
// calendar hour.  Existing installations already have migration 6, so this
// must be a separate migration rather than editing that older migration.
import (
    "github.com/pocketbase/pocketbase/core"
    m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
    m.Register(func(app core.App) error {
        systems, err := app.FindCollectionByNameOrId("systems")
        if err != nil { return err }

        collection := core.NewBaseCollection("service_gpu_active_hours")
        collection.Fields.Add(
            &core.RelationField{Name: "system", CollectionId: systems.Id, MaxSelect: 1},
            &core.TextField{Name: "system_name"},
            &core.TextField{Name: "service", Required: true},
            &core.TextField{Name: "day", Required: true, Pattern: `^\d{4}-\d{2}-\d{2}$`},
            // UTC canonical hour start keeps repeated DST clock-hours distinct.
            &core.TextField{Name: "hour_start", Required: true},
            &core.AutodateField{Name: "created", OnCreate: true},
        )
        collection.AddIndex("idx_service_gpu_active_hour_unique", true,
            "`system`, `service`, `hour_start`", "")
        collection.AddIndex("idx_service_gpu_active_hour_day", false, "`day`", "")
        return app.Save(collection)
    }, func(app core.App) error {
        collection, err := app.FindCollectionByNameOrId("service_gpu_active_hours")
        if err != nil { return nil }
        return app.Delete(collection)
    })
}
