import { t } from "@lingui/core/macro"
import {
	flexRender,
	type ColumnSizingState,
	type Table as TableType,
} from "@tanstack/react-table"
import { type CSSProperties, useMemo } from "react"
import { cn, useBrowserStorage } from "@/lib/utils"
import { TableHead, TableHeader } from "@/components/ui/table"

export function usePersistedColumnSizing(key: string) {
	return useBrowserStorage<ColumnSizingState>(key, {})
}

export function useColumnSizeVars<TData>(
	table: TableType<TData>,
	columnSizing: ColumnSizingState,
	prefix: string
) {
	return useMemo(() => {
		const vars: Record<string, string> = {}
		for (const column of table.getVisibleLeafColumns()) {
			vars[`--${prefix}-${column.id}-size`] = `${column.getSize()}px`
		}
		return vars as CSSProperties
	}, [table, columnSizing, prefix])
}

export function getColumnWidthStyle(prefix: string, columnId: string): CSSProperties {
	return { width: `var(--${prefix}-${columnId}-size)` }
}

export function ResizableTableHead<TData>({
	table,
	prefix,
	headerClassName,
	headClassName,
}: {
	table: TableType<TData>
	prefix: string
	headerClassName?: string
	headClassName?: string
}) {
	return (
		<TableHeader className={cn("sticky top-0 z-50 w-full border-b-2", headerClassName)}>
			{table.getHeaderGroups().map((headerGroup) => (
				<tr key={headerGroup.id}>
					{headerGroup.headers.map((header) => (
						<TableHead
							key={header.id}
							className={cn("relative px-2", headClassName)}
							style={getColumnWidthStyle(prefix, header.column.id)}
						>
							<div className="min-w-0 overflow-hidden">
								{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
							</div>
							{header.column.getCanResize() && (
								<div
									role="separator"
									aria-orientation="vertical"
									aria-label={t`Resize column`}
									onMouseDown={header.getResizeHandler()}
									onTouchStart={header.getResizeHandler()}
									onClick={(event) => event.stopPropagation()}
									onDoubleClick={(event) => {
										event.stopPropagation()
										header.column.resetSize()
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
