// Persistent service usage reported by the Hub's service_usage_daily collection.
// These metrics are time integrals, not instantaneous GPU/CPU percentages.
import { useEffect, useMemo, useState } from "react"
import { useStore } from "@nanostores/react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FooterRepoLink } from "@/components/footer-repo-link"
import { pb } from "@/lib/api"
import { $allSystemsById } from "@/lib/stores"
import type { ServiceGPUActiveHourRecord, ServiceUsageDailyRecord } from "@/types"

type Metric = "cpu" | "gpu" | "vram" | "active"

function localMonth(date = new Date()) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
}
function monthAfter(month: string) {
	const [y, m] = month.split("-").map(Number)
	return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`
}
function hours(seconds: number) {
	return seconds / 3600
}
function format(value: number, digits = 2) {
	return value.toLocaleString(undefined, { maximumFractionDigits: digits })
}
interface UsageTotals {
	cpu: number
	gpu: number
	vram: number
	active: number
	observed: number
	cpuKnown: number
	gpuKnown: number
	samples: number
}
function emptyTotals(): UsageTotals {
	return { cpu: 0, gpu: 0, vram: 0, active: 0, observed: 0, cpuKnown: 0, gpuKnown: 0, samples: 0 }
}
function accumulate(target: UsageTotals, row: ServiceUsageDailyRecord) {
	target.cpu += hours(row.cpu_core_seconds || 0)
	target.gpu += hours(row.gpu_util_seconds || 0)
	target.vram += hours(row.vram_mib_seconds || 0) / 1024
	target.observed += hours(row.seconds || 0)
	target.cpuKnown += hours(row.cpu_known_seconds || 0)
	target.gpuKnown += hours(row.gpu_known_seconds || 0)
	target.samples += row.samples || 0
}
const metricDetails: Record<Metric, { label: string; unit: string }> = {
	cpu: { label: "CPU core-hours", unit: "core-h" },
	gpu: { label: "GPU utilization-equivalent hours", unit: "GPU-h" },
	vram: { label: "VRAM usage", unit: "GiB-h" },
	active: { label: "GPU active clock-hours", unit: "service-h" },
}

export default function ServicesAnalytics() {
	const systems = useStore($allSystemsById)
	const [month, setMonth] = useState(localMonth)
	const [service, setService] = useState("all")
	const [system, setSystem] = useState("all")
	const [metric, setMetric] = useState<Metric>("gpu")
	const [rows, setRows] = useState<ServiceUsageDailyRecord[]>([])
	const [activeRows, setActiveRows] = useState<ServiceGPUActiveHourRecord[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState("")

	useEffect(() => {
		document.title = "Services Analytics / Beszel"
	}, [])

	useEffect(() => {
		let active = true
		async function fetchRows() {
			try {
				const from = `${month}-01`
				const to = `${monthAfter(month)}-01`
				const [found, activeHours] = await Promise.all([
					pb.collection<ServiceUsageDailyRecord>("service_usage_daily").getFullList({
						filter: pb.filter("day >= {:from} && day < {:to}", { from, to }),
						sort: "day",
						fields: "id,system,system_name,service,day,seconds,cpu_core_seconds,cpu_known_seconds,gpu_util_seconds,gpu_known_seconds,vram_mib_seconds,samples",
						requestKey: "services-analytics",
					}),
					pb.collection<ServiceGPUActiveHourRecord>("service_gpu_active_hours").getFullList({
						filter: pb.filter("day >= {:from} && day < {:to}", { from, to }),
						sort: "day",
						fields: "id,system,system_name,service,day,hour_start",
						requestKey: "services-analytics-active-hours",
					}),
				])
				if (active) {
					setRows(found)
					setActiveRows(activeHours)
					setError("")
					setLoading(false)
				}
			} catch (e) {
				if (active && !(e as { isAbort?: boolean })?.isAbort) {
					setError("Could not load historical usage. Check the Hub logs and collection permissions.")
					setLoading(false)
				}
			}
		}
		setLoading(true)
		fetchRows()
		const timer = setInterval(fetchRows, 60_000)
		return () => {
			active = false
			clearInterval(timer)
		}
	}, [month])

	const services = useMemo(() => [...new Set([...rows, ...activeRows].map((r) => r.service))].sort(), [rows, activeRows])
	const hosts = useMemo(() => {
		const result = new Map<string, string>()
		for (const r of [...rows, ...activeRows]) {
			if (r.system) result.set(r.system, systems[r.system]?.name || r.system_name || r.system)
		}
		return [...result].sort((a, b) => a[1].localeCompare(b[1]))
	}, [rows, activeRows, systems])

	// Keep filters useful when changing the month.
	useEffect(() => { if (service !== "all" && !services.includes(service)) setService("all") }, [service, services])
	useEffect(() => { if (system !== "all" && !hosts.some(([id]) => id === system)) setSystem("all") }, [system, hosts])

	const filtered = useMemo(
		() => rows.filter((r) => (service === "all" || r.service === service) && (system === "all" || r.system === system)),
		[rows, service, system],
	)
	const filteredActive = useMemo(
		() => activeRows.filter((r) => (service === "all" || r.service === service) && (system === "all" || r.system === system)),
		[activeRows, service, system],
	)
	const summary = useMemo(() => {
		const totals = emptyTotals()
		const byDay = new Map<string, UsageTotals>()
		const byService = new Map<string, UsageTotals>()
		for (const row of filtered) {
			accumulate(totals, row)
			if (!byDay.has(row.day)) byDay.set(row.day, emptyTotals())
			accumulate(byDay.get(row.day)!, row)
			if (!byService.has(row.service)) byService.set(row.service, emptyTotals())
			accumulate(byService.get(row.service)!, row)
		}
		// Multiple replicas/hosts of the *same* service in the same clock-hour
		// count once when viewing all servers; distinct services count separately.
		const seen = new Set<string>()
		for (const row of filteredActive) {
			const key = JSON.stringify([row.service, row.hour_start])
			if (seen.has(key)) continue
			seen.add(key)
			totals.active += 1
			if (!byDay.has(row.day)) byDay.set(row.day, emptyTotals())
			byDay.get(row.day)!.active += 1
			if (!byService.has(row.service)) byService.set(row.service, emptyTotals())
			byService.get(row.service)!.active += 1
		}
		return {
			totals,
			days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day: day.slice(5), ...values })),
			services: [...byService.entries()].sort(([, a], [, b]) => b.gpu - a.gpu),
		}
	}, [filtered, filteredActive])

	return (
		<div className="space-y-5 pb-8">
			<div className="flex flex-wrap justify-between gap-4 items-end">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Services Analytics</h1>
					<p className="text-sm text-muted-foreground">Permanent daily CPU / GPU usage, grouped by service and server.</p>
				</div>
				<div className="flex flex-wrap gap-2 items-center">
					<label className="text-xs text-muted-foreground" htmlFor="services-analytics-month">Month</label>
					<input id="services-analytics-month" type="month" value={month} max={localMonth()} onChange={(e) => { if (e.target.value) setMonth(e.target.value) }} className="h-9 rounded-md border bg-background px-3 text-sm" />
					<Select value={service} onValueChange={setService}>
						<SelectTrigger className="w-48"><SelectValue placeholder="All services" /></SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All services</SelectItem>
							{services.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
						</SelectContent>
					</Select>
					<Select value={system} onValueChange={setSystem}>
						<SelectTrigger className="w-44"><SelectValue placeholder="All servers" /></SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All servers</SelectItem>
							{hosts.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
						</SelectContent>
					</Select>
				</div>
			</div>
			{error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>}
			{loading ? <p className="py-12 text-center text-muted-foreground">Loading service history…</p> : (
				<>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
						{([
							["CPU", summary.totals.cpu, "core-hours"],
							["GPU", summary.totals.gpu, "utilization-equivalent hours"],
							["GPU active hours", summary.totals.active, "active service-hour buckets"],
							["VRAM", summary.totals.vram, "GiB-hours"],
							["Recorded", summary.totals.observed, "service-hours"],
						] as const).map(([title, amount, unit]) => (
							<Card key={title}><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{title}</CardTitle></CardHeader>
								<CardContent><p className="text-2xl font-semibold tabular-nums">{format(amount)}</p><p className="text-xs text-muted-foreground">{unit}</p></CardContent></Card>
						))}
					</div>
					<Card>
						<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
							<CardTitle className="text-base">Daily usage</CardTitle>
							<Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
								<SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
								<SelectContent>{(Object.keys(metricDetails) as Metric[]).map((key) => (
									<SelectItem key={key} value={key}>{metricDetails[key].label}</SelectItem>
								))}</SelectContent>
							</Select>
						</CardHeader>
						<CardContent>
							{summary.days.length ? <div className="h-72 w-full">
								<ResponsiveContainer width="100%" height="100%">
									<BarChart data={summary.days} margin={{ top: 8, right: 12, bottom: 8, left: 4 }}>
										<CartesianGrid vertical={false} strokeDasharray="3 3" />
										<XAxis dataKey="day" tick={{ fontSize: 12 }} />
										<YAxis tick={{ fontSize: 12 }} width={60} />
										<Tooltip formatter={(value) => [`${format(Number(value), metric === "active" ? 0 : 2)} ${metricDetails[metric].unit}`, metricDetails[metric].label]} />
										<Bar dataKey={metric} name={metricDetails[metric].label} fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
									</BarChart>
								</ResponsiveContainer>
							</div> : <p className="py-12 text-center text-sm text-muted-foreground">No usage records for this month. History starts after the Hub begins collecting service samples.</p>}
						</CardContent>
					</Card>
					<Card>
						<CardHeader><CardTitle className="text-base">Usage by service</CardTitle></CardHeader>
						<CardContent>
							<div className="overflow-x-auto">
								<Table>
									<TableHeader><TableRow><TableHead>Service</TableHead><TableHead className="text-right">CPU core-h</TableHead><TableHead className="text-right">GPU-h</TableHead><TableHead className="text-right">Active GPU h</TableHead><TableHead className="text-right">VRAM GiB-h</TableHead><TableHead className="text-right">CPU measured (h)</TableHead><TableHead className="text-right">GPU measured (h)</TableHead></TableRow></TableHeader>
									<TableBody>
										{summary.services.map(([name, totals]) => (
											<TableRow key={name}><TableCell className="font-medium">{name}</TableCell><TableCell className="text-right tabular-nums">{format(totals.cpu)}</TableCell><TableCell className="text-right tabular-nums">{format(totals.gpu)}</TableCell><TableCell className="text-right tabular-nums">{format(totals.active, 0)}</TableCell><TableCell className="text-right tabular-nums">{format(totals.vram)}</TableCell><TableCell className="text-right tabular-nums">{format(totals.cpuKnown)}</TableCell><TableCell className="text-right tabular-nums">{format(totals.gpuKnown)}</TableCell></TableRow>
										))}
										{!summary.services.length && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No services recorded.</TableCell></TableRow>}
									</TableBody>
								</Table>
							</div>
							<p className="mt-4 text-xs text-muted-foreground">
								CPU core-hours are measured from host-normalized container CPU share × logical CPUs × elapsed time. GPU-h measures sampled process utilization, not reserved GPU allocation time. GPU active hours count one whole local clock-hour for each service with any observed GPU process / VRAM / utilization in that hour, even if active for only a few seconds. Replicas on multiple hosts in the same hour count once when all servers are selected. This is not actual runtime, reservation time or a billing metric. Empty days indicate missing data, not zero usage. Data prior to enabling collection cannot be restored automatically. All totals are estimates at the monitor sampling cadence.
							</p>
						</CardContent>
					</Card>
				</>
			)}
			<FooterRepoLink />
		</div>
	)
}
