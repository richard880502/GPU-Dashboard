// gpu-monitoring fork addition (not upstream): a cluster-wide GPU summary
// card for the home page, mirroring the "Cluster Overview" stat row of this
// project's own Grafana dashboard (Servers / GPUs / GPU Occupancy / Avg GPU
// Utilization / Avg VRAM Used) -- Beszel's systems list only carries each
// system's single "highest gpu utilization" number, not per-GPU breakdown,
// so this reads the latest full system_stats record per system instead.
import { useEffect, useState } from "react"
import { pb } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { GpuIcon } from "./ui/icons"

interface GpuEntry {
	n: string
	mu: number
	mt: number
	u: number
}

interface ClusterGpuStats {
	servers: number
	totalGpus: number
	occupiedGpus: number
	avgUtil: number
	avgVram: number
}

// "Occupied" means at least one real process is attributed to that GPU
// (via gpu-process-exporter's PID->container mapping), not just "reports
// nonzero memory used" -- idle GPUs still hold a small driver/reserved
// memory footprint, which made every GPU count as "occupied" before.
async function fetchOccupiedGpuKeys(): Promise<Set<string>> {
	const records = await pb.collection("containers").getList(1, 500, {
		filter: pb.filter("gpuPid != {:empty}", { empty: "" }),
		fields: "system,gpuIndex",
		requestKey: "gpu-cluster-overview-containers",
	})

	const occupied = new Set<string>()
	for (const rec of records.items as unknown as { system: string; gpuIndex?: string }[]) {
		for (const idx of (rec.gpuIndex ?? "").split(",")) {
			if (idx) {
				occupied.add(`${rec.system}:${idx}`)
			}
		}
	}
	return occupied
}

async function fetchClusterGpuStats(): Promise<ClusterGpuStats> {
	const [statsRecords, occupiedKeys] = await Promise.all([
		pb.collection("system_stats").getList(1, 200, {
			filter: pb.filter("type = {:t}", { t: "1m" }),
			sort: "-created",
			fields: "system,stats,created",
			requestKey: "gpu-cluster-overview",
		}),
		fetchOccupiedGpuKeys(),
	])

	// keep only the latest record per system (list is sorted newest first)
	const latestBySystem = new Map<string, { system: string; g?: Record<string, GpuEntry> }>()
	for (const rec of statsRecords.items as unknown as { system: string; stats: { g?: Record<string, GpuEntry> } }[]) {
		if (!latestBySystem.has(rec.system)) {
			latestBySystem.set(rec.system, { system: rec.system, ...rec.stats })
		}
	}

	let servers = 0
	let totalGpus = 0
	let occupiedGpus = 0
	let utilSum = 0
	let vramSum = 0
	for (const { system, g } of latestBySystem.values()) {
		const entries = Object.entries(g ?? {})
		if (entries.length === 0) {
			continue
		}
		servers++
		for (const [index, gpu] of entries) {
			totalGpus++
			if (occupiedKeys.has(`${system}:${index}`)) {
				occupiedGpus++
			}
			utilSum += gpu.u ?? 0
			vramSum += gpu.mt ? (gpu.mu / gpu.mt) * 100 : 0
		}
	}

	return {
		servers,
		totalGpus,
		occupiedGpus,
		avgUtil: totalGpus ? utilSum / totalGpus : 0,
		avgVram: totalGpus ? vramSum / totalGpus : 0,
	}
}

export function GpuClusterOverview() {
	const [stats, setStats] = useState<ClusterGpuStats | null>(null)

	useEffect(() => {
		let cancelled = false
		function load() {
			fetchClusterGpuStats().then((s) => {
				if (!cancelled) {
					setStats(s)
				}
			})
		}
		load()
		const interval = setInterval(load, 10_000)
		return () => {
			cancelled = true
			clearInterval(interval)
		}
	}, [])

	if (!stats || stats.totalGpus === 0) {
		return null
	}

	const tiles: { label: string; value: string }[] = [
		{ label: "Servers", value: `${stats.servers}` },
		{ label: "GPUs", value: `${stats.totalGpus}` },
		{ label: "GPU Occupancy", value: `${stats.occupiedGpus} / ${stats.totalGpus}` },
		{ label: "Avg GPU Utilization", value: `${stats.avgUtil.toFixed(1)}%` },
		{ label: "Avg VRAM Used", value: `${stats.avgVram.toFixed(1)}%` },
	]

	return (
		<Card>
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
