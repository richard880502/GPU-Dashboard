import { t } from "@lingui/core/macro"
import {
	type Column,
	flexRender,
	type ColumnSizingState,
	type Table as TableType,
} from "@tanstack/react-table"
import { type CSSProperties, type MouseEvent, type TouchEvent, useMemo } from "react"
import { flushSync } from "react-dom"
import { cn, useBrowserStorage } from "@/lib/utils"
import { TableHead, TableHeader } from "@/components/ui/table"

// Resizable columns that leave the original layout alone until the user
// actually drags a handle.
//
// Until then (columnSizing is empty) tables render exactly as they did before
// resizing existed: auto table layout, w-full, widths decided by content and
// each column's `size` used only as a hint. The first drag measures what the
// browser really rendered and pins every column to those pixel widths
// (table-fixed + <colgroup>), so nothing jumps under the cursor. Double-click
// a handle to drop all custom widths and go back to the original layout.

// selection checkbox / row-actions columns have a fixed width
const NON_RESIZABLE_COLUMNS = new Set(["select", "actions"])
const MIN_COLUMN_WIDTH = 60
const MAX_COLUMN_WIDTH = 1200
// Columns that appear after widths were pinned (e.g. un-hidden from the
// column menu) have no measured width yet; their nominal `size` can be a
// layout hint such as 900, so cap what we use for them.
const UNMEASURED_FALLBACK_MAX = 180

export function usePersistedColumnSizing(key: string) {
	return useBrowserStorage<ColumnSizingState>(key, {})
}

export function isCustomSized(columnSizing: ColumnSizingState) {
	return Object.keys(columnSizing).length > 0
}

function effectiveSize<TData>(column: Column<TData, unknown>, columnSizing: ColumnSizingState) {
	const stored = columnSizing[column.id]
	if (stored === undefined) {
		return Math.min(Math.max(column.getSize(), MIN_COLUMN_WIDTH), UNMEASURED_FALLBACK_MAX)
	}
	return Math.min(Math.max(stored, MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH)
}

export function useColumnSizeVars<TData>(
	table: TableType<TData>,
	columnSizing: ColumnSizingState,
	prefix: string
) {
	return useMemo(() => {
		const vars: Record<string, string> = {}
		if (!isCustomSized(columnSizing)) {
			return vars as CSSProperties
		}
		let total = 0
		for (const column of table.getVisibleLeafColumns()) {
			const size = effectiveSize(column, columnSizing)
			vars[`--${prefix}-${column.id}-size`] = `${size}px`
			total += size
		}
		vars[`--${prefix}-total`] = `${total}px`
		return vars as CSSProperties
	}, [table, columnSizing, prefix, table.getState().columnVisibility])
}

/** className/style for the <table> element, on top of its original classes. */
export function getResizableTableProps(prefix: string, customSized: boolean) {
	if (!customSized) {
		return { className: "w-full", style: undefined }
	}
	const total = `var(--${prefix}-total)`
	return {
		className: "table-fixed",
		style: { width: total, minWidth: total, maxWidth: total } as CSSProperties,
	}
}

/** Width style for a body cell; `original` is whatever the table used before resizing existed. */
export function getColumnWidthStyle(
	prefix: string,
	columnId: string,
	customSized: boolean,
	original?: CSSProperties
): CSSProperties | undefined {
	return customSized ? { width: `var(--${prefix}-${columnId}-size)` } : original
}

export function ResizableTableColGroup<TData>({
	table,
	prefix,
	customSized,
}: {
	table: TableType<TData>
	prefix: string
	customSized: boolean
}) {
	if (!customSized) {
		return null
	}
	return (
		<colgroup>
			{table.getVisibleLeafColumns().map((column) => (
				<col key={column.id} style={getColumnWidthStyle(prefix, column.id, true)} />
			))}
		</colgroup>
	)
}

export function ResizableTableHead<TData>({
	table,
	prefix,
	customSized,
	columnSizing,
	headerClassName,
	headClassName,
	originalHeadStyle,
}: {
	table: TableType<TData>
	prefix: string
	customSized: boolean
	columnSizing: ColumnSizingState
	headerClassName?: string
	headClassName?: string
	/** per-column style the head cell had before resizing existed */
	originalHeadStyle?: (columnSize: number) => CSSProperties
}) {
	// Pin every visible column that has no stored width to what the browser
	// is rendering right now, so the drag starts from the real width.
	const measureColumns = (event: MouseEvent | TouchEvent) => {
		const row = (event.currentTarget as HTMLElement).closest("tr")
		if (!row) return
		const visible = table.getVisibleLeafColumns()
		const cells = Array.from(row.children) as HTMLElement[]
		if (cells.length !== visible.length) return
		const next: ColumnSizingState = { ...columnSizing }
		let changed = false
		visible.forEach((column, i) => {
			if (next[column.id] === undefined) {
				next[column.id] = Math.round(cells[i].getBoundingClientRect().width)
				changed = true
			}
		})
		if (changed) {
			// flush so the resize handler below sees the pinned widths as its start sizes
			flushSync(() => table.setColumnSizing(next))
		}
	}

	return (
		<TableHeader className={cn("sticky top-0 z-50 w-full border-b-2", headerClassName)}>
			{table.getHeaderGroups().map((headerGroup) => (
				<tr key={headerGroup.id}>
					{headerGroup.headers.map((header) => (
						<TableHead
							key={header.id}
							className={cn("relative px-2", headClassName)}
							style={
								customSized
									? getColumnWidthStyle(prefix, header.column.id, true)
									: originalHeadStyle?.(header.getSize())
							}
						>
							<div className="min-w-0 overflow-hidden">
								{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
							</div>
							{header.column.getCanResize() && !NON_RESIZABLE_COLUMNS.has(header.column.id) && (
								<div
									role="separator"
									aria-orientation="vertical"
									aria-label={t`Resize column`}
									onMouseDown={(event) => {
										measureColumns(event)
										header.getResizeHandler()(event)
									}}
									onTouchStart={(event) => {
										measureColumns(event)
										header.getResizeHandler()(event)
									}}
									onClick={(event) => event.stopPropagation()}
									onDoubleClick={(event) => {
										event.stopPropagation()
										table.resetColumnSizing()
									}}
									className={cn(
										"absolute end-0 top-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize select-none touch-none",
										"after:absolute after:inset-y-2 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary/60",
										header.column.getIsResizing() && "after:bg-primary"
									)}
								/>
							)}
						</TableHead>
					))}
				</tr>
			))}
		</TableHeader>
	)
}
