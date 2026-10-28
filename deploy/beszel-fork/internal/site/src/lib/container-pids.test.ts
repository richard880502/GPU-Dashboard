import { expect, test } from "bun:test"
import { parseContainerPids, pidSearchText, pidSortValue } from "./container-pids"

test("main PID and GPU PIDs are read apart", () => {
	expect(parseContainerPids(48213, "2611205,2611206")).toEqual({ main: 48213, gpu: ["2611205", "2611206"] })
	expect(parseContainerPids(48213, "")).toEqual({ main: 48213, gpu: [] })
	expect(parseContainerPids(undefined, "3957288")).toEqual({ main: undefined, gpu: ["3957288"] })
	expect(parseContainerPids(0, undefined)).toEqual({ main: undefined, gpu: [] })
	expect(parseContainerPids(null, null)).toEqual({ main: undefined, gpu: [] })
	expect(parseContainerPids(-1, " 12 , ,13 ")).toEqual({ main: undefined, gpu: ["12", "13"] })
})

test("sorting uses the main PID, then the first GPU PID, and leaves empty ones last", () => {
	expect(pidSortValue(48213, "2611205")).toBe(48213)
	expect(pidSortValue(undefined, "2611205,2611206")).toBe(2611205)
	expect(pidSortValue(0, "")).toBeUndefined()
	expect(pidSortValue(undefined, undefined)).toBeUndefined()
	expect(pidSortValue(undefined, "abc")).toBeUndefined()
	const rows = [
		{ n: "gpu-only", v: pidSortValue(undefined, "2611205") },
		{ n: "none", v: pidSortValue(0, "") },
		{ n: "small", v: pidSortValue(900, "") },
	]
	expect(rows.filter((r) => r.v !== undefined).sort((a, b) => (a.v as number) - (b.v as number)).map((r) => r.n)).toEqual([
		"small",
		"gpu-only",
	])
})

test("search finds a container by either kind of PID", () => {
	const text = pidSearchText(48213, "2611205,2611206")
	expect(text).toBe("48213 2611205 2611206")
	expect(text.includes("48213")).toBe(true)
	expect(text.includes("2611206")).toBe(true)
	expect(text.includes("999")).toBe(false)
	expect(pidSearchText(undefined, "7")).toBe("7")
	expect(pidSearchText(5, undefined)).toBe("5")
	expect(pidSearchText(0, "")).toBe("")
})
