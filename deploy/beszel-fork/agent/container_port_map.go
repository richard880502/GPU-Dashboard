package agent

// gpu-monitoring fork addition (not upstream): formats a container's
// published ports as "host→container" text for the GPU process panel, which
// shows which service listens on which host port. Stats.Ports (upstream)
// keeps only the host side for the Containers page.

import (
	"fmt"
	"sort"
	"strings"

	"github.com/henrygd/beszel/internal/entities/container"
)

type portMapping struct {
	ip, proto           string
	hostFirst, hostLast uint16
	ctrFirst, ctrLast   uint16
}

// formatPortMap returns the published ports as e.g.
// "8000→8000, 127.0.0.1:9000→9000, 5000-5003→5000-5003/udp", or "host" for a
// host-network container (which has no mappings: it listens on the host's
// ports directly). "" means nothing is published. TCP is the default and left
// unmarked; the wildcard 0.0.0.0 and :: bindings Docker lists separately are
// merged into one; consecutive ports of the same binding become a range.
func formatPortMap(ports []container.ApiPort, networkMode string) string {
	if networkMode == "host" {
		return "host"
	}
	seen := make(map[portMapping]struct{}, len(ports))
	singles := make([]portMapping, 0, len(ports))
	for _, p := range ports {
		if p.PublicPort == 0 {
			continue
		}
		m := portMapping{
			ip:        p.IP,
			proto:     p.Type,
			hostFirst: p.PublicPort, hostLast: p.PublicPort,
			ctrFirst: p.PrivatePort, ctrLast: p.PrivatePort,
		}
		if m.ip == "0.0.0.0" || m.ip == "::" {
			m.ip = ""
		}
		if m.proto == "" {
			m.proto = "tcp"
		}
		if _, dup := seen[m]; dup {
			continue
		}
		seen[m] = struct{}{}
		singles = append(singles, m)
	}
	if len(singles) == 0 {
		return ""
	}

	sort.Slice(singles, func(i, j int) bool {
		a, b := singles[i], singles[j]
		if a.ip != b.ip {
			return a.ip < b.ip
		}
		if a.proto != b.proto {
			return a.proto < b.proto
		}
		if a.hostFirst != b.hostFirst {
			return a.hostFirst < b.hostFirst
		}
		return a.ctrFirst < b.ctrFirst
	})
	merged := singles[:1]
	for _, m := range singles[1:] {
		last := &merged[len(merged)-1]
		if m.ip == last.ip && m.proto == last.proto &&
			int(m.hostFirst) == int(last.hostLast)+1 && int(m.ctrFirst) == int(last.ctrLast)+1 {
			last.hostLast, last.ctrLast = m.hostLast, m.ctrLast
			continue
		}
		merged = append(merged, m)
	}
	// read order: by host port, the number people look for
	sort.SliceStable(merged, func(i, j int) bool {
		return merged[i].hostFirst < merged[j].hostFirst
	})

	var b strings.Builder
	for i, m := range merged {
		if i > 0 {
			b.WriteString(", ")
		}
		if m.ip != "" {
			b.WriteString(m.ip)
			b.WriteByte(':')
		}
		b.WriteString(portRange(m.hostFirst, m.hostLast))
		b.WriteString("→")
		b.WriteString(portRange(m.ctrFirst, m.ctrLast))
		if m.proto != "tcp" {
			b.WriteByte('/')
			b.WriteString(m.proto)
		}
	}
	return b.String()
}

func portRange(first, last uint16) string {
	if first == last {
		return fmt.Sprint(first)
	}
	return fmt.Sprintf("%d-%d", first, last)
}

const (
	// listening ports of a host-network container: the ranges kept, and the
	// start of Linux's default ephemeral range (32768-60999), whose ports are
	// normally a runtime's internal workers rather than the service
	maxListenEntries   = 20
	ephemeralPortStart = 32768
)

// formatListenPorts formats the external TCP ports a host-network container
// listens on as "L:8000, 8265, 10002-10050": the "L:" prefix tells the UI
// these are listening ports, not published mappings. Consecutive ports
// become one range; ports below the ephemeral range come first (they are the
// ones people look for), at most maxListenEntries entries are kept. "" for
// no ports.
func formatListenPorts(ports []uint16) string {
	set := make(map[uint16]struct{}, len(ports))
	for _, p := range ports {
		if p != 0 {
			set[p] = struct{}{}
		}
	}
	if len(set) == 0 {
		return ""
	}
	low := make([]int, 0, len(set))
	high := make([]int, 0)
	for p := range set {
		if p < ephemeralPortStart {
			low = append(low, int(p))
		} else {
			high = append(high, int(p))
		}
	}
	sort.Ints(low)
	sort.Ints(high)
	entries := append(portRanges(low), portRanges(high)...)
	if len(entries) > maxListenEntries {
		entries = entries[:maxListenEntries]
	}
	return "L:" + strings.Join(entries, ", ")
}

// portRanges turns sorted unique ports into "a" / "a-b" entries.
func portRanges(ports []int) []string {
	var out []string
	for i := 0; i < len(ports); {
		j := i
		for j+1 < len(ports) && ports[j+1] == ports[j]+1 {
			j++
		}
		out = append(out, portRange(uint16(ports[i]), uint16(ports[j])))
		i = j + 1
	}
	return out
}

// containerListen is what the /proc scan learns about one host-network
// container (container_listen_linux.go).
type containerListen struct {
	ports []uint16 // sorted external TCP listen ports of its non-Ray-internal processes
	role  string   // "head" / "worker" if it runs a Ray node, else ""
	head  string   // a worker's head node address (host only), if known
}

// formatContainerListen formats what the scan found as the portMap text:
// ";"-separated parts, "R:head" / "R:worker" / "R:worker=<head host>" (the
// container runs a Ray node), then "L:8287, ..." (listening ports, see
// formatListenPorts). "" if there is nothing to say.
func formatContainerListen(c containerListen) string {
	var parts []string
	switch c.role {
	case "head":
		parts = append(parts, "R:head")
	case "worker":
		if c.head != "" {
			parts = append(parts, "R:worker="+c.head)
		} else {
			parts = append(parts, "R:worker")
		}
	}
	if ports := formatListenPorts(c.ports); ports != "" {
		parts = append(parts, ports)
	}
	return strings.Join(parts, ";")
}

// isListenPortMap reports whether a PortMap is one applyListenPorts owns: the
// placeholder "host", or text it wrote earlier (stats objects are reused).
func isListenPortMap(s string) bool {
	return s == "host" || strings.HasPrefix(s, "L:") || strings.HasPrefix(s, "R:")
}
