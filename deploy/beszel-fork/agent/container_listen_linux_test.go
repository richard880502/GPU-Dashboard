//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/henrygd/beszel/internal/entities/container"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

// tcpLine builds one /proc/net/tcp row. addr is the 8 (v4) or 32 (v6) hex
// digit column exactly as the kernel prints it.
func tcpLine(addr string, port int, state string, inode int) string {
	return "   0: " + addr + ":" + strings.ToUpper(strconv.FormatInt(int64(port), 16)) + " 00000000:0000 " + state +
		" 00000000:00000000 00:00000000 00000000     0        0 " + strconv.Itoa(inode) + " 1 0000000000000000 100 0 0 10 0\n"
}

const (
	anyV4      = "00000000"
	loopbackV4 = "0100007F"
	anyV6      = "00000000000000000000000000000000"
	loopbackV6 = "00000000000000000000000001000000"
)

// fakeListenProc writes a /proc whose pids have a cgroup and socket fds, and a
// net/tcp(6) table shared by all of them (what a host network namespace shows).
func fakeListenProc(t *testing.T, cgroups map[string]string, fds map[string][]int, tcp, tcp6 string) string {
	t.Helper()
	root := t.TempDir()
	for pid, cg := range cgroups {
		require.NoError(t, os.MkdirAll(filepath.Join(root, pid, "net"), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(root, pid, "cgroup"), []byte(cg), 0o644))
		require.NoError(t, os.WriteFile(filepath.Join(root, pid, "net", "tcp"), []byte(tcp), 0o644))
		require.NoError(t, os.WriteFile(filepath.Join(root, pid, "net", "tcp6"), []byte(tcp6), 0o644))
		if inodes, ok := fds[pid]; ok {
			fdDir := filepath.Join(root, pid, "fd")
			require.NoError(t, os.MkdirAll(fdDir, 0o755))
			for i, inode := range inodes {
				require.NoError(t, os.Symlink("socket:["+strconv.Itoa(inode)+"]", filepath.Join(fdDir, strconv.Itoa(i+3))))
			}
			require.NoError(t, os.Symlink("/dev/null", filepath.Join(fdDir, "0"))) // not a socket
		}
	}
	return root
}

func TestListenPortsHostNetworkContainer(t *testing.T) {
	vllmID := strings.Repeat("a", 64)
	otherID := strings.Repeat("b", 64)
	cg := func(id string) string { return "0::/system.slice/docker-" + id + ".scope\n" }

	// the whole machine's listeners, as every host-network process sees them
	tcp := tcpHeader +
		tcpLine(anyV4, 8000, "0A", 1111) + // vllm API
		tcpLine(loopbackV4, 9000, "0A", 2222) + // vllm, loopback only
		tcpLine(anyV4, 8265, "0A", 3333) + // vllm's second process
		tcpLine(anyV4, 7000, "0A", 4444) + // another container
		tcpLine(anyV4, 22, "0A", 5555) + // sshd on the host
		tcpLine(anyV4, 8000, "01", 6666) + // established, not listening
		tcpLine("0A00A8C0", 6379, "0A", 7777) // vllm, bound to 192.168.0.10
	tcp6 := tcpHeader +
		tcpLine(anyV6, 8000, "0A", 8888) + // vllm, IPv6 twin of 8000
		tcpLine(loopbackV6, 9100, "0A", 9999) // vllm, ::1 only

	root := fakeListenProc(t,
		map[string]string{
			"100": cg(vllmID),
			"101": cg(vllmID),
			"200": cg(otherID),
			"300": "0::/user.slice/session-3.scope\n",
			"400": "", // exited between the listing and the read
		},
		map[string][]int{
			"100": {1111, 2222, 8888, 9999},
			"101": {3333, 7777},
			"200": {4444},
			"300": {5555},
		}, tcp, tcp6)

	scans := 0
	g := &gpuAttributor{
		procRoot: root,
		dockerNames: func() map[string]string {
			scans++
			return map[string]string{vllmID: "vllm_gemma4_ray", otherID: "other"}
		},
	}

	got := g.listenPorts([]string{"vllm_gemma4_ray"})
	require.Contains(t, got, "vllm_gemma4_ray")
	assert.Equal(t, []uint16{6379, 8000, 8265}, got["vllm_gemma4_ray"].ports,
		"only the container's own sockets, external only, v4/v6 merged")
	assert.Empty(t, got["vllm_gemma4_ray"].role, "no cmdline: not a Ray node, nothing filtered")

	// cached within the TTL for the same container set
	_ = g.listenPorts([]string{"vllm_gemma4_ray"})
	assert.Equal(t, 1, scans)
	// a different set rescans
	got = g.listenPorts([]string{"other", "vllm_gemma4_ray"})
	assert.Equal(t, 2, scans)
	assert.Equal(t, []uint16{7000}, got["other"].ports)
}

func TestListenPortsUnreadableFds(t *testing.T) {
	id := strings.Repeat("c", 64)
	root := fakeListenProc(t,
		map[string]string{"100": "0::/system.slice/docker-" + id + ".scope\n"},
		nil, // no fd directory: no ptrace-read access
		tcpHeader+tcpLine(anyV4, 8000, "0A", 1111), tcpHeader)
	g := &gpuAttributor{procRoot: root, dockerNames: func() map[string]string { return map[string]string{id: "svc"} }}
	assert.Empty(t, g.listenPorts([]string{"svc"}), "no fds, no guess: the container stays 'host'")
	assert.True(t, g.listenWarned)
}

func TestListenPortsNilAndEmpty(t *testing.T) {
	var g *gpuAttributor // HOST_PROC not set
	assert.Nil(t, g.listenPorts([]string{"x"}))
	assert.Nil(t, (&gpuAttributor{}).listenPorts(nil))
	assert.Nil(t, (&gpuAttributor{procRoot: t.TempDir()}).listenPorts([]string{"x"}), "no Docker names")
}

func TestParseProcNetIP(t *testing.T) {
	assert.Equal(t, "127.0.0.1", parseProcNetIP("0100007F").String())
	assert.Equal(t, "192.168.0.10", parseProcNetIP("0A00A8C0").String())
	assert.Equal(t, "::1", parseProcNetIP(loopbackV6).String())
	assert.Equal(t, "::", parseProcNetIP(anyV6).String())
	assert.Equal(t, "127.0.0.1", parseProcNetIP("0000000000000000FFFF00000100007F").String(), "IPv4-mapped loopback")
	assert.True(t, parseProcNetIP("0000000000000000FFFF00000100007F").IsLoopback())
	assert.Nil(t, parseProcNetIP("zz"))
	assert.Nil(t, parseProcNetIP("0100"))
}

func TestParseSocketLink(t *testing.T) {
	n, ok := parseSocketLink("socket:[12345]")
	assert.True(t, ok)
	assert.Equal(t, uint64(12345), n)
	_, ok = parseSocketLink("/dev/null")
	assert.False(t, ok)
	_, ok = parseSocketLink("anon_inode:[eventpoll]")
	assert.False(t, ok)
}

func TestApplyListenPorts(t *testing.T) {
	id := strings.Repeat("d", 64)
	root := fakeListenProc(t,
		map[string]string{"100": "0::/system.slice/docker-" + id + ".scope\n"},
		map[string][]int{"100": {1111}},
		tcpHeader+tcpLine(anyV4, 8000, "0A", 1111), tcpHeader)
	a := &Agent{gpuAttribution: &gpuAttributor{procRoot: root, dockerNames: func() map[string]string {
		return map[string]string{id: "vllm"}
	}}}
	byPID := map[pidIndex]pidContainer{{pid: "100", index: "0"}: {container: "vllm"}}
	vllm := &container.Stats{Name: "vllm", PortMap: "host"}
	published := &container.Stats{Name: "web", PortMap: "8080→80"}
	idle := &container.Stats{Name: "idle-host-net", PortMap: "host"} // no GPU process: not scanned
	all := []*container.Stats{vllm, published, idle}

	a.applyListenPorts(all, byPID)
	assert.Equal(t, "L:8000", vllm.PortMap)
	assert.Equal(t, "8080→80", published.PortMap)
	assert.Equal(t, "host", idle.PortMap)

	// the stats object is reused next poll: it is re-evaluated, and falls
	// back to "host" once nothing listens
	require.NoError(t, os.WriteFile(filepath.Join(root, "100", "net", "tcp"), []byte(tcpHeader), 0o644))
	a.gpuAttribution.listenAt = a.gpuAttribution.listenAt.Add(-2 * listenScanTTL)
	a.applyListenPorts(all, byPID)
	assert.Equal(t, "host", vllm.PortMap)

	// without HOST_PROC the container stays "host"
	(&Agent{}).applyListenPorts(all, byPID)
	assert.Equal(t, "host", vllm.PortMap)
}

// writeCmdline writes /proc/<pid>/cmdline (NUL-separated arguments).
func writeCmdline(t *testing.T, root, pid string, args ...string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(root, pid, "cmdline"), []byte(strings.Join(args, "\x00")+"\x00"), 0o644))
}

const rayBin = "/usr/local/lib/python3.12/dist-packages/ray"

// A Ray head running `vllm serve --port 8287`: the service's socket is kept,
// everything the Ray runtime opened is dropped, and the container is a head.
func TestListenPortsRayHead(t *testing.T) {
	id := strings.Repeat("e", 64)
	cg := "0::/system.slice/docker-" + id + ".scope\n"
	tcp := tcpHeader +
		tcpLine(anyV4, 8287, "0A", 1001) + // vllm serve
		tcpLine(anyV4, 8000, "0A", 1002) + // Ray Serve proxy actor
		tcpLine(anyV4, 6380, "0A", 2001) + // gcs_server
		tcpLine(anyV4, 8265, "0A", 2002) + // dashboard
		tcpLine("0A00A8C0", 10002, "0A", 3001) + // ray::RayWorkerWrapper
		tcpLine(anyV4, 40001, "0A", 3002) + // raylet node manager
		tcpLine(anyV4, 52365, "0A", 3003) + // dashboard agent
		tcpLine(anyV4, 22, "0A", 4001) // host sshd, not the container's
	root := fakeListenProc(t,
		map[string]string{"10": cg, "11": cg, "12": cg, "13": cg, "14": cg, "15": cg, "16": cg, "17": cg},
		map[string][]int{
			"10": {1001},
			"11": {2001},
			"12": {2002},
			"13": {3001},
			"14": {3002},
			"15": {3003},
			"16": {1002},
		}, tcp, tcpHeader)
	writeCmdline(t, root, "10", "/usr/bin/python3", "/usr/local/bin/vllm", "serve", "/workspace/llm_model", "--port", "8287", "--distributed-executor-backend", "ray")
	writeCmdline(t, root, "11", rayBin+"/core/src/ray/gcs/gcs_server", "--log_dir=/tmp/ray/session/logs", "--gcs_server_port=6380")
	writeCmdline(t, root, "12", "/usr/bin/python3", "-u", rayBin+"/dashboard/dashboard.py", "--host=0.0.0.0", "--port=8265")
	writeCmdline(t, root, "13", "ray::RayWorkerWrapper")
	writeCmdline(t, root, "14", rayBin+"/core/src/ray/raylet/raylet", "--gcs-address=192.168.1.79:6380")
	writeCmdline(t, root, "15", "/usr/bin/python3", "-u", rayBin+"/dashboard/agent.py", "--node-ip-address=192.168.1.79")
	writeCmdline(t, root, "16", "ray::ProxyActor")
	// `ray start --head --block` itself
	writeCmdline(t, root, "17", "/usr/bin/python3.12", "/usr/local/bin/ray", "start", "--head", "--port=6380", "--block")

	g := &gpuAttributor{procRoot: root, dockerNames: func() map[string]string { return map[string]string{id: "vllm_gemma4_ray"} }}
	got := g.listenPorts([]string{"vllm_gemma4_ray"})["vllm_gemma4_ray"]
	assert.Equal(t, []uint16{8000, 8287}, got.ports, "the vLLM API and the Ray Serve proxy; no GCS, dashboard, raylet, worker or agent port")
	assert.Equal(t, "head", got.role)
	assert.Empty(t, got.head)
	assert.Equal(t, "R:head;L:8000, 8287", formatContainerListen(got))
}

// A Ray worker has no service of its own: its sockets are all the runtime's.
func TestListenPortsRayWorker(t *testing.T) {
	id := strings.Repeat("f", 64)
	cg := "0::/system.slice/docker-" + id + ".scope\n"
	tcp := tcpHeader +
		tcpLine(anyV4, 10002, "0A", 3001) +
		tcpLine(anyV4, 33229, "0A", 3002) +
		tcpLine(anyV4, 35417, "0A", 3003) +
		tcpLine(anyV4, 52365, "0A", 3004)
	root := fakeListenProc(t,
		map[string]string{"10": cg, "11": cg, "12": cg, "13": cg},
		map[string][]int{"10": {3001}, "11": {3002}, "12": {3003}, "13": {3004}}, tcp, tcpHeader)
	writeCmdline(t, root, "10", "ray::IDLE")
	writeCmdline(t, root, "11", rayBin+"/core/src/ray/raylet/raylet", "--gcs-address=192.168.1.79:6380", "--node_ip_address=192.168.1.80")
	writeCmdline(t, root, "12", "/usr/bin/python3", rayBin+"/_private/log_monitor.py")
	writeCmdline(t, root, "13", "/usr/bin/python3.12", "/usr/local/bin/ray", "start", "--address=192.168.1.79:6380", "--node-ip-address=192.168.1.80", "--disable-usage-stats", "--block")

	g := &gpuAttributor{procRoot: root, dockerNames: func() map[string]string { return map[string]string{id: "vllm_gemma4_ray"} }}
	got := g.listenPorts([]string{"vllm_gemma4_ray"})["vllm_gemma4_ray"]
	assert.Empty(t, got.ports)
	assert.Equal(t, "worker", got.role)
	assert.Equal(t, "192.168.1.79", got.head)
	assert.Equal(t, "R:worker=192.168.1.79", formatContainerListen(got))
}

// Without the `ray start` process (it exits unless --block) a worker is still
// recognized from its raylet, and the head address comes from --gcs-address.
func TestListenPortsRayWorkerWithoutCLI(t *testing.T) {
	id := strings.Repeat("9", 64)
	cg := "0::/system.slice/docker-" + id + ".scope\n"
	root := fakeListenProc(t, map[string]string{"10": cg}, map[string][]int{"10": {3001}},
		tcpHeader+tcpLine(anyV4, 40001, "0A", 3001), tcpHeader)
	writeCmdline(t, root, "10", rayBin+"/core/src/ray/raylet/raylet", "--gcs-address=192.168.1.79:6380")
	g := &gpuAttributor{procRoot: root, dockerNames: func() map[string]string { return map[string]string{id: "w"} }}
	got := g.listenPorts([]string{"w"})["w"]
	assert.Equal(t, "worker", got.role)
	assert.Equal(t, "192.168.1.79", got.head)
	assert.Empty(t, got.ports)
}

// A plain host-network service next to nothing Ray: all ports stay.
func TestListenPortsNonRayKeepsEverything(t *testing.T) {
	id := strings.Repeat("8", 64)
	cg := "0::/system.slice/docker-" + id + ".scope\n"
	root := fakeListenProc(t, map[string]string{"10": cg}, map[string][]int{"10": {1001, 1002}},
		tcpHeader+tcpLine(anyV4, 8000, "0A", 1001)+tcpLine(anyV4, 10002, "0A", 1002), tcpHeader)
	writeCmdline(t, root, "10", "/usr/bin/python3", "-m", "uvicorn", "app:app", "--port", "8000")
	g := &gpuAttributor{procRoot: root, dockerNames: func() map[string]string { return map[string]string{id: "svc"} }}
	got := g.listenPorts([]string{"svc"})["svc"]
	assert.Equal(t, []uint16{8000, 10002}, got.ports)
	assert.Empty(t, got.role)
	assert.Equal(t, "L:8000, 10002", formatContainerListen(got))
}

// A socket inherited by a service process is the service's even if a Ray
// process holds it too; an unreadable cmdline filters nothing.
func TestListenPortsSharedSocketAndUnreadableCmdline(t *testing.T) {
	id := strings.Repeat("7", 64)
	cg := "0::/system.slice/docker-" + id + ".scope\n"
	root := fakeListenProc(t, map[string]string{"10": cg, "11": cg, "12": cg},
		map[string][]int{"10": {1001}, "11": {1001, 1002}, "12": {1003}},
		tcpHeader+tcpLine(anyV4, 8287, "0A", 1001)+tcpLine(anyV4, 10002, "0A", 1002)+tcpLine(anyV4, 9000, "0A", 1003), tcpHeader)
	writeCmdline(t, root, "10", "/usr/bin/python3", "/usr/local/bin/vllm", "serve")
	writeCmdline(t, root, "11", "ray::RayWorkerWrapper")
	// pid 12 has no cmdline file: treated as an ordinary process
	g := &gpuAttributor{procRoot: root, dockerNames: func() map[string]string { return map[string]string{id: "svc"} }}
	got := g.listenPorts([]string{"svc"})["svc"]
	assert.Equal(t, []uint16{8287, 9000}, got.ports, "10002 is only held by a Ray worker")
}

func TestApplyListenPortsRayRole(t *testing.T) {
	id := strings.Repeat("6", 64)
	cg := "0::/system.slice/docker-" + id + ".scope\n"
	root := fakeListenProc(t, map[string]string{"10": cg}, map[string][]int{"10": {3001}},
		tcpHeader+tcpLine(anyV4, 10002, "0A", 3001), tcpHeader)
	writeCmdline(t, root, "10", "/usr/bin/python3.12", "/usr/local/bin/ray", "start", "--address=192.168.1.79:6380", "--block")
	a := &Agent{gpuAttribution: &gpuAttributor{procRoot: root, dockerNames: func() map[string]string { return map[string]string{id: "ray"} }}}
	byPID := map[pidIndex]pidContainer{{pid: "10", index: "0"}: {container: "ray"}}
	c := &container.Stats{Name: "ray", PortMap: "host"}
	a.applyListenPorts([]*container.Stats{c}, byPID)
	assert.Equal(t, "R:worker=192.168.1.79", c.PortMap)
	// reused stats object with an earlier "R:" text is re-evaluated
	a.gpuAttribution.listenAt = a.gpuAttribution.listenAt.Add(-2 * listenScanTTL)
	a.applyListenPorts([]*container.Stats{c}, byPID)
	assert.Equal(t, "R:worker=192.168.1.79", c.PortMap)
}
