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
// Ray clusters (vLLM with --distributed-executor-backend ray) fill that list
// with the runtime's own sockets: raylet, workers (10002-19999), the agents'
// metrics ports... none of them is the service. Each process's cmdline is read
// too, so sockets owned only by Ray-internal processes are dropped, and the
// container is labelled a Ray head (runs the GCS / dashboard) or a Ray worker
// (the service port lives on the head node). See ray_proc_linux.go.
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

// listenPorts returns, per container name, its external TCP listen ports and
// Ray role. Containers it can't read are left out.
func (g *gpuAttributor) listenPorts(names []string) map[string]containerListen {
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

func (g *gpuAttributor) scanListenPorts(names []string) map[string]containerListen {
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

	result := make(map[string]containerListen, len(pidsByName))
	for name, pids := range pidsByName {
		// inodes of the container's sockets, split by whether a Ray-internal
		// process holds them (a socket also held by a service process counts
		// as the service's)
		service := map[uint64]struct{}{}
		ray := rayNode{}
		netPid := ""
		readable := false
		for _, pid := range pids {
			proc := g.readRayProc(pid)
			ray.add(proc)
			inodes := map[uint64]struct{}{}
			if !g.collectSocketInodes(pid, inodes) {
				continue
			}
			readable = true
			if netPid == "" {
				netPid = pid
			}
			if proc.internal {
				continue
			}
			for inode := range inodes {
				service[inode] = struct{}{}
			}
		}
		if !readable {
			g.warnFdUnreadable(name)
		}
		entry := containerListen{role: ray.role(), head: ray.headAddr()}
		if netPid != "" && len(service) > 0 {
			// one namespace per container: any of its processes shows the same table
			seen := map[uint16]struct{}{}
			for _, file := range []string{"tcp", "tcp6"} {
				data, err := os.ReadFile(filepath.Join(g.procRoot, netPid, "net", file))
				if err != nil {
					continue
				}
				for _, l := range parseListenSockets(string(data)) {
					if _, mine := service[l.inode]; !mine {
						continue
					}
					if _, dup := seen[l.port]; dup {
						continue
					}
					seen[l.port] = struct{}{}
					entry.ports = append(entry.ports, l.port)
				}
			}
			sort.Slice(entry.ports, func(i, j int) bool { return entry.ports[i] < entry.ports[j] })
		}
		if len(entry.ports) > 0 || entry.role != "" {
			result[name] = entry
		}
	}
	return result
}

// readRayProc classifies a process by its cmdline; an unreadable one (exited,
// or no access) is treated as an ordinary process, i.e. nothing is filtered.
func (g *gpuAttributor) readRayProc(pid string) rayProc {
	data, err := os.ReadFile(filepath.Join(g.procRoot, pid, "cmdline"))
	if err != nil || len(data) == 0 {
		return rayProc{}
	}
	return classifyRayProc(strings.Split(strings.TrimRight(string(data), "\x00"), "\x00"))
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
