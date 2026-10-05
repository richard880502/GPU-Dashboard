// gpu-monitoring fork addition (not upstream): a per-GPU status table for
// the home page, mirroring this project's own Grafana "GPU Status by
// Server" panel (one row per server+GPU, with Util/VRAM/Temp/Power).
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "@nanostores/react"
import { getPagePath } from "@nanostores/router"
import { t } from "@lingui/core/macro"
import { pb } from "@/lib/api"
import { $allSystemsById } from "@/lib/stores"
import { MeterState, SystemStatus } from "@/lib/enums"
import type { ContainerRecord, GPUProcess } from "@/types"
import { cn, decimalString, getServerDotColor, useBrowserStorage } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, HashIcon } from "lucide-react"
import { GpuIcon } from "./ui/icons"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet"
import { $router, Link } from "./router"
import { ContainerSheet } from "./containers-table/containers-table"
import { toast } from "./ui/use-toast"
import { Button } from "./ui/button"

// Renders a process's container attribution readably instead of the raw
// "host:<process>" / "k8s:<namespace>/<pod>/<container>" wire format. Real
// Docker containers and k8s pods (agent/cri_containers.go writes the exact
// same "k8s:<ns>/<pod>/<container>" string as this process's own `c` field,
// so the same by-name lookup resolves both) are clickable, drilling into the
// same logs/detail Sheet the /containers page uses -- "host" processes have
// no container record at all to look up, so those stay plain text.
function ProcessContainerLabel({
	value,
	systemId,
	onOpenContainer,
}: {
	value: string
	systemId: string
	onOpenContainer: (systemId: string, containerName: string) => void
}) {
	if (value.startsWith("host:")) {
		const processName = value.slice("host:".length)
		return <span className="text-muted-foreground">host ({processName})</span>
	}
	if (value === "host") {
		return <span className="text-muted-foreground">host (not containerized)</span>
	}
	if (value.startsWith("k8s:")) {
		const [namespace, pod, container] = value.slice("k8s:".length).split("/")
		return (
			<button
				type="button"
				title={`${namespace}/${pod}/${container}`}
				className="hover:underline underline-offset-2 text-left"
				onClick={() => onOpenContainer(systemId, value)}
			>
				<span className="text-muted-foreground">k8s:</span> {pod}
			</button>
		)
	}
	return (
		<button
			type="button"
			className="hover:underline underline-offset-2 text-left"
			onClick={() => onOpenContainer(systemId, value)}
		>
			{value}
		</button>
	)
}

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
	memUsed: number
	memTotal: number
	temp?: number
	power?: number
	procs: GPUProcess[]
}

// One collapsible group per server: its GPUs plus the roll-up shown on the
// (always visible) header row, so a busy server is findable without expanding.
interface GpuGroup {
	systemId: string
	name: string
	gpus: GpuRow[]
	occupied: number
	avgUtil: number
	vramPct: number
	maxTemp?: number
	totalPower?: number
}

function groupRows(rows: GpuRow[], systems: Record<string, { name: string }>): GpuGroup[] {
	const bySystem = new Map<string, GpuRow[]>()
	for (const row of rows) {
		bySystem.set(row.systemId, [...(bySystem.get(row.systemId) ?? []), row])
	}
	const groups: GpuGroup[] = []
	for (const [systemId, gpus] of bySystem) {
		gpus.sort((a, b) => Number(a.index) - Number(b.index))
		const temps = gpus.map((g) => g.temp).filter((v): v is number => v !== undefined)
		const powers = gpus.map((g) => g.power).filter((v): v is number => v !== undefined)
		const memTotal = gpus.reduce((sum, g) => sum + g.memTotal, 0)
		groups.push({
			systemId,
			name: systems[systemId]?.name ?? systemId,
			gpus,
			occupied: gpus.filter((g) => g.procs.length > 0).length,
			avgUtil: gpus.reduce((sum, g) => sum + g.util, 0) / gpus.length,
			vramPct: memTotal ? (gpus.reduce((sum, g) => sum + g.memUsed, 0) / memTotal) * 100 : 0,
			maxTemp: temps.length ? Math.max(...temps) : undefined,
			totalPower: powers.length ? powers.reduce((a, b) => a + b, 0) : undefined,
		})
	}
	// Stable order (by name). The rows come back newest-record-first, which
	// reshuffled the servers on every refresh.
	return groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

function getMeterState(value: number, warn = 65, crit = 90): MeterState {
	return value >= crit ? MeterState.Crit : value >= warn ? MeterState.Warn : MeterState.Good
}

// Warn/Crit slightly desaturated from Apple's pure systemYellow/systemRed
// (100% saturation) so a long, high-value meter bar doesn't visually
// outweigh the number next to it -- Good stays fully saturated since green
// bars are rarely the ones running end-to-end across the row.
const METER_COLORS = {
	[MeterState.Good]: "bg-[#34c759] dark:bg-[#30d158]",
	[MeterState.Warn]: "bg-[hsl(45,82%,48%)] dark:bg-[hsl(45,88%,52%)]",
	[MeterState.Crit]: "bg-[hsl(4,82%,55%)] dark:bg-[hsl(4,85%,58%)]",
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
				memUsed: gpu.mu ?? 0,
				memTotal: gpu.mt ?? 0,
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
	onOpenContainer,
}: {
	row: GpuRow | undefined
	systemName: string
	open: boolean
	setOpen: (open: boolean) => void
	onOpenContainer: (systemId: string, containerName: string) => void
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
											<ProcessContainerLabel value={proc.c} systemId={row.systemId} onOpenContainer={onOpenContainer} />
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
	// systemId -> collapsed. Missing = expanded, so every server (including
	// ones added later) shows its GPUs until the user folds it away.
	const [collapsed, setCollapsed] = useBrowserStorage<Record<string, boolean>>("gpu-status-collapsed", {})
	const [activeRowKey, setActiveRowKey] = useState<string | undefined>(undefined)
	const [sheetOpen, setSheetOpen] = useState(false)
	const activeContainer = useRef<ContainerRecord | null>(null)
	const [containerSheetOpen, setContainerSheetOpen] = useState(false)

	// Resolves a container name (all the GPU process row has) to its actual
	// container record (id, image, status, ...), which the shared
	// ContainerSheet -- and the /api/beszel/containers/logs|info endpoints it
	// calls -- need. Only real Docker containers have one; host/k8s-attributed
	// processes never reach here (ProcessContainerLabel doesn't make them clickable).
	async function openContainer(systemId: string, containerName: string) {
		try {
			const record = await pb
				.collection<ContainerRecord>("containers")
				.getFirstListItem(pb.filter("system = {:system} && name = {:name}", { system: systemId, name: containerName }))
			activeContainer.current = record
			setContainerSheetOpen(true)
		} catch (error) {
			console.error(error)
			toast({
				title: t`Container not found`,
				description: t`It may have stopped or been removed since this GPU snapshot was taken.`,
				variant: "destructive",
			})
		}
	}

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
		// matches the hub's actual agent-poll interval (UPDATE_INTERVAL_MS,
		// possibly overridden from its 30s default) instead of a hardcoded
		// value that would silently drift out of sync with it
		const interval = setInterval(load, globalThis.BESZEL?.UPDATE_INTERVAL_MS || 30_000)
		return () => {
			cancelled = true
			clearInterval(interval)
		}
	}, [])

	const groups = useMemo(() => groupRows(rows, systems), [rows, systems])

	if (rows.length === 0) {
		return null
	}

	const allExpanded = groups.every((g) => !collapsed[g.systemId])
	const setAll = (expand: boolean) => setCollapsed(Object.fromEntries(groups.map((g) => [g.systemId, !expand])))

	return (
		<Card>
			<CardHeader className="pb-4 px-2 sm:px-6 max-sm:pt-5 max-sm:pb-1">
				<div className="px-2 sm:px-1 flex items-center justify-between gap-2">
					<CardTitle className="flex items-center gap-2">
						<GpuIcon className="size-4" />
						GPU Status by Server
					</CardTitle>
					<Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setAll(!allExpanded)}>
						{allExpanded ? <ChevronsDownUpIcon className="size-4" /> : <ChevronsUpDownIcon className="size-4" />}
						{allExpanded ? "Collapse all" : "Expand all"}
					</Button>
				</div>
			</CardHeader>
			<CardContent className="max-sm:p-2 overflow-x-auto">
				<table className="w-full min-w-[44rem] text-sm table-fixed">
					<thead>
						<tr className="text-left text-muted-foreground border-b">
							<th className="font-normal py-2 px-2 w-[24%]">Server</th>
							<th className="font-normal py-2 px-2 w-[8%]">GPU</th>
							<th className="font-normal py-2 px-2 w-[22%]">Util %</th>
							<th className="font-normal py-2 px-2 w-[22%]">VRAM %</th>
							<th className="font-normal py-2 px-2 w-[9%]">Temp C</th>
							<th className="font-normal py-2 px-2 w-[10%]">Power W</th>
							<th className="font-normal py-2 px-2 w-[5%]"></th>
						</tr>
					</thead>
					<tbody>
						{groups.map((group) => {
							const isOpen = !collapsed[group.systemId]
							const status = systems[group.systemId]?.status
							const offline = status !== undefined && status !== SystemStatus.Up
							const toggle = () => setCollapsed({ ...collapsed, [group.systemId]: isOpen })
							return (
								<Fragment key={group.systemId}>
									<tr
										className={cn("border-b bg-muted/30 hover:bg-muted/60 cursor-pointer", offline && "opacity-60")}
										onClick={toggle}
									>
										<td className="py-2 px-2">
											<span className="inline-flex items-center gap-1.5 font-medium">
												<button
													type="button"
													aria-expanded={isOpen}
													aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.name}`}
													className="text-muted-foreground"
													onClick={(e) => {
														e.stopPropagation()
														toggle()
													}}
												>
													<ChevronRightIcon className={cn("size-4 transition-transform", isOpen && "rotate-90")} />
												</button>
												<span
													className={cn(
														"inline-block size-1.5 rounded-full shrink-0",
														getServerDotColor(
															group.name,
															Object.values(systems).map((s) => s.name)
														)
													)}
												/>
												<Link
													href={getPagePath($router, "system", { id: group.systemId })}
													className="hover:underline"
													onClick={(e) => e.stopPropagation()}
												>
													{group.name}
												</Link>
												{offline && <span className="text-xs font-normal text-muted-foreground">({status})</span>}
											</span>
										</td>
										<td className="py-2 px-2 tabular-nums" title="GPUs in use / total">
											{group.occupied}/{group.gpus.length}
										</td>
										<td className="py-2 px-2 min-w-32">
											<Meter value={group.avgUtil} />
										</td>
										<td className="py-2 px-2 min-w-32">
											<Meter value={group.vramPct} />
										</td>
										<td className="py-2 px-2 tabular-nums" title="Hottest GPU">
											{group.maxTemp !== undefined ? `${group.maxTemp.toFixed(0)} °C` : "-"}
										</td>
										<td className="py-2 px-2 tabular-nums" title="Total power">
											{group.totalPower !== undefined ? `${group.totalPower.toFixed(1)} W` : "-"}
										</td>
										<td className="py-2 px-2"></td>
									</tr>
									{isOpen &&
										group.gpus.map((row) => {
											const key = `${row.systemId}-${row.index}`
											return (
												<tr
													key={key}
													className={cn("border-b last:border-0 hover:bg-muted/50 cursor-pointer", offline && "opacity-60")}
													onClick={() => {
														setActiveRowKey(key)
														setSheetOpen(true)
													}}
												>
													<td className="py-2 ps-9 pe-2 text-muted-foreground truncate" title={row.name}>{row.name}</td>
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
								</Fragment>
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
				onOpenContainer={openContainer}
			/>
			<ContainerSheet sheetOpen={containerSheetOpen} setSheetOpen={setContainerSheetOpen} activeContainer={activeContainer} />
		</Card>
	)
}
