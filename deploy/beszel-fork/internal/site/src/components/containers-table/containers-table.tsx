/** biome-ignore-all lint/security/noDangerouslySetInnerHtml: html comes directly from docker via agent */
import { t } from "@lingui/core/macro"
import { Trans } from "@lingui/react/macro"
import {
	type ColumnFiltersState,
	type ColumnSizingState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type Row,
	type SortingState,
	type Table as TableType,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table"
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual"
import { memo, type RefObject, useEffect, useMemo, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { TableBody, TableCell, TableRow } from "@/components/ui/table"
import { ResizableTableColGroup, ResizableTableHead, getColumnWidthStyle, useColumnSizeVars } from "@/components/ui/resizable-table"
import { pb } from "@/lib/api"
import type { ContainerRecord } from "@/types"
import { containerChartCols } from "@/components/containers-table/containers-table-columns"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { type ContainerHealth, ContainerHealthLabels } from "@/lib/enums"
import { cn, getServerDotColor, useBrowserStorage } from "@/lib/utils"
import { Sheet, SheetTitle, SheetHeader, SheetContent, SheetDescription } from "../ui/sheet"
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog"
import { Button } from "@/components/ui/button"
import { $allSystemsById } from "@/lib/stores"
import { ChevronDownIcon, ChevronUpIcon, LoaderCircleIcon, MaximizeIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { Separator } from "../ui/separator"
import { $router, Link } from "../router"
import { listenKeys } from "nanostores"
import { getPagePath } from "@nanostores/router"

const syntaxTheme = "github-dark-dimmed"

export default function ContainersTable({ systemId }: { systemId?: string }) {
	const loadTime = Date.now()
	const [data, setData] = useState<ContainerRecord[] | undefined>(undefined)
	const [sorting, setSorting] = useBrowserStorage<SortingState>(
		`sort-c-${systemId ? 1 : 0}`,
		[{ id: systemId ? "name" : "gpuMem", desc: false }],
		sessionStorage
	)
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
	const [columnSizing, setColumnSizing] = useBrowserStorage<ColumnSizingState>(`colsize-c-${systemId ? 1 : 0}`, {})

	// Hide ports column if no ports are present
	useEffect(() => {
		if (data) {
			const hasPorts = data.some((container) => container.ports)
			setColumnVisibility((prev) => {
				if (prev.ports === hasPorts) {
					return prev
				}
				return { ...prev, ports: hasPorts }
			})
		}
	}, [data])

	const [rowSelection, setRowSelection] = useState({})
	const [globalFilter, setGlobalFilter] = useState("")

	useEffect(() => {
		function fetchData(systemId?: string) {
			pb.collection<ContainerRecord>("containers")
				.getList(0, 2000, {
					fields:
						"id,name,image,updatable,ports,cpu,memory,net,health,status,system,updated,gpuPid,gpuMemMiB,gpuMemPercent,gpuUtilPercent",
					filter: systemId ? pb.filter("system={:system}", { system: systemId }) : undefined,
				})
				.then(({ items }) => {
					if (items.length === 0) {
						setData((curItems) => {
							if (systemId) {
								return curItems?.filter((item) => item.system !== systemId) ?? []
							}
							return []
						})
						return
					}
					setData((curItems) => {
						const lastUpdated = Math.max(items[0].updated, items.at(-1)?.updated ?? 0)
						const containerIds = new Set()
						const newItems: ContainerRecord[] = []
						for (const item of items) {
							if (Math.abs(lastUpdated - item.updated) < 70_000) {
								containerIds.add(item.id)
								newItems.push(item)
							}
						}
						for (const item of curItems ?? []) {
							if (!containerIds.has(item.id) && lastUpdated - item.updated < 70_000) {
								newItems.push(item)
							}
						}
						return newItems
					})
				})
		}

		// initial load
		fetchData(systemId)

		// if no systemId, pull system containers after every system update
		if (!systemId) {
			return $allSystemsById.listen((_value, _oldValue, systemId) => {
				// exclude initial load of systems
				if (Date.now() - loadTime > 500) {
					fetchData(systemId)
				}
			})
		}

		// if systemId, fetch containers after the system is updated
		return listenKeys($allSystemsById, [systemId], (_newSystems) => {
			fetchData(systemId)
		})
	}, [])

	const table = useReactTable({
		data: data ?? [],
		columns: containerChartCols.filter((col) => (systemId ? col.id !== "system" : true)),
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		onColumnVisibilityChange: setColumnVisibility,
		onColumnSizingChange: setColumnSizing,
		onRowSelectionChange: setRowSelection,
		columnResizeMode: "onChange",
		defaultColumn: {
			sortUndefined: "last",
			size: 100,
			minSize: 50,
			maxSize: 600,
		},
		state: {
			sorting,
			columnFilters,
			columnVisibility,
			columnSizing,
			rowSelection,
			globalFilter,
		},
		onGlobalFilterChange: setGlobalFilter,
		globalFilterFn: (row, _columnId, filterValue) => {
			const container = row.original
			const systemName = $allSystemsById.get()[container.system]?.name ?? ""
			const id = container.id ?? ""
			const name = container.name ?? ""
			const status = container.status ?? ""
			const healthLabel = ContainerHealthLabels[container.health as ContainerHealth] ?? ""
			const image = container.image ?? ""
			const ports = container.ports ?? ""
			const searchString = `${systemName} ${id} ${name} ${healthLabel} ${status} ${image} ${ports}`.toLowerCase()

			return (filterValue as string)
				.toLowerCase()
				.split(" ")
				.every((term) => searchString.includes(term))
		},
	})

	const rows = table.getRowModel().rows
	const visibleColumns = table.getVisibleLeafColumns()

	return (
		<Card className="@container w-full px-3 py-5 sm:py-6 sm:px-6">
			<CardHeader className="p-0 mb-3 sm:mb-4">
				<div className="grid md:flex gap-x-5 gap-y-3 w-full items-end">
					<div className="px-2 sm:px-1">
						<CardTitle className="mb-2">
							<Trans>All Containers</Trans>
						</CardTitle>
						<CardDescription className="flex">
							<Trans>Click on a container to view more information.</Trans>
						</CardDescription>
					</div>
					<div className="relative ms-auto w-full max-w-full md:w-64">
						<Input
							placeholder={t`Filter...`}
							value={globalFilter}
							onChange={(e) => setGlobalFilter(e.target.value)}
							className="ps-4 pe-10 w-full"
						/>
						{globalFilter && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={t`Clear`}
								className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground"
								onClick={() => setGlobalFilter("")}
							>
								<XIcon className="h-4 w-4" />
							</Button>
						)}
					</div>
				</div>
			</CardHeader>
			<div className="rounded-md">
				<AllContainersTable
					table={table}
					rows={rows}
					colLength={visibleColumns.length}
					data={data}
					columnSizing={columnSizing}
				/>
			</div>
		</Card>
	)
}

const AllContainersTable = memo(function AllContainersTable({
	table,
	rows,
	colLength,
	data,
	columnSizing,
}: {
	table: TableType<ContainerRecord>
	rows: Row<ContainerRecord>[]
	colLength: number
	data: ContainerRecord[] | undefined
	columnSizing: ColumnSizingState
}) {
	// The virtualizer will need a reference to the scrollable container element
	const scrollRef = useRef<HTMLDivElement>(null)
	const activeContainer = useRef<ContainerRecord | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)
	const openSheet = (container: ContainerRecord) => {
		activeContainer.current = container
		setSheetOpen(true)
	}

	const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
		count: rows.length,
		estimateSize: () => 54,
		getScrollElement: () => scrollRef.current,
		overscan: 5,
	})
	const virtualRows = virtualizer.getVirtualItems()

	const paddingTop = Math.max(0, virtualRows[0]?.start ?? 0 - virtualizer.options.scrollMargin)
	const paddingBottom = Math.max(0, virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0))

	const columnSizeVars = useColumnSizeVars(table, columnSizing, "container-col")

	return (
		<div
			className={cn(
				"h-min max-h-[calc(100dvh-17rem)] max-w-full relative overflow-auto border rounded-md",
				// don't set min height if there are less than 2 rows, do set if we need to display the empty state
				(!rows.length || rows.length > 2) && "min-h-50"
			)}
			ref={scrollRef}
			style={columnSizeVars}
		>
			{/* add header height to table size */}
			<div style={{ height: `${virtualizer.getTotalSize() + 48}px`, paddingTop, paddingBottom }}>
				<table
					className="text-sm h-full text-nowrap table-fixed"
					style={{
						width: table.getTotalSize(),
						minWidth: table.getTotalSize(),
						maxWidth: table.getTotalSize(),
					}}
				>
					<ResizableTableColGroup table={table} prefix="container-col" />
					<ResizableTableHead table={table} prefix="container-col" />
					<TableBody>
						{rows.length ? (
							virtualRows.map((virtualRow) => {
								const row = rows[virtualRow.index]
								return <ContainerTableRow key={row.id} row={row} virtualRow={virtualRow} openSheet={openSheet} />
							})
						) : (
							<TableRow>
								<TableCell colSpan={colLength} className="h-37 text-center pointer-events-none">
									{data ? (
										<Trans>No results.</Trans>
									) : (
										<LoaderCircleIcon className="animate-spin size-10 opacity-60 mx-auto" />
									)}
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</table>
			</div>
			<ContainerSheet sheetOpen={sheetOpen} setSheetOpen={setSheetOpen} activeContainer={activeContainer} />
		</div>
	)
})

// Returns both the shiki-highlighted HTML (the default view) and the raw
// text (kept around so a search can run over real log content instead of
// shiki's generated markup).
async function getLogs(container: ContainerRecord): Promise<{ html: string; raw: string }> {
	try {
		const [{ highlighter }, logsResp] = await Promise.all([
			import("@/lib/shiki"),
			pb.send<{ logs: string }>("/api/beszel/containers/logs", {
				system: container.system,
				container: container.id,
			}),
		])
		const raw = logsResp.logs ?? ""
		const html = raw ? highlighter.codeToHtml(raw, { lang: "log", theme: syntaxTheme }) : t`No results.`
		return { html, raw }
	} catch (error) {
		console.error(error)
		return { html: "", raw: "" }
	}
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Renders raw log text (not shiki's markup -- searching that would mean
// matching against syntax-highlighting <span> tags) as escaped, whitespace-
// preserving HTML with every case-insensitive match of `query` wrapped in a
// <mark>, the `activeIndex`-th one flagged so callers can scroll to it.
function highlightLogMatches(raw: string, query: string, activeIndex: number): { html: string; count: number } {
	const matches = raw.match(new RegExp(escapeRegExp(query), "gi"))
	if (!matches) {
		return { html: escapeHtml(raw), count: 0 }
	}
	const parts = raw.split(new RegExp(escapeRegExp(query), "gi"))
	let html = ""
	parts.forEach((part, i) => {
		html += escapeHtml(part)
		if (i < matches.length) {
			const current = i === activeIndex
			html += `<mark class="rounded-sm px-0.5 ${
				current ? "log-match-current bg-orange-400 text-black" : "bg-yellow-400/60 text-black"
			}">${escapeHtml(matches[i])}</mark>`
		}
	})
	return { html, count: matches.length }
}

function LogSearchBar({
	search,
	setSearch,
	matchCount,
	activeMatch,
	onNavigate,
}: {
	search: string
	setSearch: (value: string) => void
	matchCount: number
	activeMatch: number
	onNavigate: (dir: 1 | -1) => void
}) {
	return (
		<div className="relative flex-1 max-w-64 flex items-center gap-1 min-w-0">
			<Input
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault()
						onNavigate(e.shiftKey ? -1 : 1)
					}
				}}
				placeholder={t`Search logs...`}
				className="h-8 pe-7"
			/>
			{search && (
				<button
					type="button"
					onClick={() => setSearch("")}
					className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100"
					aria-label={t`Clear search`}
				>
					<XIcon className="size-3.5" />
				</button>
			)}
			{search.trim() && (
				<div className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums shrink-0">
					<button
						type="button"
						onClick={() => onNavigate(-1)}
						disabled={matchCount === 0}
						className="p-1 opacity-70 hover:opacity-100 disabled:opacity-30"
						aria-label={t`Previous match`}
					>
						<ChevronUpIcon className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={() => onNavigate(1)}
						disabled={matchCount === 0}
						className="p-1 opacity-70 hover:opacity-100 disabled:opacity-30"
						aria-label={t`Next match`}
					>
						<ChevronDownIcon className="size-3.5" />
					</button>
					<span className="min-w-11 text-center">{matchCount ? `${activeMatch + 1}/${matchCount}` : "0/0"}</span>
				</div>
			)}
		</div>
	)
}

async function getInfoHtml(container: ContainerRecord): Promise<{ html: string; pid?: number }> {
	try {
		let [{ highlighter }, { info }] = await Promise.all([
			import("@/lib/shiki"),
			pb.send<{ info: string }>("/api/beszel/containers/info", {
				system: container.system,
				container: container.id,
			}),
		])
		let pid: number | undefined
		try {
			const parsed = JSON.parse(info)
			pid = parsed?.State?.Pid || undefined
			info = JSON.stringify(parsed, null, 2)
		} catch (_) {}
		const html = info ? highlighter.codeToHtml(info, { lang: "json", theme: syntaxTheme }) : t`No results.`
		return { html, pid }
	} catch (error) {
		console.error(error)
		return { html: "" }
	}
}

export function ContainerSheet({
	sheetOpen,
	setSheetOpen,
	activeContainer,
}: {
	sheetOpen: boolean
	setSheetOpen: (open: boolean) => void
	activeContainer: RefObject<ContainerRecord | null>
}) {
	const [logsHtml, setLogsHtml] = useState<string>("")
	const [logsRaw, setLogsRaw] = useState<string>("")
	const [logsSearch, setLogsSearch] = useState<string>("")
	const [activeMatch, setActiveMatch] = useState<number>(0)
	const [infoDisplay, setInfoDisplay] = useState<string>("")
	const [pid, setPid] = useState<number | undefined>(undefined)
	const [logsFullscreenOpen, setLogsFullscreenOpen] = useState<boolean>(false)
	const [infoFullscreenOpen, setInfoFullscreenOpen] = useState<boolean>(false)
	const [isRefreshingLogs, setIsRefreshingLogs] = useState<boolean>(false)
	const logsContainerRef = useRef<HTMLDivElement>(null)

	const container = activeContainer.current

	const { html: searchHtml, count: matchCount } = useMemo(
		() => (logsSearch.trim() ? highlightLogMatches(logsRaw, logsSearch.trim(), activeMatch) : { html: "", count: 0 }),
		[logsRaw, logsSearch, activeMatch]
	)
	const logsDisplay = logsSearch.trim() ? searchHtml : logsHtml

	const navigateMatch = (dir: 1 | -1) => {
		setActiveMatch((i) => (matchCount ? (i + dir + matchCount) % matchCount : 0))
	}

	function scrollLogsToBottom() {
		if (logsContainerRef.current) {
			logsContainerRef.current.scrollTo({ top: logsContainerRef.current.scrollHeight })
		}
	}

	// While a search is active, follow the current match instead of pinning
	// to the bottom of the log.
	useEffect(() => {
		if (!logsSearch.trim()) return
		logsContainerRef.current?.querySelector(".log-match-current")?.scrollIntoView({ block: "center" })
	}, [logsDisplay, logsSearch])

	useEffect(() => {
		setActiveMatch(0)
	}, [logsSearch])

	const refreshLogs = async () => {
		if (!container) return
		setIsRefreshingLogs(true)
		const startTime = Date.now()

		try {
			const logs = await getLogs(container)
			setLogsHtml(logs.html)
			setLogsRaw(logs.raw)
			if (!logsSearch.trim()) {
				setTimeout(scrollLogsToBottom, 20)
			}
		} catch (error) {
			console.error(error)
		} finally {
			// Ensure minimum spin duration of 800ms
			const elapsed = Date.now() - startTime
			const remaining = Math.max(0, 500 - elapsed)
			setTimeout(() => {
				setIsRefreshingLogs(false)
			}, remaining)
		}
	}

	useEffect(() => {
		setLogsHtml("")
		setLogsRaw("")
		setLogsSearch("")
		setInfoDisplay("")
		setPid(undefined)
		if (!container) return
		;(async () => {
			const [logs, info] = await Promise.all([getLogs(container), getInfoHtml(container)])
			setLogsHtml(logs.html)
			setLogsRaw(logs.raw)
			setInfoDisplay(info.html)
			setPid(info.pid)
			setTimeout(scrollLogsToBottom, 20)
		})()
	}, [container])

	if (!container) return null

	return (
		<>
			<LogsFullscreenDialog
				open={logsFullscreenOpen}
				onOpenChange={setLogsFullscreenOpen}
				logsDisplay={logsDisplay}
				containerName={container.name}
				onRefresh={refreshLogs}
				isRefreshing={isRefreshingLogs}
				search={logsSearch}
				setSearch={setLogsSearch}
				matchCount={matchCount}
				activeMatch={activeMatch}
				onNavigate={navigateMatch}
			/>
			<InfoFullscreenDialog
				open={infoFullscreenOpen}
				onOpenChange={setInfoFullscreenOpen}
				infoDisplay={infoDisplay}
				containerName={container.name}
			/>
			<Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
				<SheetContent className="w-full sm:max-w-220 p-2">
					<SheetHeader>
						<SheetTitle>{container.name}</SheetTitle>
						<SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<Link
								className="hover:underline font-medium inline-flex items-center gap-1.5"
								href={getPagePath($router, "system", { id: container.system })}
							>
								<span
									className={cn(
										"inline-block size-1.5 rounded-full shrink-0",
										getServerDotColor(
											$allSystemsById.get()[container.system]?.name ?? "",
											Object.values($allSystemsById.get()).map((s) => s.name)
										)
									)}
								/>
								{$allSystemsById.get()[container.system]?.name ?? ""}
							</Link>
							<Separator orientation="vertical" className="h-2.5 bg-muted-foreground opacity-70" />
							{container.status}
							<Separator orientation="vertical" className="h-2.5 bg-muted-foreground opacity-70" />
							{container.image}
							<Separator orientation="vertical" className="h-2.5 bg-muted-foreground opacity-70" />
							{container.id}
							{pid !== undefined && (
								<>
									<Separator orientation="vertical" className="h-2.5 bg-muted-foreground opacity-70" />
									PID {pid}
								</>
							)}
							{/* {container.ports && (
								<>
									<Separator orientation="vertical" className="h-2.5 bg-muted-foreground opacity-70" />
									{container.ports}
								</>
							)} */}
							{/* <Separator orientation="vertical" className="h-2.5 bg-muted-foreground opacity-70" />
							{ContainerHealthLabels[container.health as ContainerHealth]} */}
						</SheetDescription>
					</SheetHeader>
					<div className="px-3 pb-3 -mt-4 flex flex-col gap-3 h-full items-start">
						<div className="flex items-center w-full gap-2">
							<h3 className="shrink-0">{t`Logs`}</h3>
							<LogSearchBar
								search={logsSearch}
								setSearch={setLogsSearch}
								matchCount={matchCount}
								activeMatch={activeMatch}
								onNavigate={navigateMatch}
							/>
							<Button
								variant="ghost"
								size="sm"
								onClick={refreshLogs}
								className="h-8 w-8 p-0 ms-auto"
								disabled={isRefreshingLogs}
							>
								<RefreshCwIcon
									className={`size-4 transition-transform duration-300 ${isRefreshingLogs ? "animate-spin" : ""}`}
								/>
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setLogsFullscreenOpen(true)} className="h-8 w-8 p-0">
								<MaximizeIcon className="size-4" />
							</Button>
						</div>
						<div
							ref={logsContainerRef}
							className={cn(
								"max-h-[calc(50dvh-10rem)] w-full overflow-auto p-3 rounded-md bg-gh-dark text-white text-sm",
								logsSearch.trim() && "whitespace-pre-wrap font-mono",
								!logsDisplay && ["animate-pulse", "h-full"]
							)}
						>
							<div dangerouslySetInnerHTML={{ __html: logsDisplay }} />
						</div>
						<div className="flex items-center w-full">
							<h3>{t`Detail`}</h3>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setInfoFullscreenOpen(true)}
								className="h-8 w-8 p-0 ms-auto"
							>
								<MaximizeIcon className="size-4" />
							</Button>
						</div>
						<div
							className={cn(
								"grow h-[calc(50dvh-4rem)] w-full overflow-auto p-3 rounded-md bg-gh-dark text-white text-sm",
								!infoDisplay && "animate-pulse"
							)}
						>
							<div dangerouslySetInnerHTML={{ __html: infoDisplay }} />
						</div>
					</div>
				</SheetContent>
			</Sheet>
		</>
	)
}

const ContainerTableRow = memo(function ContainerTableRow({
	row,
	virtualRow,
	openSheet,
}: {
	row: Row<ContainerRecord>
	virtualRow: VirtualItem
	openSheet: (container: ContainerRecord) => void
}) {
	return (
		<TableRow
			data-state={row.getIsSelected() && "selected"}
			className="cursor-pointer transition-opacity"
			onClick={() => openSheet(row.original)}
		>
			{row.getVisibleCells().map((cell) => (
				<TableCell
					key={cell.id}
					className="py-0 ps-4.5 overflow-hidden"
					style={{
						...getColumnWidthStyle("container-col", cell.column.id),
						height: virtualRow.size,
					}}
				>
					{flexRender(cell.column.columnDef.cell, cell.getContext())}
				</TableCell>
			))}
		</TableRow>
	)
})

function LogsFullscreenDialog({
	open,
	onOpenChange,
	logsDisplay,
	containerName,
	onRefresh,
	isRefreshing,
	search,
	setSearch,
	matchCount,
	activeMatch,
	onNavigate,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	logsDisplay: string
	containerName: string
	onRefresh: () => void | Promise<void>
	isRefreshing: boolean
	search: string
	setSearch: (value: string) => void
	matchCount: number
	activeMatch: number
	onNavigate: (dir: 1 | -1) => void
}) {
	const outerContainerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open || !logsDisplay) return
		if (search.trim()) {
			outerContainerRef.current?.querySelector(".log-match-current")?.scrollIntoView({ block: "center" })
			return
		}
		// Scroll the outer container to bottom
		const scrollToBottom = () => {
			if (outerContainerRef.current) {
				outerContainerRef.current.scrollTop = outerContainerRef.current.scrollHeight
			}
		}
		setTimeout(scrollToBottom, 50)
	}, [open, logsDisplay, search])

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100vw-20px)] h-[calc(100dvh-20px)] max-w-none p-0 bg-gh-dark border-0 text-white">
				<DialogTitle className="sr-only">{containerName} logs</DialogTitle>
				<div className="absolute top-3 left-3 z-10">
					<LogSearchBar
						search={search}
						setSearch={setSearch}
						matchCount={matchCount}
						activeMatch={activeMatch}
						onNavigate={onNavigate}
					/>
				</div>
				<div ref={outerContainerRef} className="h-full overflow-auto">
					<div
						className={cn(
							"h-full w-full px-3 leading-relaxed rounded-md bg-gh-dark text-sm",
							search.trim() && "whitespace-pre-wrap font-mono"
						)}
					>
						<div className="py-3 pt-14" dangerouslySetInnerHTML={{ __html: logsDisplay }} />
					</div>
				</div>
				<button
					onClick={onRefresh}
					className="absolute top-3 right-11 opacity-60 hover:opacity-100 p-1"
					disabled={isRefreshing}
					title={t`Refresh`}
					aria-label={t`Refresh`}
				>
					<RefreshCwIcon className={`size-4 transition-transform duration-300 ${isRefreshing ? "animate-spin" : ""}`} />
				</button>
			</DialogContent>
		</Dialog>
	)
}

function InfoFullscreenDialog({
	open,
	onOpenChange,
	infoDisplay,
	containerName,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	infoDisplay: string
	containerName: string
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100vw-20px)] h-[calc(100dvh-20px)] max-w-none p-0 bg-gh-dark border-0 text-white">
				<DialogTitle className="sr-only">{containerName} info</DialogTitle>
				<div className="flex-1 overflow-auto">
					<div className="h-full w-full overflow-auto p-3 rounded-md bg-gh-dark text-sm leading-relaxed">
						<div dangerouslySetInnerHTML={{ __html: infoDisplay }} />
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
