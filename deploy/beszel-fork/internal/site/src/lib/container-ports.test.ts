import { expect, test } from "bun:test"
import { parsePortMap, resolvePortMap } from "./container-ports"

test("nothing published, host network and old records", () => {
	expect(parsePortMap(undefined)).toEqual({ kind: "none" })
	expect(parsePortMap("")).toEqual({ kind: "none" })
	expect(parsePortMap("  ")).toEqual({ kind: "none" })
	expect(parsePortMap(" , ")).toEqual({ kind: "none" })
	expect(parsePortMap("host")).toEqual({ kind: "host" })
})

test("a few ports are all shown", () => {
	expect(parsePortMap("8000→8000, 127.0.0.1:9000→9000/udp")).toEqual({
		kind: "ports",
		shown: ["8000→8000", "127.0.0.1:9000→9000/udp"],
		hiddenCount: 0,
		full: "8000→8000\n127.0.0.1:9000→9000/udp",
	})
})

test("more than three fold into a count, the tooltip text keeps all", () => {
	const view = parsePortMap("1→1, 2→2, 3→3, 4→4, 5→5")
	expect(view).toEqual({
		kind: "ports",
		shown: ["1→1", "2→2", "3→3"],
		hiddenCount: 2,
		full: "1→1\n2→2\n3→3\n4→4\n5→5",
	})
})

test("listening ports of a host-network container are told apart from mappings", () => {
	expect(parsePortMap("L:8000, 8265, 10002-10050")).toEqual({
		kind: "listen",
		shown: ["8000", "8265", "10002-10050"],
		hiddenCount: 0,
		full: "8000\n8265\n10002-10050",
	})
	const many = parsePortMap("L:1, 2, 3, 4, 5")
	expect(many).toEqual({
		kind: "listen",
		shown: ["1", "2", "3"],
		hiddenCount: 2,
		full: "1\n2\n3\n4\n5",
	})
	expect(parsePortMap("L:")).toEqual({ kind: "none" })
	expect(parsePortMap(" L: , ")).toEqual({ kind: "none" })
})

test("a Ray head shows its role and the service port", () => {
	expect(parsePortMap("R:head;L:8287")).toEqual({
		kind: "listen",
		shown: ["8287"],
		hiddenCount: 0,
		full: "8287",
		ray: { role: "head" },
	})
	expect(parsePortMap("R:head")).toEqual({ kind: "ray", ray: { role: "head" } })
})

test("a Ray worker has a role and, if known, where its head is", () => {
	expect(parsePortMap("R:worker=192.168.1.79")).toEqual({ kind: "ray", ray: { role: "worker", head: "192.168.1.79" } })
	expect(parsePortMap("R:worker")).toEqual({ kind: "ray", ray: { role: "worker" } })
})

test("unknown parts are ignored", () => {
	expect(parsePortMap("R:gadget")).toEqual({ kind: "none" })
	expect(parsePortMap("R:gadget;L:8000")).toEqual({ kind: "listen", shown: ["8000"], hiddenCount: 0, full: "8000" })
})

test("portMap wins; the upstream ports are only the fallback", () => {
	// older agent: no portMap, the upstream field has the host ports
	expect(resolvePortMap("", "8300")).toEqual({ kind: "legacy", shown: ["8300"], hiddenCount: 0, full: "8300" })
	expect(resolvePortMap(undefined, "8300, 8301, 8302, 8303")).toEqual({
		kind: "legacy",
		shown: ["8300", "8301", "8302"],
		hiddenCount: 1,
		full: "8300\n8301\n8302\n8303",
	})
	// both empty
	expect(resolvePortMap("", "")).toEqual({ kind: "none" })
	expect(resolvePortMap(undefined, undefined)).toEqual({ kind: "none" })
	// a portMap value is used even if the upstream field differs
	expect(resolvePortMap("8000→8000", "9999")).toEqual({ kind: "ports", shown: ["8000→8000"], hiddenCount: 0, full: "8000→8000" })
	expect(resolvePortMap("host", "9999")).toEqual({ kind: "host" })
	expect(resolvePortMap("R:worker", "9999")).toEqual({ kind: "ray", ray: { role: "worker" } })
})
