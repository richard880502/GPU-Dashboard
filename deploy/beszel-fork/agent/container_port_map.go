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
