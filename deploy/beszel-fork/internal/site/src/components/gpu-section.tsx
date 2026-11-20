// gpu-monitoring fork addition (not upstream): the home page's two GPU panels.
// The polling hook lives here, not in the home page, so a GPU refresh only
// re-renders these panels and not the systems table below them.
import { useStore } from "@nanostores/react"
import { useEffect, useMemo } from "react"
import { DEFAULT_GPU_LAYOUT, layoutOf, loadLayout, saveLayout } from "@/lib/gpu-layout"
import { $allSystemsById } from "@/lib/stores"
import { GpuClusterOverview } from "./gpu-cluster-overview"
import { GpuStatusTable, placeholderRows, useGpuRows } from "./gpu-status-table"

export function GpuSection() {
	const rows = useGpuRows()
	const systems = useStore($allSystemsById)
	// Before the first snapshot: same servers, same order and card count as
	// last time, so nothing below moves when the real data replaces them.
	const placeholder = useMemo(() => placeholderRows(loadLayout() ?? DEFAULT_GPU_LAYOUT), [])

	useEffect(() => {
		if (rows) saveLayout(layoutOf(rows, (id) => systems[id]?.name ?? id))
	}, [rows, systems])

	const loading = rows === null
	const shown = rows ?? placeholder
	return (
		<>
			<GpuClusterOverview rows={shown} placeholder={loading} />
			<GpuStatusTable rows={shown} placeholder={loading} />
		</>
	)
}
