// gpu-monitoring fork: the PID column of the All Containers page shows two
// kinds of PID. `pid` is the container's main process as the host sees it
// (docker inspect State.Pid, the number host ps / top / nsenter show) and
// `gpuPid` holds the PIDs of its processes that use a GPU ("2611205,2611206").

export interface ContainerPids {
	/** main process PID, undefined when unknown (older agent, stopped container) */
	main?: number
	/** GPU process PIDs, in the order the agent sent them */
	gpu: string[]
}

export function parseContainerPids(pid?: number | null, gpuPid?: string | null): ContainerPids {
	const gpu = (gpuPid ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
	return { main: pid && pid > 0 ? pid : undefined, gpu }
}

/** Value to sort the column by: the main PID, else the first GPU PID, undefined when there is none */
export function pidSortValue(pid?: number | null, gpuPid?: string | null): number | undefined {
	const { main, gpu } = parseContainerPids(pid, gpuPid)
	if (main !== undefined) return main
	const first = Number(gpu[0])
	return gpu.length && Number.isFinite(first) ? first : undefined
}

/** Text the global search looks in: both kinds of PID, so either can be typed */
export function pidSearchText(pid?: number | null, gpuPid?: string | null): string {
	const { main, gpu } = parseContainerPids(pid, gpuPid)
	return [main, ...gpu].filter((p) => p !== undefined).join(" ")
}
