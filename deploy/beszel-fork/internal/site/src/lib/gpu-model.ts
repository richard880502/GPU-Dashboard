// gpu-monitoring fork.
//
// When two or more GPUs of one host share a model name, the agent appends the
// card's own id to the name (agent/gpu.go, GetCurrentData): "GeForce RTX 3090 0",
// "GeForce RTX 3090 1". A card whose model is unique on the host keeps the plain
// name ("GeForce RTX 4090" next to two 3090s). The id is the key the stats use for
// the GPU (the `index` shown as "GPU 0"), so the suffix is always exactly
// " <index>" and shows the number twice in "GPU 0  GeForce RTX 3090 0".
// This takes that suffix off for display. Only an exact trailing " <index>" is
// removed, once, so digits that belong to the model ("RTX 4090") stay. (It cannot
// tell a suffix from a model that really ends in its own id, such as a card with
// id 4090 called "... 4090"; ids are small, so that does not occur.)
export function displayGpuModel(name: string, index: string): string {
	const suffix = ` ${index}`
	if (index === "" || name.length <= suffix.length || !name.endsWith(suffix)) return name
	return name.slice(0, -suffix.length)
}
