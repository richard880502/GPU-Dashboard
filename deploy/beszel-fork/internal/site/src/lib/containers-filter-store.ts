import { atom } from "nanostores"
import { hasSystemsParam, systemsParamFromSearch } from "./containers-filter"

// gpu-monitoring fork: which servers the All Containers page is narrowed to
// (server names, empty = all). The URL wins over what was stored last time:
// a shared link must show what the sender saw. The page writes the selection
// back into its URL (see ContainersTable).
const STORAGE_KEY = "besz-containers-systems"

function readInitial(): string[] {
	if (typeof window === "undefined") return []
	try {
		if (hasSystemsParam(window.location.search)) return systemsParamFromSearch(window.location.search)
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
		return Array.isArray(stored) ? stored.filter((n): n is string => typeof n === "string" && n !== "") : []
	} catch {
		return []
	}
}

export const $containerSystems = atom<string[]>(readInitial())

export function setContainerSystems(names: string[]) {
	$containerSystems.set(names)
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(names))
	} catch {
		// private mode or blocked storage: the selection just is not remembered
	}
}
