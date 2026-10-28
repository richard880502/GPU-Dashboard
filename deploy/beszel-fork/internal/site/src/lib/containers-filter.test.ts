import { expect, test } from "bun:test"
import {
	countBySystem,
	filterBySystems,
	filterContainers,
	hasSystemsParam,
	matchesTerms,
	parseSystemsParam,
	resolveSystemIds,
	serializeSystemsParam,
	systemFilterLabel,
	systemsParamFromSearch,
	withSystemsParam,
} from "./containers-filter"

const systems = [
	{ id: "s76", name: "wingene-76" },
	{ id: "s77", name: "wingene-77" },
	{ id: "s80", name: "wingene-80" },
]
const containers = [
	{ id: "1", system: "s76", name: "beszel" },
	{ id: "2", system: "s77", name: "vllm-embeddings" },
	{ id: "3", system: "s77", name: "qdrant" },
	{ id: "4", system: "s80", name: "vllm_gemma4_ray" },
	{ id: "5", system: "s80", name: "qdrant" },
]
const haystack = (c: (typeof containers)[number]) => `${systems.find((s) => s.id === c.system)?.name} ${c.name}`

test("query parameter: empty, blank, repeated and padded values", () => {
	expect(parseSystemsParam(undefined)).toEqual([])
	expect(parseSystemsParam(null)).toEqual([])
	expect(parseSystemsParam("")).toEqual([])
	expect(parseSystemsParam(" , ,")).toEqual([])
	expect(parseSystemsParam("wingene-77")).toEqual(["wingene-77"])
	expect(parseSystemsParam("wingene-77,wingene-80")).toEqual(["wingene-77", "wingene-80"])
	expect(parseSystemsParam(" wingene-77 ,, wingene-77,wingene-80 ")).toEqual(["wingene-77", "wingene-80"])
	expect(serializeSystemsParam(["a", "b"])).toBe("a,b")
	expect(serializeSystemsParam([])).toBe("")
})

test("query string: set, replace, remove, keep other parameters", () => {
	expect(withSystemsParam("", ["wingene-77", "wingene-80"])).toBe("?system=wingene-77,wingene-80")
	expect(withSystemsParam("?system=wingene-77", ["wingene-80"])).toBe("?system=wingene-80")
	expect(withSystemsParam("?system=wingene-77", [])).toBe("")
	expect(withSystemsParam("", [])).toBe("")
	expect(withSystemsParam("?page=2&system=a", ["b"])).toBe("?page=2&system=b")
	expect(withSystemsParam("?page=2&system=a", [])).toBe("?page=2")
	// names with spaces or odd characters round-trip
	const search = withSystemsParam("", ["my server", "a&b"])
	expect(systemsParamFromSearch(search)).toEqual(["my server", "a&b"])
})

test("reading the query string back", () => {
	expect(systemsParamFromSearch("?system=wingene-77,wingene-80")).toEqual(["wingene-77", "wingene-80"])
	expect(systemsParamFromSearch("?system=")).toEqual([])
	expect(systemsParamFromSearch("?other=1")).toEqual([])
	expect(systemsParamFromSearch("?system=a&system=b")).toEqual(["a"]) // first one wins
	expect(hasSystemsParam("?system=")).toBe(true) // an explicit "all servers"
	expect(hasSystemsParam("?system=a")).toBe(true)
	expect(hasSystemsParam("")).toBe(false)
	expect(hasSystemsParam("?page=2")).toBe(false)
})

test("names become ids; unknown names are dropped", () => {
	expect(resolveSystemIds(["wingene-77", "wingene-80"], systems)).toEqual(["s77", "s80"])
	expect(resolveSystemIds(["wingene-77", "nope"], systems)).toEqual(["s77"])
	expect(resolveSystemIds(["nope"], systems)).toEqual([])
	expect(resolveSystemIds([], systems)).toEqual([])
	expect(resolveSystemIds(["wingene-77", "wingene-77"], systems)).toEqual(["s77"])
	expect(resolveSystemIds(["wingene-77"], [])).toEqual([]) // systems not loaded yet
})

test("filter by systems", () => {
	expect(filterBySystems(containers, []).length).toBe(5) // no selection = everything
	expect(filterBySystems(containers, ["s77"]).map((c) => c.id)).toEqual(["2", "3"])
	expect(filterBySystems(containers, ["s77", "s80"]).map((c) => c.id)).toEqual(["2", "3", "4", "5"])
	expect(filterBySystems(containers, ["unknown"])).toEqual([])
	expect(filterBySystems([], ["s77"])).toEqual([])
})

test("counts per system", () => {
	expect(countBySystem(containers)).toEqual({ s76: 1, s77: 2, s80: 2 })
	expect(countBySystem(undefined)).toEqual({})
	expect(countBySystem([])).toEqual({})
})

test("search terms are ANDed and case insensitive", () => {
	expect(matchesTerms("wingene-77 qdrant", "QDRANT")).toBe(true)
	expect(matchesTerms("wingene-77 qdrant", "wingene qdrant")).toBe(true)
	expect(matchesTerms("wingene-77 qdrant", "wingene vllm")).toBe(false)
	expect(matchesTerms("anything", "")).toBe(true)
})

test("server filter and search text have to match together", () => {
	const ids = (list: typeof containers) => list.map((c) => c.id)
	// search alone: qdrant on 77 and 80
	expect(ids(filterContainers(containers, [], "qdrant", haystack))).toEqual(["3", "5"])
	// server alone
	expect(ids(filterContainers(containers, ["s77"], "", haystack))).toEqual(["2", "3"])
	// both: qdrant only on 77
	expect(ids(filterContainers(containers, ["s77"], "qdrant", haystack))).toEqual(["3"])
	// search for something that only exists on another server
	expect(filterContainers(containers, ["s76"], "qdrant", haystack)).toEqual([])
	// the search may also name the server
	expect(ids(filterContainers(containers, ["s77", "s80"], "wingene-80 vllm", haystack))).toEqual(["4"])
	// a blank search is no search
	expect(filterContainers(containers, ["s77"], "   ", haystack).length).toBe(2)
})

test("button label", () => {
	expect(systemFilterLabel([], 6, "All servers")).toBe("All servers")
	expect(systemFilterLabel(["wingene-77"], 6, "All servers")).toBe("wingene-77")
	expect(systemFilterLabel(["wingene-77", "wingene-80"], 6, "All servers")).toBe("wingene-77 +1")
	expect(systemFilterLabel(["a", "b", "c"], 6, "All servers")).toBe("a +2")
	expect(systemFilterLabel(["a", "b", "c"], 3, "All servers")).toBe("All servers") // everything selected
})
