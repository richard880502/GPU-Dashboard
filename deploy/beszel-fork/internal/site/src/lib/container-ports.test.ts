import { expect, test } from "bun:test"
import { parsePortMap } from "./container-ports"

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
