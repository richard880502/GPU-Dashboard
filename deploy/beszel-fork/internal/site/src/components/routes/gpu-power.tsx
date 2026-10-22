// gpu-monitoring fork addition (not upstream): daily GPU / CPU package energy
// history from the permanent gpu_power_daily collection (CPU rows use the
// device id "cpu").
import { Trans, useLingui } from "@lingui/react/macro"
import { useStore } from "@nanostores/react"
import { ZapIcon } from "lucide-react"
import { memo, useEffect, useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, Tooltip, type TooltipProps, XAxis, YAxis } from "recharts"
import { ActiveAlerts } from "@/components/active-alerts"
import { FooterRepoLink } from "@/components/footer-repo-link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { pb } from "@/lib/api"
import { $allSystemsById } from "@/lib/stores"
import { cn, useBrowserStorage } from "@/lib/utils"
import type { GpuPowerDailyRecord, SystemRecord } from "@/types"

type RangeKey = "7" | "30" | "90" | "365" | "all"
/** "gpu" = one series per device (kept as the stored value from when only GPUs existed) */
type GroupKey = "system" | "gpu" | "kind"

const DAY_SECONDS = 86400
const CPU_DEVICE = "cpu"

/** YYYY-MM-DD in the browser's local time (the hub buckets days the same way in its TZ) */
function dayString(d: Date) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function addDays(day: string, n: number) {
	const [y, m, d] = day.split("-").map(Number)
	return dayString(new Date(y, m - 1, d + n))
}

function daysBetween(from: string, to: string) {
	const days: string[] = []
	for (let d = from; d <= to; d = addDays(d, 1)) {
		days.push(d)
	}
	return days
}

/** seconds a device could have reported on `day` (today: only the part already gone by) */
function possibleSeconds(day: string, today: string) {
	if (day !== today) return DAY_SECONDS
	const now = new Date()
	return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
}

/**
 * Seconds a device could have reported on its first recorded day: from when its
 * row was created (a new server, or the CPU after the agent update) instead of
 * from midnight. Backfilled rows cover whole days, so they are left alone.
 */
function firstDaySeconds(row: GpuPowerDailyRecord, today: string) {
	if (row.estimated || !row.created) return undefined
	const created = new Date(String(row.created).replace(" ", "T"))
	if (Number.isNaN(created.getTime()) || dayString(created) !== row.day) return undefined
	const end =
		row.day === today ? new Date() : new Date(created.getFullYear(), created.getMonth(), created.getDate() + 1)
	return Math.max(0, (end.getTime() - created.getTime()) / 1000)
}

function formatKwh(wh: number) {
	const kwh = wh / 1000
	return kwh.toLocaleString(undefined, { maximumFractionDigits: kwh < 10 ? 2 : 1 })
}

function formatWatts(w: number) {
	return `${Math.round(w).toLocaleString()} W`
}

function formatPercent(fraction: number) {
	return `${Math.round(Math.min(fraction, 1) * 100)}%`
}

function seriesColor(i: number) {
	return i < 5 ? `var(--chart-${i + 1})` : `hsl(${(i * 47 + 20) % 360} 65% 55%)`
}

const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

const isCpu = (device: string) => device === CPU_DEVICE

function deviceLabel(device: string) {
	return isCpu(device) ? "CPU" : `GPU ${device}`
}

function serverKey(row: GpuPowerDailyRecord) {
	return row.system || `removed:${row.system_name}`
}

function serverName(row: GpuPowerDailyRecord, systems: Record<string, SystemRecord>) {
	return systems[row.system]?.name || row.system_name || "?"
}

interface DeviceTotals {
	key: string
	server: string
	serverKey: string
	device: string
	model: string
	energyWh: number
	seconds: number
	busySeconds: number
	maxW: number
	possibleSeconds: number
	estimated: boolean
	removed: boolean
}

interface ServerTotals {
	key: string
	name: string
	/** GPUs by index, then the CPU */
	devices: DeviceTotals[]
	energyWh: number
}

interface ChartRow {
	day: string
	values: Record<string, number>
	total: number
	estimated: boolean
}

export default memo(() => {
	const { t } = useLingui()
	const systems = useStore($allSystemsById)
	const [range, setRange] = useBrowserStorage<RangeKey>("gpu-power-range", "30")
	const [group, setGroup] = useBrowserStorage<GroupKey>("gpu-power-group", "system")
	const [rows, setRows] = useState<GpuPowerDailyRecord[] | null>(null)

	const today = dayString(new Date())
	const from = range === "all" ? "" : addDays(today, -(Number(range) - 1))

	useEffect(() => {
		document.title = `${t`Power History`} / Beszel`
	}, [t])

	useEffect(() => {
		let cancelled = false
		function load() {
			pb.collection<GpuPowerDailyRecord>("gpu_power_daily")
				.getFullList({
					filter: from ? pb.filter("day >= {:from}", { from }) : "",
					sort: "day",
					fields: "system,system_name,gpu,name,day,energy_wh,max_w,seconds,busy_seconds,estimated,created",
					requestKey: "gpu-power-history",
				})
				.then((records) => {
					if (!cancelled) setRows(records)
				})
				.catch((error) => {
					if (!error?.isAbort) console.error(error)
				})
		}
		setRows(null)
		load()
		// rows grow every minute; the chart only needs to keep roughly current
		const interval = setInterval(load, 60_000)
		return () => {
			cancelled = true
			clearInterval(interval)
		}
	}, [from])

	const data = useMemo(() => {
		if (!rows) return null
		const days = rows.length ? daysBetween(from || rows[0].day, today) : []

		// per-device totals, grouped by server
		const deviceMap = new Map<string, DeviceTotals>()
		for (const row of rows) {
			const sKey = serverKey(row)
			const key = `${sKey}/${row.gpu}`
			let d = deviceMap.get(key)
			if (!d) {
				d = {
					key,
					server: serverName(row, systems),
					serverKey: sKey,
					device: row.gpu,
					model: "",
					energyWh: 0,
					seconds: 0,
					busySeconds: 0,
					maxW: 0,
					possibleSeconds: 0,
					estimated: false,
					removed: !row.system,
				}
				// a device counts from its first day in the range, so a newly added one (or the CPU,
				// recorded since the agent update) is not "missing" before that
				for (const day of daysBetween(row.day, today)) {
					d.possibleSeconds +=
						(day === row.day ? firstDaySeconds(row, today) : undefined) ?? possibleSeconds(day, today)
				}
				deviceMap.set(key, d)
			}
			if (!isCpu(row.gpu)) {
				// the agent appends the index to identical models ("GeForce RTX 3090 1"); the device column already shows it
				d.model = row.name?.replace(new RegExp(` ${row.gpu}$`), "") || d.model
			}
			d.energyWh += row.energy_wh
			d.seconds += row.seconds
			d.busySeconds += row.busy_seconds
			d.maxW = Math.max(d.maxW, row.max_w)
			d.estimated ||= row.estimated
		}
		const servers = new Map<string, ServerTotals>()
		for (const d of deviceMap.values()) {
			let s = servers.get(d.serverKey)
			if (!s) {
				s = { key: d.serverKey, name: d.server, devices: [], energyWh: 0 }
				servers.set(d.serverKey, s)
			}
			s.devices.push(d)
			s.energyWh += d.energyWh
		}
		const serverList = [...servers.values()].sort((a, b) => compareNames(a.name, b.name))
		for (const s of serverList) {
			s.devices.sort((a, b) => Number(isCpu(a.device)) - Number(isCpu(b.device)) || compareNames(a.device, b.device))
		}

		// chart series, in the same order as the table
		const seriesKey = (row: GpuPowerDailyRecord) => {
			if (group === "kind") return isCpu(row.gpu) ? "cpu" : "gpu"
			return group === "system" ? serverKey(row) : `${serverKey(row)}/${row.gpu}`
		}
		const hasCpu = rows.some((r) => isCpu(r.gpu))
		const series =
			group === "kind"
				? [{ key: "gpu", label: "GPU" }, ...(hasCpu ? [{ key: "cpu", label: "CPU" }] : [])]
				: group === "system"
					? serverList.map((s) => ({ key: s.key, label: s.name }))
					: serverList.flatMap((s) =>
							s.devices.map((d) => ({ key: d.key, label: `${s.name} · ${deviceLabel(d.device)}` }))
						)
		const colored = series.map((s, i) => ({ ...s, color: seriesColor(i) }))

		const byDay = new Map<string, ChartRow>(days.map((day) => [day, { day, values: {}, total: 0, estimated: false }]))
		let gpuWh = 0
		let cpuWh = 0
		let cpuStart = ""
		for (const row of rows) {
			if (isCpu(row.gpu)) {
				cpuWh += row.energy_wh
				if (!cpuStart || row.day < cpuStart) cpuStart = row.day
			} else {
				gpuWh += row.energy_wh
			}
			const point = byDay.get(row.day)
			if (!point) continue
			const key = seriesKey(row)
			point.values[key] = (point.values[key] ?? 0) + row.energy_wh / 1000
			point.total += row.energy_wh
			point.estimated ||= row.estimated
		}
		const chart = [...byDay.values()]
		const totalWh = gpuWh + cpuWh
		const daysWithData = chart.filter((p) => p.total > 0)
		const peak = daysWithData.reduce<ChartRow | null>((best, p) => (!best || p.total > best.total ? p : best), null)
		return {
			servers: serverList,
			series: colored,
			chart,
			totalWh,
			gpuWh,
			cpuWh,
			hasCpu,
			// the CPU started being recorded after the beginning of the shown range
			cpuStart: hasCpu && (!from || cpuStart > from) && cpuStart > (rows[0]?.day ?? "") ? cpuStart : "",
			dailyAvgWh: daysWithData.length ? totalWh / daysWithData.length : 0,
			peak,
			hasEstimated: rows.some((r) => r.estimated),
		}
	}, [rows, systems, group, from, today])

	const rangeLabels: Record<RangeKey, string> = {
		"7": t`Last 7 days`,
		"30": t`Last 30 days`,
		"90": t`Last 90 days`,
		"365": t`Last year`,
		all: t`All time`,
	}

	return (
		<>
			<div className="grid gap-4">
				<ActiveAlerts />
				<Card className="w-full px-3 py-5 sm:py-6 sm:px-6">
					<CardHeader className="p-0 mb-4">
						<div className="grid md:flex gap-x-5 gap-y-3 w-full items-end">
							<div className="px-2 sm:px-1">
								<CardTitle className="mb-2 flex items-center gap-2">
									<ZapIcon className="size-4" />
									<Trans>Power History</Trans>
								</CardTitle>
								<div className="text-sm text-muted-foreground">
									<Trans>
										Daily energy use of every GPU and CPU package, kept permanently. Days follow the hub's time
										zone.
									</Trans>
								</div>
							</div>
							<div className="md:ms-auto flex items-center gap-2">
								<Select value={group} onValueChange={(v) => setGroup(v as GroupKey)}>
									<SelectTrigger className="w-32">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="system">{t`By server`}</SelectItem>
										<SelectItem value="gpu">{t`By device`}</SelectItem>
										<SelectItem value="kind">{t`CPU vs GPU`}</SelectItem>
									</SelectContent>
								</Select>
								<Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
									<SelectTrigger className="w-36">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{(Object.keys(rangeLabels) as RangeKey[]).map((key) => (
											<SelectItem key={key} value={key}>
												{rangeLabels[key]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					</CardHeader>
					<CardContent className="p-0 grid gap-6">
						{!data ? (
							<div className="py-16 text-center text-sm text-muted-foreground">
								<Trans>Loading...</Trans>
							</div>
						) : data.servers.length === 0 ? (
							<div className="py-16 text-center text-sm text-muted-foreground">
								<Trans>No power data yet.</Trans>
							</div>
						) : (
							<>
								<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
									<StatTile
										label={t`Total energy`}
										value={`${formatKwh(data.totalWh)} kWh`}
										note={data.hasCpu ? `GPU ${formatKwh(data.gpuWh)} · CPU ${formatKwh(data.cpuWh)} kWh` : undefined}
									/>
									<StatTile label={t`Daily average`} value={`${formatKwh(data.dailyAvgWh)} kWh`} />
									<StatTile
										label={t`Highest day`}
										value={data.peak ? `${formatKwh(data.peak.total)} kWh` : "—"}
										note={data.peak?.day}
									/>
								</div>

								<div className="grid gap-2">
									<div className="text-sm font-medium px-1">
										<Trans>Daily energy (kWh)</Trans>
									</div>
									<ChartContainer className="h-72 w-full aspect-auto">
										<BarChart data={data.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
											<CartesianGrid vertical={false} />
											<XAxis
												dataKey="day"
												tickLine={false}
												axisLine={false}
												minTickGap={16}
												tickFormatter={(day: string) => day.slice(5)}
											/>
											<YAxis tickLine={false} axisLine={false} width={44} allowDecimals />
											<Tooltip
												cursor={{ fill: "var(--muted)", opacity: 0.5 }}
												content={<DayTooltip series={data.series} today={today} />}
											/>
											{data.series.map((s) => (
												<Bar
													key={s.key}
													dataKey={(p: ChartRow) => p.values[s.key] ?? 0}
													name={s.label}
													stackId="energy"
													fill={s.color}
													isAnimationActive={false}
												/>
											))}
										</BarChart>
									</ChartContainer>
									<div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
										{data.series.map((s) => (
											<span key={s.key} className="flex items-center gap-1.5">
												<span className="size-2.5 rounded-sm" style={{ background: s.color }} />
												{s.label}
											</span>
										))}
									</div>
								</div>

								<div className="overflow-x-auto">
									<Table className="min-w-[44rem]">
										<TableHeader>
											<TableRow>
												<TableHead>
													<Trans>Server</Trans> / <Trans>Device</Trans>
												</TableHead>
												<TableHead>
													<Trans>Model</Trans>
												</TableHead>
												<TableHead className="text-end">
													<Trans>Energy</Trans>
												</TableHead>
												<TableHead className="text-end">
													<Trans>Avg power</Trans>
												</TableHead>
												<TableHead className="text-end">
													<Trans>Peak power</Trans>
												</TableHead>
												<TableHead className="text-end">
													<Trans>Avg utilization</Trans>
												</TableHead>
												<TableHead className="text-end">
													<Trans>Coverage</Trans>
												</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{data.servers.map((s) => (
												<ServerRows key={s.key} server={s} removedLabel={t`Removed`} cpuModel={t`CPU package`} />
											))}
										</TableBody>
									</Table>
								</div>

								<div className="grid gap-1 px-1 text-xs text-muted-foreground">
									<p>
										<Trans>
											An estimate of machine use: CPU package and GPUs only. The motherboard, memory, disks, fans
											and power supply losses are not included, so the use at the outlet is higher.
										</Trans>
									</p>
									{data.cpuStart && (
										<p>
											<Trans>CPU power is recorded from {data.cpuStart}.</Trans>
										</p>
									)}
									<p>
										<Trans>
											Coverage is the share of the time the device was reporting. Lower values mean the server or
											agent was offline for part of the period.
										</Trans>
									</p>
									{data.hasEstimated && (
										<p>
											*{" "}
											<Trans>
												Estimated: filled in from older averaged statistics, so peaks and short gaps are not reflected.
											</Trans>
										</p>
									)}
								</div>
							</>
						)}
					</CardContent>
				</Card>
			</div>
			<FooterRepoLink />
		</>
	)
})

function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<div className="rounded-lg border px-4 py-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="text-xl font-semibold tabular-nums mt-1">{value}</div>
			{note && <div className="text-xs text-muted-foreground tabular-nums">{note}</div>}
		</div>
	)
}

function ServerRows({
	server,
	removedLabel,
	cpuModel,
}: {
	server: ServerTotals
	removedLabel: string
	cpuModel: string
}) {
	// server average power = sum of its devices' average power
	const avgW = server.devices.reduce((sum, d) => sum + (d.seconds ? (d.energyWh * 3600) / d.seconds : 0), 0)
	const coverage = server.devices.reduce((sum, d) => sum + (d.possibleSeconds ? d.seconds / d.possibleSeconds : 0), 0)
	const gpuCount = server.devices.filter((d) => !isCpu(d.device)).length
	const hasCpu = server.devices.some((d) => isCpu(d.device))
	return (
		<>
			<TableRow className="bg-muted/40 font-medium">
				<TableCell>
					{server.name}
					{server.devices[0]?.removed && (
						<span className="ms-2 text-xs font-normal text-muted-foreground">({removedLabel})</span>
					)}
				</TableCell>
				<TableCell className="text-muted-foreground font-normal">
					{gpuCount} GPU{hasCpu && " + CPU"}
				</TableCell>
				<TableCell className="text-end tabular-nums">{formatKwh(server.energyWh)} kWh</TableCell>
				<TableCell className="text-end tabular-nums">{formatWatts(avgW)}</TableCell>
				<TableCell className="text-end text-muted-foreground">—</TableCell>
				<TableCell className="text-end text-muted-foreground">—</TableCell>
				<TableCell className="text-end tabular-nums">{formatPercent(coverage / server.devices.length)}</TableCell>
			</TableRow>
			{server.devices.map((d) => (
				<TableRow key={d.key}>
					<TableCell className="ps-6">
						{deviceLabel(d.device)}
						{d.estimated && <span className="text-muted-foreground">*</span>}
					</TableCell>
					<TableCell className="text-muted-foreground">{isCpu(d.device) ? cpuModel : d.model}</TableCell>
					<TableCell className="text-end tabular-nums">{formatKwh(d.energyWh)} kWh</TableCell>
					<TableCell className="text-end tabular-nums">
						{d.seconds ? formatWatts((d.energyWh * 3600) / d.seconds) : "—"}
					</TableCell>
					<TableCell className="text-end tabular-nums">{formatWatts(d.maxW)}</TableCell>
					<TableCell className="text-end tabular-nums">
						{d.seconds ? formatPercent(d.busySeconds / d.seconds) : "—"}
					</TableCell>
					<TableCell
						className={cn(
							"text-end tabular-nums",
							d.possibleSeconds && d.seconds / d.possibleSeconds < 0.9 && "text-yellow-600 dark:text-yellow-400"
						)}
					>
						{d.possibleSeconds ? formatPercent(d.seconds / d.possibleSeconds) : "—"}
					</TableCell>
				</TableRow>
			))}
		</>
	)
}

function DayTooltip({
	active,
	payload,
	series,
	today,
}: TooltipProps<number, string> & { series: { key: string; label: string; color: string }[]; today: string }) {
	const { t } = useLingui()
	if (!active || !payload?.length) return null
	const point = payload[0].payload as ChartRow
	const items = series.filter((s) => (point.values[s.key] ?? 0) > 0)
	return (
		<div className="rounded-lg border bg-background px-3 py-2 text-xs shadow-md grid gap-1 min-w-44">
			<div className="font-medium">
				{point.day}
				{point.day === today && <span className="ms-1 text-muted-foreground">({t`Today, in progress`})</span>}
				{point.estimated && <span className="text-muted-foreground"> *</span>}
			</div>
			{items.map((s) => (
				<div key={s.key} className="flex items-center gap-2">
					<span className="size-2.5 rounded-sm" style={{ background: s.color }} />
					<span className="flex-1">{s.label}</span>
					<span className="tabular-nums">{formatKwh(point.values[s.key] * 1000)} kWh</span>
				</div>
			))}
			<div className="flex justify-between border-t pt-1 font-medium">
				<Trans>Total</Trans>
				<span className="tabular-nums">{formatKwh(point.total)} kWh</span>
			</div>
		</div>
	)
}
