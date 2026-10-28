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
	assert.Equal(t, map[string][]uint16{"vllm_gemma4_ray": {6379, 8000, 8265}}, got,
		"only the container's own sockets, external only, v4/v6 merged")

	// cached within the TTL for the same container set
	_ = g.listenPorts([]string{"vllm_gemma4_ray"})
	assert.Equal(t, 1, scans)
	// a different set rescans
	got = g.listenPorts([]string{"other", "vllm_gemma4_ray"})
	assert.Equal(t, 2, scans)
	assert.Equal(t, []uint16{7000}, got["other"])
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
