// gpu-monitoring fork addition (not upstream): turns a container record's
// portMap into what the GPU process panel shows. The text is ";"-separated
// parts (see agent/container_port_map.go):
//   "8000→8000, 127.0.0.1:9000→9000/udp"  published ports (host→container)
//   "L:8000, 8265, 10002-10050"            host-network container: the TCP
//                                          ports it listens on
//   "R:head" / "R:worker=10.0.0.1"         the container runs a Ray head / a
//                                          Ray worker (and where its head is)
//   "R:head;L:8287"                        both
//   "host"                                 host-network container, nothing
//                                          external is listening (or unknown)
// Records from agents older than the portMap field have none; for those the
// upstream `ports` field (host ports only) is the fallback.
// Unknown parts are ignored, so a newer agent's text never breaks this.

/** entries shown before the rest fold into "+N" */
export const PORT_MAP_PREVIEW = 3

export type RayInfo = { role: "head" | "worker"; head?: string }

type Folded = { shown: string[]; hiddenCount: number; full: string }

export type PortMapView =
	| { kind: "none" }
	| { kind: "host" }
	/** only a Ray role, no port of its own to show */
	| { kind: "ray"; ray: RayInfo }
	| ({ kind: "ports" | "listen"; ray?: RayInfo } & Folded)
	/** no portMap (older agent): the host ports of the upstream `ports` field */
	| ({ kind: "legacy" } & Folded)

function fold(items: string[]): Folded {
	return {
		shown: items.slice(0, PORT_MAP_PREVIEW),
		hiddenCount: Math.max(0, items.length - PORT_MAP_PREVIEW),
		full: items.join("\n"),
	}
}

function splitItems(text: string): string[] {
	return text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
}

function parseRay(body: string): RayInfo | undefined {
	const [role, head] = body.split("=", 2)
	if (role === "head") {
		return { role }
	}
	if (role === "worker") {
		return head ? { role, head: head.trim() } : { role }
	}
	return undefined
}

export function parsePortMap(value?: string): PortMapView {
	const text = value?.trim()
	if (!text) {
		return { kind: "none" }
	}
	if (text === "host") {
		return { kind: "host" }
	}
	let ray: RayInfo | undefined
	let items: string[] = []
	let listening = false
	for (const part of text.split(";")) {
		const seg = part.trim()
		if (seg.startsWith("R:")) {
			ray = parseRay(seg.slice(2).trim()) ?? ray
		} else if (seg.startsWith("L:")) {
			listening = true
			items = items.concat(splitItems(seg.slice(2)))
		} else {
			items = items.concat(splitItems(seg))
		}
	}
	if (items.length === 0) {
		return ray ? { kind: "ray", ray } : { kind: "none" }
	}
	const view = { kind: listening ? ("listen" as const) : ("ports" as const), ...fold(items) }
	return ray ? { ...view, ray } : view
}

/** portMap if the agent sent one, else the upstream host-ports text ("8300, 8301") */
export function resolvePortMap(portMap?: string, legacyPorts?: string): PortMapView {
	const view = parsePortMap(portMap)
	if (view.kind !== "none") {
		return view
	}
	const items = splitItems(legacyPorts ?? "")
	return items.length > 0 ? { kind: "legacy", ...fold(items) } : view
}
