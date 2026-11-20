// Cluster-wide GPU summary derived from the same snapshot as the GPU status table.
// The parent owns polling; this component never performs a duplicate API request.
import { useMemo } from "react"
import { useStore } from "@nanostores/react"
import { SystemStatus } from "@/lib/enums"
import { classifyGpu } from "@/lib/gpu-availability"
import { cn } from "@/lib/utils"
import { $allSystemsById } from "@/lib/stores"
import type { GpuRow } from "./gpu-status-table"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { GpuIcon } from "./ui/icons"

export function GpuClusterOverview({ rows, placeholder = false }: { rows: GpuRow[]; placeholder?: boolean }) {
	const systems = useStore($allSystemsById)
	const stats = useMemo(() => {
		const servers = new Set<string>()
		let totalGpus = 0
		let occupiedGpus = 0
		let utilSum = 0
		let vramSum = 0
		for (const gpu of rows) {
			servers.add(gpu.systemId)
			totalGpus++
			const availability = classifyGpu(
				{ at: gpu.at, util: gpu.util, memUsed: gpu.memUsed, memTotal: gpu.memTotal, procs: gpu.procs.length },
				{ systemUp: systems[gpu.systemId]?.status === SystemStatus.Up, busyAt: gpu.busyAt }
			)
			if (availability === "busy" || availability === "held") occupiedGpus++
			utilSum += gpu.util
			vramSum += gpu.memTotal ? (gpu.memUsed / gpu.memTotal) * 100 : 0
		}
		return {
			servers: servers.size,
			totalGpus,
			occupiedGpus,
			avgUtil: totalGpus ? utilSum / totalGpus : 0,
			avgVram: totalGpus ? vramSum / totalGpus : 0,
		}
	}, [rows, systems])

	if (stats.totalGpus === 0) return null

	// placeholders keep the card at its real size until the first snapshot arrives
	const tiles: { label: string; value: string }[] = [
		{ label: "Servers", value: placeholder ? "-" : `${stats.servers}` },
		{ label: "GPUs", value: placeholder ? "-" : `${stats.totalGpus}` },
		{ label: "GPU Occupancy", value: placeholder ? "-" : `${stats.occupiedGpus} / ${stats.totalGpus}` },
		{ label: "Avg GPU Utilization", value: placeholder ? "-" : `${stats.avgUtil.toFixed(1)}%` },
		{ label: "Avg VRAM Used", value: placeholder ? "-" : `${stats.avgVram.toFixed(1)}%` },
	]
	return (
		<Card aria-busy={placeholder} className={cn(placeholder && "animate-pulse")}>
			<CardHeader className="pb-4 px-2 sm:px-6 max-sm:pt-5 max-sm:pb-1">
				<div className="px-2 sm:px-1">
					<CardTitle className="flex items-center gap-2">
						<GpuIcon className="size-4" />
						GPU Cluster Overview
					</CardTitle>
				</div>
			</CardHeader>
			<CardContent className="max-sm:p-2">
				<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
					{tiles.map((tile) => (
						<div key={tile.label} className="rounded-lg border border-foreground/10 p-4 flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">{tile.label}</span>
							<span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	)
}
