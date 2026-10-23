// gpu-monitoring fork addition (not upstream): a per-GPU status table for
// the home page, mirroring this project's own Grafana "GPU Status by
// Server" panel (one row per server+GPU, with Util/VRAM/Temp/Power).
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "@nanostores/react"
import { getPagePath } from "@nanostores/router"
import { t } from "@lingui/core/macro"
import { Trans } from "@lingui/react/macro"
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
import {
	BUSY_UTIL_PCT,
	classifyGpu,
	type GpuAvailability,
	type GpuSample,
	parsePbDate,
} from "@/lib/gpu-availability"

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
	/** epoch ms of this GPU's newest sample */
	at: number
	/** epoch ms it last ran (>= BUSY_UTIL_PCT), 0 if not in the fetched history */
	busyAt: number
	/** filled in by groupRows, which knows the system's status */
	availability: GpuAvailability
}

const rowKey = (row: { systemId: string; index: string }) => `${row.systemId}-${row.index}`

const sampleOf = (row: GpuRow): GpuSample => ({
	at: row.at,
	util: row.util,
	memUsed: row.memUsed,
	memTotal: row.memTotal,
	procs: row.procs.length,
})

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

function groupRows(rows: GpuRow[], systems: Record<string, { name: string; status?: string }>): GpuGroup[] {
	const bySystem = new Map<string, GpuRow[]>()
	const now = Date.now()
	for (const row of rows) {
		const systemUp = systems[row.systemId]?.status === SystemStatus.Up
		row.availability = classifyGpu(sampleOf(row), { systemUp, busyAt: row.busyAt, now })
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
			// busy or held: not free for someone else to use
			occupied: gpus.filter((g) => g.availability === "busy" || g.availability === "held").length,
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
	// Newest first. At a 5s poll interval this also covers each system's last
	// couple of minutes, which is what tells "idle for now" from "between steps".
	const records = await pb.collection("system_stats").getList(1, 200, {
		filter: pb.filter("type = {:t}", { t: "1m" }),
		sort: "-created",
		fields: "system,stats,created",
		requestKey: "gpu-status-table",
	})

	type StatsRecord = { system: string; created: string; stats: { g?: Record<string, GpuEntry> } }
	const latestBySystem = new Map<string, StatsRecord>()
	const busyAtByGpu = new Map<string, number>()
	for (const rec of records.items as unknown as StatsRecord[]) {
		if (!latestBySystem.has(rec.system)) {
			latestBySystem.set(rec.system, rec)
		}
		const at = parsePbDate(rec.created)
		for (const [index, gpu] of Object.entries(rec.stats.g ?? {})) {
			if ((gpu.u ?? 0) >= BUSY_UTIL_PCT) {
				const key = rowKey({ systemId: rec.system, index })
				busyAtByGpu.set(key, Math.max(busyAtByGpu.get(key) ?? 0, at))
			}
		}
	}

	const rows: GpuRow[] = []
	for (const [systemId, { stats, created }] of latestBySystem) {
		const at = parsePbDate(created)
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
				at,
				busyAt: busyAtByGpu.get(rowKey({ systemId, index })) ?? 0,
				availability: "free",
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

const AVAILABILITY_TILE: Record<GpuAvailability, string> = {
	free: "border-emerald-500/60 bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 hover:bg-emerald-500/25",
	busy: "border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-100 hover:bg-red-500/20",
	held: "border-amber-500/60 bg-amber-500/15 text-amber-900 dark:text-amber-100 hover:bg-amber-500/25",
	offline: "border-border bg-muted/40 text-muted-foreground hover:bg-muted/60",
}

const AVAILABILITY_DOT: Record<GpuAvailability, string> = {
	free: "bg-emerald-500",
	busy: "bg-red-500",
	held: "bg-amber-500",
	offline: "bg-muted-foreground/50",
}

function availabilityLabel(availability: GpuAvailability) {
	switch (availability) {
		case "free":
			return t`Not in use`
		case "busy":
			return t`In use`
		case "held":
			return t`Idle, memory held`
		default:
			return t`Offline`
	}
}

/** MiB -> "23.5" / "24" GB */
const toGB = (mib: number) => decimalString(mib / 1024, mib >= 10 * 1024 ? 0 : 1)

/** model name without the index the agent appends to identical models ("GeForce RTX 3090 1") */
const modelName = (row: GpuRow) => row.name.replace(new RegExp(` ${row.index}$`), "")

/** who is on the GPU: user of the process holding the most memory, else its container / process */
function topOwner(row: GpuRow) {
	const top = [...row.procs].sort((a, b) => (b.mu ?? 0) - (a.mu ?? 0))[0]
	if (!top) return ""
	if (top.un) return top.un
	if (top.c.startsWith("host")) return top.c.replace(/^host:?/, "") || "host"
	if (top.c.startsWith("k8s:")) return top.c.slice("k8s:".length).split("/")[1] ?? top.c
	return top.c
}

function tileDetail(row: GpuRow) {
	switch (row.availability) {
		case "free": {
			// free memory first: it's what people pick a GPU by, and the tile truncates
			const free = toGB(row.memTotal - row.memUsed)
			const model = modelName(row).replace(/^(NVIDIA |GeForce )+/, "")
			return row.memTotal ? `${t`${free} GB free`} · ${model}` : model
		}
		case "busy":
			return [`${decimalString(row.util, 0)}%`, topOwner(row)].filter(Boolean).join(" · ")
		case "held":
			return [topOwner(row), row.memUsed ? `${toGB(row.memUsed)} GB` : ""].filter(Boolean).join(" · ")
		default:
			return modelName(row)
	}
}

// At-a-glance view above the detailed table: how many GPUs are free (and of
// which model), then one colored tile per GPU, one line per server.
function GpuAvailabilityOverview({
	groups,
	systems,
	onOpen,
}: {
	groups: GpuGroup[]
	systems: Record<string, { name: string }>
	onOpen: (row: GpuRow) => void
}) {
	const all = groups.flatMap((g) => g.gpus)
	const free = all.filter((g) => g.availability === "free")
	const freeByModel = new Map<string, { count: number; memTotal: number }>()
	for (const row of free) {
		const model = modelName(row)
		const entry = freeByModel.get(model) ?? { count: 0, memTotal: row.memTotal }
		entry.count++
		freeByModel.set(model, entry)
	}
	const serverNames = Object.values(systems).map((s) => s.name)

	return (
		<div className="mb-5 grid gap-3 min-w-[44rem]">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-1">
				<span className="text-sm text-muted-foreground">
					<Trans>Available GPUs</Trans>
				</span>
				<span className="text-2xl font-semibold tabular-nums">
					{free.length}
					<span className="text-base font-normal text-muted-foreground"> / {all.length}</span>
				</span>
				{free.length === 0 ? (
					<span className="text-sm text-muted-foreground">
						<Trans>No GPU is free right now.</Trans>
					</span>
				) : (
					[...freeByModel].map(([model, { count, memTotal }]) => (
						<span
							key={model}
							className="text-sm rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-0.5 tabular-nums"
						>
							{model} ×{count}
							{memTotal ? ` · ${toGB(memTotal)} GB` : ""}
						</span>
					))
				)}
			</div>
			<div className="grid gap-1.5">
				{groups.map((group) => (
					<div key={group.systemId} className="flex items-start gap-3">
						<div className="w-32 shrink-0 pt-2 text-sm font-medium flex items-center gap-1.5 min-w-0">
							<span
								className={cn("inline-block size-1.5 rounded-full shrink-0", getServerDotColor(group.name, serverNames))}
							/>
							<span className="truncate" title={group.name}>
								{group.name}
							</span>
						</div>
						<div className="flex flex-wrap gap-1.5">
							{group.gpus.map((row) => (
								<button
									key={rowKey(row)}
									type="button"
									onClick={() => onOpen(row)}
									title={`${row.name} · ${decimalString(row.util, 0)}% · ${toGB(row.memUsed)} / ${toGB(row.memTotal)} GB`}
									className={cn(
										"w-40 rounded-md border px-2.5 py-1 text-start text-xs transition-colors",
										AVAILABILITY_TILE[row.availability]
									)}
								>
									<div className="font-semibold truncate">
										GPU {row.index} · {availabilityLabel(row.availability)}
									</div>
									<div className="opacity-80 tabular-nums truncate">{tileDetail(row)}</div>
								</button>
							))}
						</div>
					</div>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
				{(["free", "busy", "held", "offline"] as const).map((a) => (
					<span key={a} className="inline-flex items-center gap-1.5">
						<span className={cn("size-2 rounded-full", AVAILABILITY_DOT[a])} />
						{availabilityLabel(a)}
					</span>
				))}
				<span>
					<Trans>
						Not in use: no processes, under 5% utilization for the last 2 minutes and almost no memory used. Idle,
						memory held: memory is allocated but the GPU hasn't run for 2 minutes.
					</Trans>
				</span>
			</div>
		</div>
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
	// when each GPU last ran, kept across refreshes so a GPU doesn't turn
	// "free" just because its busy samples scrolled out of the fetched page
	const busyAtRef = useRef(new Map<string, number>())

	// Resolves a container name (all the GPU process row has) to its actual
	// container record (id, image, status, ...), which the shared
	// ContainerSheet -- and the /api/beszel/containers/logs|info endpoints it
	// calls -- need. Only real Docker containers have one; host/k8s-attributed
	// processes never reach here (ProcessContainerLabel doesn't make them clickable).
	// A recreated container keeps its name but gets a new id, and the old
	// record lingers until the hourly cleanup -- take the most recently
	// updated one, which is the container that is actually running.
	async function openContainer(systemId: string, containerName: string) {
		try {
			const record = await pb
				.collection<ContainerRecord>("containers")
				.getFirstListItem(pb.filter("system = {:system} && name = {:name}", { system: systemId, name: containerName }), {
					sort: "-updated",
				})
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
				if (cancelled) return
				for (const row of r) {
					const key = rowKey(row)
					row.busyAt = Math.max(row.busyAt, busyAtRef.current.get(key) ?? 0)
					busyAtRef.current.set(key, row.busyAt)
				}
				setRows(r)
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
				<GpuAvailabilityOverview
					groups={groups}
					systems={systems}
					onOpen={(row) => {
						setActiveRowKey(rowKey(row))
						setSheetOpen(true)
					}}
				/>
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
										<td className="py-2 px-2 tabular-nums" title={t`GPUs in use (running or holding memory) / total`}>
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
