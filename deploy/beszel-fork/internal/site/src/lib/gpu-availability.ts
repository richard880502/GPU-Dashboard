// gpu-monitoring fork addition (not upstream): one shared answer to "is this
// GPU free?" for the home page cards.
//
// Process attribution alone isn't enough: when it fails (e.g. NVML broken
// inside the containers) a GPU at 100% shows no processes and would look
// free. Utilization is the stronger signal, and a short look-back keeps a
// job that pauses between steps from flickering to "free".

export type GpuAvailability = "free" | "busy" | "held" | "offline"

/** utilization at or above this counts as running */
export const BUSY_UTIL_PCT = 5
/** a GPU stays "busy" this long after it last ran */
export const BUSY_WINDOW_MS = 2 * 60_000
/** no sample for this long means the numbers can't be trusted */
export const STALE_MS = 3 * 60_000
/** an idle GPU's driver/context footprint stays below this (MiB) */
const IDLE_MEM_MIB = 1024

export interface GpuSample {
	/** epoch ms */
	at: number
	util: number
	memUsed: number
	memTotal: number
	procs: number
}

/** epoch ms of the newest sample at or above BUSY_UTIL_PCT, or 0 */
export function lastBusyAt(samples: GpuSample[]): number {
	let busy = 0
	for (const s of samples) {
		if (s.util >= BUSY_UTIL_PCT && s.at > busy) {
			busy = s.at
		}
	}
	return busy
}

/**
 * @param latest the newest sample for the GPU
 * @param busyAt when it last ran (from lastBusyAt, possibly remembered across refreshes)
 */
export function classifyGpu(
	latest: GpuSample | undefined,
	{ systemUp, busyAt, now = Date.now() }: { systemUp: boolean; busyAt: number; now?: number }
): GpuAvailability {
	if (!systemUp || !latest || now - latest.at > STALE_MS) {
		return "offline"
	}
	if (busyAt && now - busyAt <= BUSY_WINDOW_MS) {
		return "busy"
	}
	if (latest.procs > 0 || latest.memUsed > Math.max(IDLE_MEM_MIB, latest.memTotal * 0.05)) {
		return "held"
	}
	return "free"
}

/** PocketBase "2026-10-23 05:18:13.123Z" -> epoch ms */
export function parsePbDate(value: string): number {
	return new Date(value.replace(" ", "T")).getTime()
}
