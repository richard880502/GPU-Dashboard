// gpu-monitoring fork addition (not upstream): daily GPU energy history from
// the permanent gpu_power_daily collection.
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
type GroupKey = "system" | "gpu"

const DAY_SECONDS = 86400

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

/** seconds a GPU could have reported on `day` (today: only the part already gone by) */
function possibleSeconds(day: string, today: string) {
	if (day !== today) return DAY_SECONDS
	const now = new Date()
	return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
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

function serverKey(row: GpuPowerDailyRecord) {
	return row.system || `removed:${row.system_name}`
}

function serverName(row: GpuPowerDailyRecord, systems: Record<string, SystemRecord>) {
	return systems[row.system]?.name || row.system_name || "?"
}

interface GpuTotals {
	key: string
	server: string
	serverKey: string
	gpu: string
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
	gpus: GpuTotals[]
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
		document.title = `${t`GPU Power History`} / Beszel`
	}, [t])

	useEffect(() => {
		let cancelled = false
		function load() {
			pb.collection<GpuPowerDailyRecord>("gpu_power_daily")
				.getFullList({
					filter: from ? pb.filter("day >= {:from}", { from }) : "",
					sort: "day",
					fields: "system,system_name,gpu,name,day,energy_wh,max_w,seconds,busy_seconds,estimated",
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

		// per-GPU totals, grouped by server
		const gpuMap = new Map<string, GpuTotals>()
		for (const row of rows) {
			const sKey = serverKey(row)
			const key = `${sKey}/${row.gpu}`
			let g = gpuMap.get(key)
			if (!g) {
				g = {
					key,
					server: serverName(row, systems),
					serverKey: sKey,
					gpu: row.gpu,
					model: "",
					energyWh: 0,
					seconds: 0,
					busySeconds: 0,
					maxW: 0,
					possibleSeconds: 0,
					estimated: false,
					removed: !row.system,
				}
				// a GPU counts from its first day in the range, so a newly added one is not "missing" before that
				for (const d of daysBetween(row.day, today)) {
					g.possibleSeconds += possibleSeconds(d, today)
				}
				gpuMap.set(key, g)
			}
			// the agent appends the index to identical models ("GeForce RTX 3090 1"); the GPU column already shows it
			g.model = row.name?.replace(new RegExp(` ${row.gpu}$`), "") || g.model
			g.energyWh += row.energy_wh
			g.seconds += row.seconds
			g.busySeconds += row.busy_seconds
			g.maxW = Math.max(g.maxW, row.max_w)
			g.estimated ||= row.estimated
		}
		const servers = new Map<string, ServerTotals>()
		for (const g of gpuMap.values()) {
			let s = servers.get(g.serverKey)
			if (!s) {
				s = { key: g.serverKey, name: g.server, gpus: [], energyWh: 0 }
				servers.set(g.serverKey, s)
			}
			s.gpus.push(g)
			s.energyWh += g.energyWh
		}
		const serverList = [...servers.values()].sort((a, b) => compareNames(a.name, b.name))
		for (const s of serverList) {
			s.gpus.sort((a, b) => compareNames(a.gpu, b.gpu))
		}

		// chart series, in the same order as the table
		const series =
			group === "system"
				? serverList.map((s) => ({ key: s.key, label: s.name }))
				: serverList.flatMap((s) => s.gpus.map((g) => ({ key: g.key, label: `${s.name} · GPU ${g.gpu}` })))
		const colored = series.map((s, i) => ({ ...s, color: seriesColor(i) }))

		const byDay = new Map<string, ChartRow>(days.map((day) => [day, { day, values: {}, total: 0, estimated: false }]))
		for (const row of rows) {
			const point = byDay.get(row.day)
			if (!point) continue
			const sKey = serverKey(row)
			const key = group === "system" ? sKey : `${sKey}/${row.gpu}`
			point.values[key] = (point.values[key] ?? 0) + row.energy_wh / 1000
			point.total += row.energy_wh
			point.estimated ||= row.estimated
		}
		const chart = [...byDay.values()]
		const totalWh = serverList.reduce((sum, s) => sum + s.energyWh, 0)
		const daysWithData = chart.filter((p) => p.total > 0)
		const peak = daysWithData.reduce<ChartRow | null>((best, p) => (!best || p.total > best.total ? p : best), null)
		return {
			servers: serverList,
			series: colored,
			chart,
			totalWh,
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
									<Trans>GPU Power History</Trans>
								</CardTitle>
								<div className="text-sm text-muted-foreground">
									<Trans>Daily energy use of every GPU, kept permanently. Days follow the hub's time zone.</Trans>
								</div>
							</div>
							<div className="md:ms-auto flex items-center gap-2">
								<Select value={group} onValueChange={(v) => setGroup(v as GroupKey)}>
									<SelectTrigger className="w-32">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="system">{t`By server`}</SelectItem>
										<SelectItem value="gpu">{t`By GPU`}</SelectItem>
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
								<Trans>No GPU power data yet.</Trans>
							</div>
						) : (
							<>
								<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
									<StatTile label={t`Total energy`} value={`${formatKwh(data.totalWh)} kWh`} />
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
													<Trans>Server</Trans> / GPU
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
												<ServerRows key={s.key} server={s} removedLabel={t`Removed`} />
											))}
										</TableBody>
									</Table>
								</div>

								<div className="grid gap-1 px-1 text-xs text-muted-foreground">
									<p>
										<Trans>
											Coverage is the share of the time the GPU was reporting. Lower values mean the server or agent
											was offline for part of the period.
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

function ServerRows({ server, removedLabel }: { server: ServerTotals; removedLabel: string }) {
	// server average power = sum of its GPUs' average power
	const avgW = server.gpus.reduce((sum, g) => sum + (g.seconds ? (g.energyWh * 3600) / g.seconds : 0), 0)
	const coverage = server.gpus.reduce((sum, g) => sum + (g.possibleSeconds ? g.seconds / g.possibleSeconds : 0), 0)
	return (
		<>
			<TableRow className="bg-muted/40 font-medium">
				<TableCell>
					{server.name}
					{server.gpus[0]?.removed && (
						<span className="ms-2 text-xs font-normal text-muted-foreground">({removedLabel})</span>
					)}
				</TableCell>
				<TableCell className="text-muted-foreground font-normal">{server.gpus.length} GPU</TableCell>
				<TableCell className="text-end tabular-nums">{formatKwh(server.energyWh)} kWh</TableCell>
				<TableCell className="text-end tabular-nums">{formatWatts(avgW)}</TableCell>
				<TableCell className="text-end text-muted-foreground">—</TableCell>
				<TableCell className="text-end text-muted-foreground">—</TableCell>
				<TableCell className="text-end tabular-nums">{formatPercent(coverage / server.gpus.length)}</TableCell>
			</TableRow>
			{server.gpus.map((g) => (
				<TableRow key={g.key}>
					<TableCell className="ps-6">
						GPU {g.gpu}
						{g.estimated && <span className="text-muted-foreground">*</span>}
					</TableCell>
					<TableCell className="text-muted-foreground">{g.model}</TableCell>
					<TableCell className="text-end tabular-nums">{formatKwh(g.energyWh)} kWh</TableCell>
					<TableCell className="text-end tabular-nums">
						{g.seconds ? formatWatts((g.energyWh * 3600) / g.seconds) : "—"}
					</TableCell>
					<TableCell className="text-end tabular-nums">{formatWatts(g.maxW)}</TableCell>
					<TableCell className="text-end tabular-nums">
						{g.seconds ? formatPercent(g.busySeconds / g.seconds) : "—"}
					</TableCell>
					<TableCell
						className={cn(
							"text-end tabular-nums",
							g.possibleSeconds && g.seconds / g.possibleSeconds < 0.9 && "text-yellow-600 dark:text-yellow-400"
						)}
					>
						{g.possibleSeconds ? formatPercent(g.seconds / g.possibleSeconds) : "—"}
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
