//go:build !linux

package agent

import "net/http"

// gpu-monitoring fork: in-agent GPU process attribution reads the host's
// /proc, so it is Linux-only; elsewhere the agent keeps reading
// gpu-process-exporter (see gpu_attribution_linux.go).
type gpuAttributor struct{}

func newGpuAttributor(*http.Client, *criCollector) *gpuAttributor { return nil }

func (g *gpuAttributor) containers() map[pidIndex]pidContainer { return nil }

func (g *gpuAttributor) listenPorts([]string) map[string][]uint16 { return nil }
