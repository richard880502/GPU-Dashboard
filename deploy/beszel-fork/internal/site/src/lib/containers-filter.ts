// gpu-monitoring fork: narrow the All Containers page to some servers.
// Pure helpers only (see containers-filter-store.ts for the state).
//
// The selection is kept as server *names*: they are what the URL carries
// (/containers?system=wingene-77,wingene-80) and they survive a hub that is
// rebuilt with new system ids. They are turned into ids when filtering.

/** URL query parameter that carries the selected server names */
export const SYSTEM_PARAM = "system"

/** "a,b,,a" -> ["a","b"]: trimmed, no empty entries, no repeats, order kept */
export function parseSystemsParam(raw: string | null | undefined): string[] {
	if (!raw) return []
	const names: string[] = []
	for (const part of raw.split(",")) {
		const name = part.trim()
		if (name && !names.includes(name)) names.push(name)
	}
	return names
}

export function serializeSystemsParam(names: readonly string[]): string {
	return names.join(",")
}

/**
 * Returns `search` (a location.search string) with the system parameter set to
 * `names`, or removed when there are none. Other parameters are kept and commas
 * stay readable instead of becoming %2C.
 */
export function withSystemsParam(search: string, names: readonly string[]): string {
	const params = new URLSearchParams(search)
	if (names.length) params.set(SYSTEM_PARAM, serializeSystemsParam(names))
	else params.delete(SYSTEM_PARAM)
	const out = params.toString().replaceAll("%2C", ",")
	return out ? `?${out}` : ""
}

/** Whether a location.search string carries the parameter (an empty value counts) */
export function hasSystemsParam(search: string): boolean {
	return new URLSearchParams(search).has(SYSTEM_PARAM)
}

export function systemsParamFromSearch(search: string): string[] {
	return parseSystemsParam(new URLSearchParams(search).get(SYSTEM_PARAM))
}

/** Server names -> system ids. Names no system has (a typo, a removed server) are dropped. */
export function resolveSystemIds(names: readonly string[], systems: readonly { id: string; name: string }[]): string[] {
	const ids: string[] = []
	for (const name of names) {
		const id = systems.find((s) => s.name === name)?.id
		if (id && !ids.includes(id)) ids.push(id)
	}
	return ids
}

/** Keep the items of the given systems. No ids means no filter: everything stays. */
export function filterBySystems<T extends { system: string }>(items: readonly T[], ids: readonly string[]): T[] {
	if (!ids.length) return items as T[]
	const wanted = new Set(ids)
	return items.filter((item) => wanted.has(item.system))
}

/** Number of items per system id */
export function countBySystem(items: readonly { system: string }[] | undefined): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const item of items ?? []) counts[item.system] = (counts[item.system] ?? 0) + 1
	return counts
}

/** Every space separated term of `query` must be in `haystack` (case insensitive) */
export function matchesTerms(haystack: string, query: string): boolean {
	const text = haystack.toLowerCase()
	return query
		.toLowerCase()
		.split(" ")
		.every((term) => text.includes(term))
}

/** Server filter first, then the search text: both have to match */
export function filterContainers<T extends { system: string }>(
	items: readonly T[],
	ids: readonly string[],
	query: string,
	haystackOf: (item: T) => string
): T[] {
	const bySystem = filterBySystems(items, ids)
	return query.trim() ? bySystem.filter((item) => matchesTerms(haystackOf(item), query)) : bySystem
}

/** Button label: "All servers", "wingene-77" or "wingene-77 +1" */
export function systemFilterLabel(selectedNames: readonly string[], total: number, allLabel: string): string {
	if (!selectedNames.length || selectedNames.length >= total) return allLabel
	return selectedNames.length === 1 ? selectedNames[0] : `${selectedNames[0]} +${selectedNames.length - 1}`
}
