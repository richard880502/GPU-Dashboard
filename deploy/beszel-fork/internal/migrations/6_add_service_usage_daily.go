package migrations

// Permanent, per-service daily CPU/GPU usage.  Cursors live in a separate
// private collection so a Hub restart does not replay or double count polls.
import (
    "github.com/pocketbase/pocketbase/core"
    m "github.com/pocketbase/pocketbase/migrations"
    "github.com/pocketbase/pocketbase/tools/types"
)

func init() {
    m.Register(func(app core.App) error {
        systems, err := app.FindCollectionByNameOrId("systems")
        if err != nil { return err }

        daily := core.NewBaseCollection("service_usage_daily")
        daily.Fields.Add(
            &core.RelationField{Name:"system", CollectionId:systems.Id, MaxSelect:1},
            &core.TextField{Name:"system_name"},
            &core.TextField{Name:"service", Required:true},
            &core.TextField{Name:"day", Required:true, Pattern:"^\\d{4}-\\d{2}-\\d{2}$"},
            &core.NumberField{Name:"seconds", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"cpu_core_seconds", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"cpu_known_seconds", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"cpu_host_seconds", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"gpu_util_seconds", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"gpu_known_seconds", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"vram_mib_seconds", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"peak_cpu_pct", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"peak_gpu_pct", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"peak_vram_mib", Min:types.Pointer(0.0)},
            &core.NumberField{Name:"samples", OnlyInt:true, Min:types.Pointer(0.0)},
            &core.AutodateField{Name:"created", OnCreate:true},
            &core.AutodateField{Name:"updated", OnCreate:true, OnUpdate:true},
        )
        daily.AddIndex("idx_service_usage_daily_unique", true, "`system`, `system_name`, `service`, `day`", "")
        daily.AddIndex("idx_service_usage_daily_day", false, "`day`", "")
        if err := app.Save(daily); err != nil { return err }

        cursor := core.NewBaseCollection("service_usage_cursor")
        cursor.Fields.Add(
            &core.TextField{Name:"system_id", Required:true},
            &core.NumberField{Name:"at_ms", OnlyInt:true, Min:types.Pointer(0.0)},
        )
        cursor.AddIndex("idx_service_usage_cursor_system", true, "`system_id`", "")
        return app.Save(cursor)
    }, func(app core.App) error {
        for _, name := range []string{"service_usage_cursor", "service_usage_daily"} {
            coll, err := app.FindCollectionByNameOrId(name)
            if err == nil {
                if err := app.Delete(coll); err != nil { return err }
            }
        }
        return nil
    })
}
