// gpu-monitoring fork addition (not upstream): remembers which servers and GPU
// indexes the home page showed last time, so the GPU panels can render
// same-sized placeholders before the first fetch returns instead of
// appearing out of nowhere and pushing the rest of the page down.

/** One server: its system id and the GPU indexes it had. */
export type GpuLayout = { s: string; i: string[] }[]

const STORAGE_KEY = "gpu-section-layout"

/** Used on a first visit, before anything was stored: 6 servers, 10 GPUs. */
export const DEFAULT_GPU_LAYOUT: GpuLayout = [
	{ s: "placeholder-1", i: ["0"] },
	{ s: "placeholder-2", i: ["0", "1"] },
	{ s: "placeholder-3", i: ["0", "1"] },
	{ s: "placeholder-4", i: ["0", "1"] },
	{ s: "placeholder-5", i: ["0", "1"] },
	{ s: "placeholder-6", i: ["0"] },
]

/**
 * Servers and GPU indexes of a snapshot, in the order the table shows them
 * (by server name when `nameOf` is given, else by id), so placeholders match it.
 */
export function layoutOf(
	rows: { systemId: string; index: string }[],
	nameOf: (systemId: string) => string = (id) => id
): GpuLayout {
	const bySystem = new Map<string, string[]>()
	for (const row of rows) {
		const indexes = bySystem.get(row.systemId)
		if (indexes) indexes.push(row.index)
		else bySystem.set(row.systemId, [row.index])
	}
	return [...bySystem.entries()]
		.sort(([a], [b]) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }))
		.map(([s, i]) => ({ s, i: i.sort((a, b) => Number(a) - Number(b)) }))
}

/** Checks a value read back from storage; anything malformed counts as missing. */
export function parseLayout(raw: string | null): GpuLayout | null {
	if (!raw) return null
	try {
		const value = JSON.parse(raw)
		if (
			Array.isArray(value) &&
			value.every(
				(g) => g && typeof g.s === "string" && Array.isArray(g.i) && g.i.every((i: unknown) => typeof i === "string")
			)
		) {
			return value
		}
	} catch {
		// fall through
	}
	return null
}

export function loadLayout(): GpuLayout | null {
	try {
		return parseLayout(localStorage.getItem(STORAGE_KEY))
	} catch {
		return null
	}
}

export function saveLayout(layout: GpuLayout) {
	try {
		const raw = JSON.stringify(layout)
		if (localStorage.getItem(STORAGE_KEY) !== raw) localStorage.setItem(STORAGE_KEY, raw)
	} catch {
		// storage unavailable (private window, quota): placeholders fall back to the default
	}
}
