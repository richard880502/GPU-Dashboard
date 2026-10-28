import { t } from "@lingui/core/macro"
import { Trans } from "@lingui/react/macro"
import { useStore } from "@nanostores/react"
import { ChevronDownIcon, ServerIcon } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { systemFilterLabel } from "@/lib/containers-filter"
import { $containerSystems, setContainerSystems } from "@/lib/containers-filter-store"
import { $systems } from "@/lib/stores"
import { cn } from "@/lib/utils"

// gpu-monitoring fork: pick the servers the All Containers list is narrowed to.
// Nothing selected means every server. `counts` is the number of containers per
// system id, so the list shows where the containers are before anything is chosen.
export function SystemFilter({ counts }: { counts: Record<string, number> }) {
	const systems = useStore($systems)
	const selectedNames = useStore($containerSystems)

	const sorted = useMemo(
		() => [...systems].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
		[systems]
	)
	// names that no longer exist are not shown as selected
	const selected = useMemo(() => sorted.filter((s) => selectedNames.includes(s.name)).map((s) => s.name), [sorted, selectedNames])
	const active = selected.length > 0 && selected.length < sorted.length

	const toggle = (name: string) =>
		setContainerSystems(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name])

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					aria-label={t`Filter by server`}
					className={cn("shrink-0 gap-2 px-3 font-normal", active && "border-primary/60")}
				>
					<ServerIcon className="size-4 opacity-70" aria-hidden="true" />
					<span className="max-w-44 truncate">{systemFilterLabel(selected, sorted.length, t`All servers`)}</span>
					<ChevronDownIcon className="size-4 opacity-60" aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-96 min-w-60 overflow-y-auto">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
					<Trans>Show only the selected servers (none selected shows all)</Trans>
				</DropdownMenuLabel>
				<div className="flex gap-1 px-1 pb-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 px-2"
						onClick={() => setContainerSystems(sorted.map((s) => s.name))}
					>
						<Trans>Select all</Trans>
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 px-2"
						disabled={!selected.length}
						onClick={() => setContainerSystems([])}
					>
						<Trans>Clear</Trans>
					</Button>
				</div>
				<DropdownMenuSeparator />
				{sorted.map((system) => (
					<DropdownMenuCheckboxItem
						key={system.id}
						checked={selected.includes(system.name)}
						// keep the list open so several servers can be ticked in a row
						onSelect={(e) => e.preventDefault()}
						onCheckedChange={() => toggle(system.name)}
					>
						<span className="truncate">{system.name}</span>
						<span className="ms-auto ps-6 text-xs tabular-nums text-muted-foreground">{counts[system.id] ?? 0}</span>
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
