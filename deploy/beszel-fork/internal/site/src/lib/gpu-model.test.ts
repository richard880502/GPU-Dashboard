import { expect, test } from "bun:test"
import { displayGpuModel } from "./gpu-model"

test("drops the id the agent appended to duplicate models", () => {
	expect(displayGpuModel("GeForce RTX 3090 0", "0")).toBe("GeForce RTX 3090")
	expect(displayGpuModel("GeForce RTX 3090 1", "1")).toBe("GeForce RTX 3090")
	expect(displayGpuModel("GeForce RTX 4090 1", "1")).toBe("GeForce RTX 4090")
})

test("a model name that is unique on the host is left alone", () => {
	expect(displayGpuModel("GeForce RTX 4090", "0")).toBe("GeForce RTX 4090")
	expect(displayGpuModel("GeForce RTX 3090", "0")).toBe("GeForce RTX 3090")
	expect(displayGpuModel("Tesla T4", "0")).toBe("Tesla T4")
	expect(displayGpuModel("Tesla T4", "4")).toBe("Tesla T4")
	expect(displayGpuModel("GB10", "0")).toBe("GB10")
	expect(displayGpuModel("H100 80GB HBM3", "0")).toBe("H100 80GB HBM3")
})

test("mixed models on one host: only the duplicated model carries a suffix", () => {
	// 3090 on ids 0 and 1, a single 4090 on id 2
	expect(displayGpuModel("GeForce RTX 3090 0", "0")).toBe("GeForce RTX 3090")
	expect(displayGpuModel("GeForce RTX 3090 1", "1")).toBe("GeForce RTX 3090")
	expect(displayGpuModel("GeForce RTX 4090", "2")).toBe("GeForce RTX 4090")
	// the model's own digits are never taken for the id on any realistic index
	for (const id of ["0", "1", "2", "3", "7", "15"]) {
		expect(displayGpuModel("GeForce RTX 4090", id)).toBe("GeForce RTX 4090")
	}
})

test("ids that are not contiguous or have several digits", () => {
	expect(displayGpuModel("GeForce RTX 4090 3", "3")).toBe("GeForce RTX 4090")
	expect(displayGpuModel("GeForce RTX 4090 7", "7")).toBe("GeForce RTX 4090")
	expect(displayGpuModel("GeForce RTX 4090 12", "12")).toBe("GeForce RTX 4090")
	// "...4090 1" must not lose its trailing "2" for id 12, nor "12" for id 2
	expect(displayGpuModel("GeForce RTX 4090 12", "2")).toBe("GeForce RTX 4090 12")
	expect(displayGpuModel("GeForce RTX 4090 2", "12")).toBe("GeForce RTX 4090 2")
})

test("only one suffix is removed, and never the whole name", () => {
	expect(displayGpuModel("GeForce RTX 3090 1 1", "1")).toBe("GeForce RTX 3090 1")
	expect(displayGpuModel(" 0", "0")).toBe(" 0")
	expect(displayGpuModel("", "0")).toBe("")
	expect(displayGpuModel("GeForce RTX 3090 0", "")).toBe("GeForce RTX 3090 0")
})
