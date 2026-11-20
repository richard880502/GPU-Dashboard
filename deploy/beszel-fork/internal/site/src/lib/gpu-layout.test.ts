import { describe, expect, test } from "bun:test"
import { DEFAULT_GPU_LAYOUT, layoutOf, parseLayout } from "./gpu-layout"

describe("layoutOf", () => {
	test("groups GPU indexes by server in a stable order", () => {
		const rows = [
			{ systemId: "b", index: "1" },
			{ systemId: "a", index: "0" },
			{ systemId: "b", index: "10" },
			{ systemId: "b", index: "0" },
		]
		expect(layoutOf(rows)).toEqual([
			{ s: "a", i: ["0"] },
			{ s: "b", i: ["0", "1", "10"] },
		])
	})

	test("orders servers by name like the table does", () => {
		const names: Record<string, string> = { x: "wingene-80", y: "wingene-9", z: "wingene-76" }
		const rows = [
			{ systemId: "x", index: "0" },
			{ systemId: "y", index: "0" },
			{ systemId: "z", index: "0" },
		]
		expect(layoutOf(rows, (id) => names[id]).map((g) => g.s)).toEqual(["y", "z", "x"])
	})

	test("empty snapshot has no servers", () => {
		expect(layoutOf([])).toEqual([])
	})
})

describe("parseLayout", () => {
	test("round-trips a stored layout", () => {
		expect(parseLayout(JSON.stringify(DEFAULT_GPU_LAYOUT))).toEqual(DEFAULT_GPU_LAYOUT)
	})

	test("rejects missing or malformed values", () => {
		expect(parseLayout(null)).toBeNull()
		expect(parseLayout("not json")).toBeNull()
		expect(parseLayout('{"s":"a"}')).toBeNull()
		expect(parseLayout('[{"s":"a","i":[0]}]')).toBeNull()
	})
})
