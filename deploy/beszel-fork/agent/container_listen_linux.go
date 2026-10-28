//go:build linux

package agent

// gpu-monitoring fork addition (not upstream): finds the TCP ports a
// host-network container listens on. Docker publishes nothing for such a
// container (it shares the host's network stack), so the GPU process panel
// would only say "host network" -- not which port its vLLM API answers on.
//
// With the host's /proc (--pid=host, HOST_PROC) the agent can see it:
//   - the container's processes are the PIDs whose innermost docker id in
//     /proc/<pid>/cgroup is the container's (same rule as gpu_attribution_linux.go);
//   - /proc/<pid>/net/tcp{,6} lists LISTEN sockets, but in a host network
//     namespace that is every socket of the machine, so they are matched by
//     inode against the sockets in the container's /proc/<pid>/fd;
//   - only sockets bound to a non-loopback address count as "external".
//
// Reading another process's fd links needs ptrace-read access: fine for
// root-owned, dumpable processes (the agent runs as root), otherwise the
// agent needs CAP_SYS_PTRACE.

import (
	"encoding/hex"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// the PID -> container walk touches every /proc/<pid>/cgroup and the fds of
// the containers' processes; ports of a running service rarely change
const listenScanTTL = 30 * time.Second

// listenPorts returns, per container name, the sorted external TCP listen
// ports of its processes. Containers it can't read are left out.
func (g *gpuAttributor) listenPorts(names []string) map[string][]uint16 {
	if g == nil || len(names) == 0 {
		return nil
	}
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	key := strings.Join(sorted, "\x00")

	g.listenMu.Lock()
	defer g.listenMu.Unlock()
	if g.listenCached != nil && g.listenKey == key && time.Since(g.listenAt) < listenScanTTL {
		return g.listenCached
	}
	g.listenCached = g.scanListenPorts(sorted)
	g.listenKey, g.listenAt = key, time.Now()
	return g.listenCached
}

func (g *gpuAttributor) scanListenPorts(names []string) map[string][]uint16 {
	if g.dockerNames == nil {
		return nil
	}
	wanted := make(map[string]struct{}, len(names))
	for _, n := range names {
		wanted[n] = struct{}{}
	}
	dockerNames := g.dockerNames()
	if len(dockerNames) == 0 {
		return nil
	}
	entries, err := os.ReadDir(g.procRoot)
	if err != nil {
		return nil
	}

	pidsByName := map[string][]string{}
	for _, e := range entries {
		pid := e.Name()
		if _, err := strconv.ParseUint(pid, 10, 32); err != nil {
			continue
		}
		cgroup, err := os.ReadFile(filepath.Join(g.procRoot, pid, "cgroup"))
		if err != nil { // exited since the listing
			continue
		}
		ids := cgroupIDRegex.FindAllString(string(cgroup), -1)
		for i := len(ids) - 1; i >= 0; i-- {
			if name, ok := dockerNames[ids[i]]; ok {
				if _, w := wanted[name]; w {
					pidsByName[name] = append(pidsByName[name], pid)
				}
				break
			}
		}
	}

	result := make(map[string][]uint16, len(pidsByName))
	for name, pids := range pidsByName {
		inodes := map[uint64]struct{}{}
		netPid := ""
		for _, pid := range pids {
			if !g.collectSocketInodes(pid, inodes) {
				continue
			}
			if netPid == "" {
				netPid = pid
			}
		}
		if netPid == "" || len(inodes) == 0 {
			g.warnFdUnreadable(name)
			continue
		}
		// one namespace per container: any of its processes shows the same table
		var ports []uint16
		seen := map[uint16]struct{}{}
		for _, file := range []string{"tcp", "tcp6"} {
			data, err := os.ReadFile(filepath.Join(g.procRoot, netPid, "net", file))
			if err != nil {
				continue
			}
			for _, l := range parseListenSockets(string(data)) {
				if _, mine := inodes[l.inode]; !mine {
					continue
				}
				if _, dup := seen[l.port]; dup {
					continue
				}
				seen[l.port] = struct{}{}
				ports = append(ports, l.port)
			}
		}
		if len(ports) > 0 {
			sort.Slice(ports, func(i, j int) bool { return ports[i] < ports[j] })
			result[name] = ports
		}
	}
	return result
}

// collectSocketInodes adds the pid's socket inodes; false if its fd
// directory couldn't be listed (gone, or no ptrace-read access).
func (g *gpuAttributor) collectSocketInodes(pid string, inodes map[uint64]struct{}) bool {
	dir := filepath.Join(g.procRoot, pid, "fd")
	f, err := os.Open(dir)
	if err != nil {
		return false
	}
	defer f.Close()
	fds, err := f.Readdirnames(-1)
	if err != nil && len(fds) == 0 {
		return false
	}
	for _, fd := range fds {
		link, err := os.Readlink(filepath.Join(dir, fd))
		if err != nil {
			continue
		}
		if inode, ok := parseSocketLink(link); ok {
			inodes[inode] = struct{}{}
		}
	}
	return true
}

func (g *gpuAttributor) warnFdUnreadable(name string) {
	if g.listenWarned {
		return
	}
	g.listenWarned = true
	slog.Warn("Listening ports: can't read the fds of host-network container processes (run the agent with CAP_SYS_PTRACE)", "container", name)
}

// parseSocketLink parses the target of an fd link, "socket:[12345]".
func parseSocketLink(link string) (uint64, bool) {
	rest, ok := strings.CutPrefix(link, "socket:[")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimSuffix(rest, "]"), 10, 64)
	return n, err == nil
}

type listenSocket struct {
	port  uint16
	inode uint64
}

// parseListenSockets returns the LISTEN (state 0A) sockets of a
// /proc/net/tcp or tcp6 table that are bound to a non-loopback address.
func parseListenSockets(table string) []listenSocket {
	var out []listenSocket
	for i, line := range strings.Split(table, "\n") {
		if i == 0 { // header
			continue
		}
		f := strings.Fields(line)
		if len(f) < 10 || f[3] != "0A" {
			continue
		}
		addr, portHex, ok := strings.Cut(f[1], ":")
		if !ok {
			continue
		}
		ip := parseProcNetIP(addr)
		if ip == nil || ip.IsLoopback() {
			continue
		}
		port, err := strconv.ParseUint(portHex, 16, 16)
		if err != nil || port == 0 {
			continue
		}
		inode, err := strconv.ParseUint(f[9], 10, 64)
		if err != nil || inode == 0 {
			continue
		}
		out = append(out, listenSocket{port: uint16(port), inode: inode})
	}
	return out
}

// parseProcNetIP decodes an address column of /proc/net/tcp{,6}: every
// 32-bit word is printed in host (little-endian) byte order.
func parseProcNetIP(s string) net.IP {
	b, err := hex.DecodeString(s)
	if err != nil || (len(b) != 4 && len(b) != 16) {
		return nil
	}
	for w := 0; w < len(b); w += 4 {
		b[w], b[w+1], b[w+2], b[w+3] = b[w+3], b[w+2], b[w+1], b[w]
	}
	return net.IP(b)
}
