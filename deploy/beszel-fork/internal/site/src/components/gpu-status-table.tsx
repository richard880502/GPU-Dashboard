// gpu-monitoring fork addition (not upstream): a per-GPU status table for
// the home page, mirroring this project's own Grafana "GPU Status by
// Server" panel (one row per server+GPU, with Util/VRAM/Temp/Power).
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "@nanostores/react"
import { getPagePath } from "@nanostores/router"
import { t } from "@lingui/core/macro"
import { Trans } from "@lingui/react/macro"
import { pb } from "@/lib/api"
import { resolvePortMap, type RayInfo } from "@/lib/container-ports"
import { $allSystemsById } from "@/lib/stores"
import { SystemStatus } from "@/lib/enums"
import { displayGpuModel } from "@/lib/gpu-model"
import type { ContainerRecord, GPUProcess } from "@/types"
import { cn, decimalString, getServerDotColor, useBrowserStorage } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import {
	ChevronRightIcon,
	ChevronsDownUpIcon,
	ChevronsUpDownIcon,
	FanIcon,
	GaugeIcon,
	MemoryStickIcon,
	ThermometerIcon,
	type LucideIcon,
	ZapIcon,
} from "lucide-react"
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
	fan?: number
	pl?: number
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
	/** fan speed (%), undefined when the card reports none (0 is a real reading) */
	fan?: number
	/** power limit (W) */
	powerLimit?: number
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

// Bar fill by how full it is: green, amber when getting high, red when nearly
// full -- the same three colors as the state dot and the temperature. Memory
// fills up sooner than it hurts, so it warns later.
function barColor(value: number, warn: number, crit: number) {
	return value >= crit ? "bg-red-500" : value >= warn ? "bg-amber-500" : "bg-emerald-500"
}

// Power draw next to its limit: amber from 90% of the limit, red at or above it
function powerColor(power: number, limit?: number) {
	if (!limit) return ""
	return power >= limit ? "text-red-500" : power >= limit * 0.9 ? "text-amber-500" : ""
}

function tempColor(temp: number) {
	return temp >= 80 ? "text-red-500" : temp >= 60 ? "text-amber-500" : "text-emerald-500"
}

/** GPU memory is reported in MB: 23988 -> "24", 22144 -> "22.1", 30881 -> "30.9" */
function toGB(mb: number) {
	return (mb / 1000).toFixed(1).replace(/\.0$/, "")
}

const freeMem = (row: GpuRow) => Math.max(0, row.memTotal - row.memUsed)

// One dot + word per state (lib/gpu-availability.ts). The same pair is used
// for the legend, the server summary and every GPU card, so a state is always
// read one way.
const AVAILABILITY: Record<GpuAvailability, { dot: string; text: string }> = {
	free: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
	busy: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
	held: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
	offline: { dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
}
const AVAILABILITY_ORDER: GpuAvailability[] = ["free", "busy", "held", "offline"]

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

// The state on a card is the dot alone; the word is its tooltip and accessible
// name. The legend in the header explains the colors.
function StatusDot({ availability }: { availability: GpuAvailability }) {
	const label = availabilityLabel(availability)
	return <span role="img" aria-label={label} title={label} className={cn("block size-3 rounded-full", AVAILABILITY[availability].dot)} />
}

// A thin progress bar: role=progressbar for assistive tech, the width eases
// between refreshes unless the user asked for reduced motion. The track uses
// foreground/10 so it stays visible on the (darker) panel in both themes.
function Bar({ value, label, color }: { value: number; label: string; color: string }) {
	const pct = Math.min(100, Math.max(0, value))
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(pct)}
			className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-300 dark:bg-[#2b2b2e]"
		>
			<div
				className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", color)}
				style={{ width: `${pct}%` }}
			/>
		</div>
	)
}

// The inset panel: one step darker than the card around it (muted on the
// light theme, background on the dark one), label and value on one line with
// the bar right under them.
function Panel({
	Icon,
	label,
	value,
	valueTitle,
	className,
	children,
}: {
	Icon: LucideIcon
	label: string
	value: string
	valueTitle?: string
	className?: string
	children: ReactNode
}) {
	return (
		<div
			className={cn(
				"min-w-0 rounded-[14px] border border-slate-300/70 bg-slate-200 px-3 py-2 dark:border-white/[0.06] dark:bg-[#0e0e0f]",
				className
			)}
		>
			<div className="flex items-center justify-between gap-2 text-xs">
				<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-slate-500 dark:text-neutral-400">
					<Icon className="size-3" aria-hidden="true" />
					{label}
				</span>
				<span className="whitespace-nowrap font-semibold tabular-nums text-slate-900 dark:text-neutral-50" title={valueTitle}>
					{value}
				</span>
			</div>
			{children}
		</div>
	)
}

// One GPU as a slim card in a single-column list. Reading order, left to
// right: state, free VRAM, GPU + readings, memory panel, utilization panel.
// From lg up it is one row on a fixed column template, so every card's free
// VRAM, bars and chevron line up with the cards above and below it (state dot
// and free-VRAM columns are fixed width; memory and utilization are equal
// columns).
// Below lg the same items wrap: state + free VRAM first, then the GPU line,
// then the two panels side by side (also equal width).
// Clicking the card opens the processes panel.
const CARD_COLUMNS = "lg:grid-cols-[0.75rem_5.5rem_minmax(11rem,1.3fr)_minmax(11rem,1fr)_minmax(11rem,1fr)_1rem]"

function GpuCard({ row, offline, onOpen }: { row: GpuRow; offline: boolean; onOpen: () => void }) {
	const free = row.availability === "free"
	const memPct = row.memTotal ? (row.memUsed / row.memTotal) * 100 : 0
	return (
		<div
			role="button"
			tabIndex={0}
			aria-label={`GPU ${row.index} ${row.name} · ${availabilityLabel(row.availability)}`}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onOpen()
				}
			}}
			className={cn(
				"cursor-pointer rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 px-3 py-2.5 shadow-sm transition-colors hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				"dark:border-white/[0.07] dark:from-[#222225] dark:to-[#1b1b1d] dark:shadow-none dark:hover:border-white/20",
				offline && "opacity-60"
			)}
		>
			<div className={cn("flex flex-col gap-2 lg:grid lg:items-center lg:gap-x-3", CARD_COLUMNS)}>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 lg:contents">
					<div className="flex shrink-0 items-center lg:order-1">
						<StatusDot availability={row.availability} />
					</div>
					<div className="w-20 shrink-0 text-center leading-tight lg:order-2 lg:w-auto">
						<div className="text-[11px] text-slate-500 dark:text-neutral-400">{t`Free VRAM`}</div>
						<div
							className={cn(
								"text-sm font-semibold tabular-nums text-slate-900 dark:text-neutral-50",
								free && "text-emerald-600 dark:text-emerald-400"
							)}
						>
							{row.memTotal && row.availability !== "offline" ? `${toGB(freeMem(row))} GB` : "-"}
						</div>
					</div>
					<div className="min-w-[12rem] flex-1 lg:order-3 lg:min-w-0">
						<div className="flex min-w-0 items-baseline gap-2">
							<span className="shrink-0 whitespace-nowrap font-semibold tabular-nums text-slate-900 dark:text-neutral-50">
								GPU {row.index}
							</span>
							<span className="min-w-0 truncate text-sm text-slate-500 dark:text-neutral-400" title={row.name}>
								{row.name}
							</span>
						</div>
						<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-slate-600 dark:text-neutral-300">
							{row.temp !== undefined && (
								<span className={cn("inline-flex items-center gap-0.5", tempColor(row.temp))} title={t`Temperature`}>
									<ThermometerIcon className="size-3" aria-hidden="true" />
									{row.temp.toFixed(0)}°C
								</span>
							)}
							{row.fan !== undefined && (
								<span className="inline-flex items-center gap-0.5" title={t`Fan speed`}>
									<FanIcon className="size-3" aria-hidden="true" />
									{row.fan.toFixed(0)}%
								</span>
							)}
							{row.power !== undefined && (
								<span
									className={cn("inline-flex items-center gap-0.5", powerColor(row.power, row.powerLimit))}
									title={row.powerLimit ? t`Power / limit` : "Power"}
								>
									<ZapIcon className="size-3" aria-hidden="true" />
									{row.power.toFixed(0)}W{row.powerLimit ? ` / ${row.powerLimit.toFixed(0)}W` : ""}
								</span>
							)}
							<span>
								{row.procs.length} {t`Processes`}
							</span>
						</div>
					</div>
					<ChevronRightIcon className="ms-auto size-4 shrink-0 text-slate-400 dark:text-neutral-500 lg:order-6 lg:ms-0" aria-hidden="true" />
				</div>
				<div className="grid grid-cols-2 gap-2 lg:contents">
					<Panel
						Icon={MemoryStickIcon}
						label={t`Memory`}
						value={`${toGB(row.memUsed)}/${toGB(row.memTotal)} GB`}
						valueTitle={`${decimalString(row.memUsed, 0)}MiB / ${decimalString(row.memTotal, 0)}MiB`}
						className="lg:order-4"
					>
						<Bar value={memPct} label={t`Memory`} color={barColor(memPct, 70, 90)} />
					</Panel>
					<Panel
						Icon={GaugeIcon}
						label={t({ message: "Utilization", context: "GPU card" })}
						value={`${decimalString(row.util, row.util >= 10 ? 0 : 1)}%`}
						className="lg:order-5"
					>
						<Bar value={row.util} label={t({ message: "Utilization", context: "GPU card" })} color={barColor(row.util, 50, 85)} />
					</Panel>
				</div>
			</div>
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
				// the agent's " <id>" suffix on duplicate models is shown as "GPU <id>" already
				name: displayGpuModel(gpu.n, index),
				util: gpu.u ?? 0,
				vramPct: gpu.mt ? ((gpu.mu ?? 0) / gpu.mt) * 100 : 0,
				memUsed: gpu.mu ?? 0,
				memTotal: gpu.mt ?? 0,
				temp: gpu.t,
				power: gpu.p,
				fan: gpu.fan,
				powerLimit: gpu.pl,
				procs: gpu.procs ?? [],
				at,
				busyAt: busyAtByGpu.get(rowKey({ systemId, index })) ?? 0,
				availability: "free",
			})
		}
	}
	return rows
}

// Ports of the container behind a GPU process: the published mapping
// ("host→container"), or for a host-network container the ports it listens on
// (Docker has no mapping to report there), with a badge if it runs a Ray node.
// Agents older than the portMap field only have the upstream host ports,
// shown muted; host / k8s processes with neither show a dash.
function RayBadge({ ray }: { ray: RayInfo }) {
	return (
		<span className="me-1 rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">
			{ray.role === "head"
				? t({ message: "Ray head", context: "Container ports" })
				: t({ message: "Ray worker", context: "Container ports" })}
		</span>
	)
}

function ProcessPorts({ value, legacyPorts }: { value?: string; legacyPorts?: string }) {
	const view = resolvePortMap(value, legacyPorts)
	if (view.kind === "none") {
		return <span className="text-muted-foreground">—</span>
	}
	if (view.kind === "host") {
		return <span className="text-muted-foreground">host network</span>
	}
	if (view.kind === "ray") {
		// a worker has no service of its own: the ports are on its head node
		const { ray } = view
		const head = ray.role === "worker" ? ray.head : undefined
		const title =
			ray.role === "worker"
				? [
						t({ message: "Ray worker node: the service ports are on the head node", context: "Container ports" }),
						head ? t({ message: `Head node: ${head}`, context: "Container ports" }) : "",
					]
						.filter(Boolean)
						.join("\n")
				: t({ message: "Ray head node", context: "Container ports" })
		return (
			<span title={title}>
				<RayBadge ray={ray} />
				{head && <span className="text-muted-foreground tabular-nums">→ {head}</span>}
			</span>
		)
	}
	const more = view.hiddenCount > 0 && <span className="text-muted-foreground"> +{view.hiddenCount}</span>
	if (view.kind === "legacy") {
		return (
			<span
				className="tabular-nums text-muted-foreground"
				title={`${t({ message: "Host ports only (older agent)", context: "Container ports" })}\n${view.full}`}
			>
				{view.shown.join(", ")}
				{more}
			</span>
		)
	}
	const listening = view.kind === "listen"
	return (
		<span
			className="tabular-nums"
			title={listening ? `${t({ message: "Listening on the host network", context: "Container ports" })}\n${view.full}` : view.full}
		>
			{view.ray ? (
				<RayBadge ray={view.ray} />
			) : (
				listening && (
					<span className="me-1 rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">
						{t({ message: "listen", context: "Container ports" })}
					</span>
				)
			)}
			{view.shown.join(", ")}
			{more}
		</span>
	)
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
	// container name -> published ports, read when the panel opens: the GPU
	// process rows only carry the container's name. Ports rarely change, so
	// there is no live subscription.
	const [portMaps, setPortMaps] = useState<Record<string, { portMap: string; ports: string }>>({})
	const systemId = row?.systemId
	useEffect(() => {
		if (!open || !systemId) {
			return
		}
		let cancelled = false
		pb.collection<Pick<ContainerRecord, "name" | "portMap" | "ports">>("containers")
			.getFullList({
				filter: pb.filter("system = {:system}", { system: systemId }),
				fields: "name,portMap,ports",
				// a recreated container keeps its name: the newest record wins below
				sort: "updated",
			})
			.then((records) => {
				if (cancelled) {
					return
				}
				const byName: Record<string, { portMap: string; ports: string }> = {}
				for (const record of records) {
					byName[record.name] = { portMap: record.portMap ?? "", ports: record.ports ?? "" }
				}
				setPortMaps(byName)
			})
			.catch(() => !cancelled && setPortMaps({}))
		return () => {
			cancelled = true
		}
	}, [open, systemId])

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
									<th className="font-normal py-2 pe-4">{t({ message: "Ports", context: "Container ports" })}</th>
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
										<td className="py-2 pe-4">
											<ProcessPorts value={portMaps[proc.c]?.portMap} legacyPorts={portMaps[proc.c]?.ports} />
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

	const freeCount = rows.filter((r) => r.availability === "free").length
	const allExpanded = groups.every((g) => !collapsed[g.systemId])
	const setAll = (expand: boolean) => setCollapsed(Object.fromEntries(groups.map((g) => [g.systemId, !expand])))

	return (
		<Card>
			<CardHeader className="pb-4 px-2 sm:px-6 max-sm:pt-5 max-sm:pb-1">
				<div className="px-2 sm:px-1 flex items-center justify-between gap-2">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<CardTitle className="flex items-center gap-2">
							<GpuIcon className="size-4" />
							GPU Status by Server
						</CardTitle>
						<span
							className={cn(
								"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm tabular-nums",
								freeCount === 0 && "text-muted-foreground"
							)}
						>
							<span className={cn("size-2 rounded-full", freeCount > 0 ? "bg-emerald-500" : "bg-muted-foreground/50")} aria-hidden="true" />
							<Trans>Available GPUs</Trans>
							<span className="font-semibold">{freeCount}</span>/ {rows.length}
						</span>
						<span className="hidden md:inline-flex items-center gap-3 text-xs text-muted-foreground">
							{AVAILABILITY_ORDER.map((a) => (
								<span key={a} className="inline-flex items-center gap-1">
									<span className={cn("size-2 rounded-full", AVAILABILITY[a].dot)} aria-hidden="true" />
									{availabilityLabel(a)}
								</span>
							))}
						</span>
					</div>
					<Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setAll(!allExpanded)}>
						{allExpanded ? <ChevronsDownUpIcon className="size-4" /> : <ChevronsUpDownIcon className="size-4" />}
						{allExpanded ? "Collapse all" : "Expand all"}
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-3 max-sm:p-2">
				{groups.map((group) => {
					const isOpen = !collapsed[group.systemId]
					const status = systems[group.systemId]?.status
					const offline = status !== undefined && status !== SystemStatus.Up
					const toggle = () => setCollapsed({ ...collapsed, [group.systemId]: isOpen })
					const free = group.gpus.filter((g) => g.availability === "free").length
					const total = group.gpus.length
					return (
						<section key={group.systemId} className="space-y-2">
							<div
								className={cn(
									"flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-muted/30 px-3 py-2 hover:bg-muted/60",
									offline && "opacity-60"
								)}
								onClick={toggle}
							>
								<span className="inline-flex items-center gap-2 font-medium">
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
											"inline-block size-1.5 shrink-0 rounded-full",
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
								<span
									className={cn(
										"text-sm tabular-nums",
										free > 0 ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
									)}
								>
									{t`${free} / ${total} free`}
								</span>
								<span className="ms-auto flex flex-wrap items-center gap-x-4 text-xs tabular-nums text-muted-foreground">
									<span title="Average utilization">
										{t({ message: "Utilization", context: "GPU card" })} {decimalString(group.avgUtil, 0)}%
									</span>
									<span title={t`Most free VRAM on a single GPU`}>
										{(() => {
											const online = group.gpus.filter((g) => g.availability !== "offline" && g.memTotal)
											return online.length ? `${t`Free VRAM`} ${toGB(Math.max(...online.map(freeMem)))} GB` : ""
										})()}
									</span>
									{group.maxTemp !== undefined && <span title="Hottest GPU">{group.maxTemp.toFixed(0)}°C</span>}
									{group.totalPower !== undefined && <span title="Total power">{group.totalPower.toFixed(0)}W</span>}
								</span>
							</div>
							{isOpen && (
								<div className="flex flex-col gap-2">
									{group.gpus.map((row) => {
										const key = `${row.systemId}-${row.index}`
										return (
											<GpuCard
												key={key}
												row={row}
												offline={offline}
												onOpen={() => {
													setActiveRowKey(key)
													setSheetOpen(true)
												}}
											/>
										)
									})}
								</div>
							)}
						</section>
					)
				})}
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
