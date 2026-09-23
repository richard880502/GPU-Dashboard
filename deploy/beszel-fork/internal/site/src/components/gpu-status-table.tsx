// gpu-monitoring fork addition (not upstream): a per-GPU status table for
// the home page, mirroring this project's own Grafana "GPU Status by
// Server" panel (one row per server+GPU, with Util/VRAM/Temp/Power).
import { useEffect, useState } from "react"
import { useStore } from "@nanostores/react"
import { getPagePath } from "@nanostores/router"
import { pb } from "@/lib/api"
import { $allSystemsById } from "@/lib/stores"
import { MeterState } from "@/lib/enums"
import type { GPUProcess } from "@/types"
import { cn, decimalString } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { HashIcon } from "lucide-react"
import { GpuIcon } from "./ui/icons"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet"
import { $router, Link } from "./router"

interface GpuEntry {
	n: string
	mu?: number
	mt?: number
	u: number
	p?: number
	t?: number
	procs?: GPUProcess[]
}

interface GpuRow {
	systemId: string
	index: string
	name: string
	util: number
	vramPct: number
	temp?: number
	power?: number
	procs: GPUProcess[]
}

function getMeterState(value: number, warn = 65, crit = 90): MeterState {
	return value >= crit ? MeterState.Crit : value >= warn ? MeterState.Warn : MeterState.Good
}

const METER_COLORS = {
	[MeterState.Good]: "bg-green-500",
	[MeterState.Warn]: "bg-yellow-500",
	[MeterState.Crit]: "bg-red-500",
} as const

function Meter({ value }: { value: number }) {
	const state = getMeterState(value)
	return (
		<div className="flex gap-2 items-center tabular-nums tracking-tight w-full min-w-0">
			<span className="min-w-10 shrink-0">{decimalString(value, value >= 10 ? 1 : 2)}%</span>
			<span className="flex-1 min-w-8 grid bg-muted h-[1em] rounded-sm overflow-hidden">
				<span className={cn("h-full", METER_COLORS[state])} style={{ width: `${Math.min(value, 100)}%` }}></span>
			</span>
		</div>
	)
}

async function fetchGpuRows(): Promise<GpuRow[]> {
	const records = await pb.collection("system_stats").getList(1, 200, {
		filter: pb.filter("type = {:t}", { t: "1m" }),
		sort: "-created",
		fields: "system,stats,created",
		requestKey: "gpu-status-table",
	})

	const latestBySystem = new Map<string, { g?: Record<string, GpuEntry> }>()
	for (const rec of records.items as unknown as { system: string; stats: { g?: Record<string, GpuEntry> } }[]) {
		if (!latestBySystem.has(rec.system)) {
			latestBySystem.set(rec.system, rec.stats)
		}
	}

	const rows: GpuRow[] = []
	for (const [systemId, stats] of latestBySystem) {
		for (const [index, gpu] of Object.entries(stats.g ?? {})) {
			rows.push({
				systemId,
				index,
				name: gpu.n,
				util: gpu.u ?? 0,
				vramPct: gpu.mt ? ((gpu.mu ?? 0) / gpu.mt) * 100 : 0,
				temp: gpu.t,
				power: gpu.p,
				procs: gpu.procs ?? [],
			})
		}
	}
	return rows
}

function GpuProcessesSheet({
	row,
	systemName,
	open,
	setOpen,
}: {
	row: GpuRow | undefined
	systemName: string
	open: boolean
	setOpen: (open: boolean) => void
}) {
	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetContent className="w-full sm:max-w-160 p-2">
				<SheetHeader>
					<SheetTitle>
						{systemName} — GPU {row?.index} ({row?.name})
					</SheetTitle>
					<SheetDescription>Processes currently using this GPU</SheetDescription>
				</SheetHeader>
				<div className="px-4 pb-4 overflow-x-auto">
					{!row || row.procs.length === 0 ? (
						<p className="text-sm text-muted-foreground">No processes detected on this GPU right now.</p>
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-muted-foreground border-b">
									<th className="font-normal py-2 pe-4">PID</th>
									<th className="font-normal py-2 pe-4">User</th>
									<th className="font-normal py-2 pe-4">Container</th>
									<th className="font-normal py-2 pe-4">VRAM</th>
									<th className="font-normal py-2 pe-4">VRAM %</th>
									<th className="font-normal py-2 pe-4">Util %</th>
								</tr>
							</thead>
							<tbody>
								{row.procs.map((proc) => (
									<tr key={proc.pid} className="border-b last:border-0">
										<td className="py-2 pe-4 tabular-nums">{proc.pid}</td>
										<td className="py-2 pe-4">{proc.un ?? "-"}</td>
										<td className="py-2 pe-4">
											{proc.c === "host" ? (
												<span className="text-muted-foreground">host (not containerized)</span>
											) : (
												proc.c
											)}
										</td>
										<td className="py-2 pe-4 tabular-nums">{proc.mu ? `${decimalString(proc.mu, 0)} MiB` : "-"}</td>
										<td className="py-2 pe-4 tabular-nums">{proc.mp ? `${decimalString(proc.mp, 1)}%` : "0%"}</td>
										<td className="py-2 pe-4 tabular-nums">{proc.u ? `${decimalString(proc.u, 1)}%` : "0%"}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</SheetContent>
		</Sheet>
	)
}

export function GpuStatusTable() {
	const systems = useStore($allSystemsById)
	const [rows, setRows] = useState<GpuRow[]>([])
	const [activeRowKey, setActiveRowKey] = useState<string | undefined>(undefined)
	const [sheetOpen, setSheetOpen] = useState(false)

	useEffect(() => {
		let cancelled = false
		function load() {
			fetchGpuRows().then((r) => {
				if (!cancelled) {
					setRows(r)
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

	if (rows.length === 0) {
		return null
	}

	return (
		<Card>
			<CardHeader className="pb-4 px-2 sm:px-6 max-sm:pt-5 max-sm:pb-1">
				<div className="px-2 sm:px-1">
					<CardTitle className="flex items-center gap-2">
						<GpuIcon className="size-4" />
						GPU Status by Server
					</CardTitle>
				</div>
			</CardHeader>
			<CardContent className="max-sm:p-2 overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="text-left text-muted-foreground border-b">
							<th className="font-normal py-2 px-2">Server</th>
							<th className="font-normal py-2 px-2">GPU</th>
							<th className="font-normal py-2 px-2">Util %</th>
							<th className="font-normal py-2 px-2">VRAM %</th>
							<th className="font-normal py-2 px-2">Temp C</th>
							<th className="font-normal py-2 px-2">Power W</th>
							<th className="font-normal py-2 px-2"></th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const key = `${row.systemId}-${row.index}`
							return (
								<tr
									key={key}
									className="border-b last:border-0 hover:bg-muted/50 cursor-pointer"
									onClick={() => {
										setActiveRowKey(key)
										setSheetOpen(true)
									}}
								>
									<td className="py-2 px-2">
										<Link
											href={getPagePath($router, "system", { id: row.systemId })}
											className="hover:underline"
											onClick={(e) => e.stopPropagation()}
										>
											{systems[row.systemId]?.name ?? row.systemId}
										</Link>
									</td>
									<td className="py-2 px-2 tabular-nums">{row.index}</td>
									<td className="py-2 px-2 min-w-32">
										<Meter value={row.util} />
									</td>
									<td className="py-2 px-2 min-w-32">
										<Meter value={row.vramPct} />
									</td>
									<td className="py-2 px-2 tabular-nums">{row.temp !== undefined ? `${row.temp.toFixed(0)} °C` : "-"}</td>
									<td className="py-2 px-2 tabular-nums">{row.power !== undefined ? `${row.power.toFixed(1)} W` : "-"}</td>
									<td className="py-2 px-2 text-muted-foreground">
										<HashIcon className="size-4" aria-label="View processes" />
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</CardContent>
			<GpuProcessesSheet
				row={rows.find((r) => `${r.systemId}-${r.index}` === activeRowKey)}
				systemName={systems[rows.find((r) => `${r.systemId}-${r.index}` === activeRowKey)?.systemId ?? ""]?.name ?? ""}
				open={sheetOpen}
				setOpen={setSheetOpen}
			/>
		</Card>
	)
}
