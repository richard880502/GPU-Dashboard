// gpu-monitoring fork addition (not upstream): turns a container record's
// portMap ("8000→8000, 127.0.0.1:9000→9000/udp", or "host" for a host-network
// container, see agent/container_port_map.go) into what the GPU process panel
// shows. Records from agents older than the portMap field have none.

/** entries shown before the rest fold into "+N" */
export const PORT_MAP_PREVIEW = 3

export type PortMapView =
	| { kind: "none" }
	| { kind: "host" }
	| { kind: "ports"; shown: string[]; hiddenCount: number; full: string }

export function parsePortMap(value?: string): PortMapView {
	const text = value?.trim()
	if (!text) {
		return { kind: "none" }
	}
	if (text === "host") {
		return { kind: "host" }
	}
	const items = text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
	if (items.length === 0) {
		return { kind: "none" }
	}
	return {
		kind: "ports",
		shown: items.slice(0, PORT_MAP_PREVIEW),
		hiddenCount: Math.max(0, items.length - PORT_MAP_PREVIEW),
		full: items.join("\n"),
	}
}
