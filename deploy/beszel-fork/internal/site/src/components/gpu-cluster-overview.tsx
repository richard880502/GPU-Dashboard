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
	procs?: { pid: string; c: string }[]
}

interface ClusterGpuStats {
	servers: number
	totalGpus: number
	occupiedGpus: number
	avgUtil: number
	avgVram: number
}

async function fetchClusterGpuStats(): Promise<ClusterGpuStats> {
	const statsRecords = await pb.collection("system_stats").getList(1, 200, {
		filter: pb.filter("type = {:t}", { t: "1m" }),
		sort: "-created",
		fields: "system,stats,created",
		requestKey: "gpu-cluster-overview",
	})

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
	for (const { g } of latestBySystem.values()) {
		const entries = Object.entries(g ?? {})
		if (entries.length === 0) {
			continue
		}
		servers++
		for (const [, gpu] of entries) {
			totalGpus++
			// "Occupied" means at least one real process is attributed to
			// that GPU -- whether it's in a Docker/k8s container or running
			// directly on the host -- not just "reports nonzero memory
			// used" (idle GPUs still hold a small driver/reserved memory
			// footprint, which made every GPU count as "occupied" before).
			if (gpu.procs && gpu.procs.length > 0) {
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
		const interval = setInterval(load, 30_000) // matches the hub's agent-poll interval
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
