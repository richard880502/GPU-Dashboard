//go:build linux

package agent

// gpu-monitoring fork addition (not upstream): maps every GPU-using PID to
// the container it runs in, inside the agent. This replaces reading
// gpu-process-exporter (:5052) and keeps its logic:
//
//   - PIDs per GPU come from nvidia-smi --query-compute-apps.
//   - The container is found by the container ids in the host's
//     /proc/<pid>/cgroup, not by PID: the Docker API and crictl only report
//     a container's entrypoint PID, while the GPU work is often done by
//     workers it forked later (e.g. vLLM's tensor-parallel workers), which
//     share its cgroup.
//   - A cgroup path can hold several 64-hex ids, outermost first (a k8s pod
//     inside the Docker container that runs a nested k3s node, see
//     CRI_EXEC_CONTAINER). The innermost id is the process's own container,
//     so ids are tried from the innermost out, each against Docker and CRI
//     names. (gpu-process-exporter tried Docker for every id first, which
//     could name such a pod after its wrapping Docker container.)
//   - Docker names come from the Docker API, k8s names
//     ("k8s:<namespace>/<pod>/<container>") from crictl, unattributed PIDs
//     become "host:<process name>".
//   - The user is the PID's owner, named via the host's /etc/passwd.
//
// The agent container must share the host's PID namespace (--pid=host):
// newer drivers (580+) hide processes outside the caller's PID namespace from
// nvidia-smi / NVML, and the cgroup lookups need the host's /proc anyway.
// Opt in with HOST_PROC=/proc (with --pid=host) and mount the host's
// /etc/passwd read-only at HOST_PASSWD (default /host/etc/passwd). Without
// HOST_PROC the agent keeps reading gpu-process-exporter: in its own PID
// namespace every GPU process would look unattributed.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/henrygd/beszel/agent/utils"
)

var cgroupIDRegex = regexp.MustCompile(`[0-9a-f]{64}`)

// both callers (container stats and per-GPU processes) run in the same poll
const gpuAttributionCacheTTL = 2 * time.Second

type gpuAttributor struct {
	procRoot   string
	passwdPath string
	// injectable for tests
	computeApps func() ([]pidIndex, error)
	dockerNames func() map[string]string // full container id -> name
	criNames    func() map[string]string // full container id -> "k8s:ns/pod/container"

	mu       sync.Mutex
	cached   map[pidIndex]pidContainer
	cachedAt time.Time
	users    map[uint32]string
	usersAt  time.Time

	// listening ports of host-network GPU containers (container_listen_linux.go)
	listenMu     sync.Mutex
	listenCached map[string][]uint16
	listenKey    string
	listenAt     time.Time
	listenWarned bool
}

// newGpuAttributor returns nil unless HOST_PROC points at a readable host
// /proc, so the caller keeps using gpu-process-exporter.
func newGpuAttributor(dockerClient *http.Client, cri *criCollector) *gpuAttributor {
	procRoot, ok := utils.GetEnv("HOST_PROC")
	if !ok || procRoot == "" {
		slog.Debug("GPU process attribution: HOST_PROC not set, using gpu-process-exporter")
		return nil
	}
	passwdPath := "/host/etc/passwd"
	if v, ok := utils.GetEnv("HOST_PASSWD"); ok && v != "" {
		passwdPath = v
	}
	if _, err := os.ReadFile(filepath.Join(procRoot, "1", "cgroup")); err != nil {
		slog.Warn("GPU process attribution: HOST_PROC not readable, using gpu-process-exporter", "path", procRoot, "err", err)
		return nil
	}
	g := &gpuAttributor{procRoot: procRoot, passwdPath: passwdPath, computeApps: nvidiaSmiComputeApps}
	if dockerClient != nil {
		g.dockerNames = func() map[string]string { return dockerContainerNames(dockerClient) }
	}
	if cri != nil {
		g.criNames = cri.containerNames
	}
	slog.Info("GPU process attribution from host /proc", "path", procRoot)
	return g
}

// containers maps every GPU-using (PID, GPU index) to its container and user.
// nil means the GPU processes couldn't be listed.
func (g *gpuAttributor) containers() map[pidIndex]pidContainer {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cached != nil && time.Since(g.cachedAt) < gpuAttributionCacheTTL {
		return g.cached
	}
	apps, err := g.computeApps()
	if err != nil {
		slog.Debug("GPU process attribution: listing compute apps failed", "err", err)
		return nil
	}
	var dockerNames, criNames map[string]string
	if len(apps) > 0 {
		if g.dockerNames != nil {
			dockerNames = g.dockerNames()
		}
		if g.criNames != nil {
			criNames = g.criNames()
		}
	}
	result := make(map[pidIndex]pidContainer, len(apps))
	for _, key := range apps {
		result[key] = pidContainer{
			container: g.containerFor(key.pid, dockerNames, criNames),
			username:  g.usernameFor(key.pid),
		}
	}
	g.cached, g.cachedAt = result, time.Now()
	return result
}

func (g *gpuAttributor) containerFor(pid string, dockerNames, criNames map[string]string) string {
	cgroup, err := os.ReadFile(filepath.Join(g.procRoot, pid, "cgroup"))
	if err != nil {
		return g.hostLabel(pid)
	}
	ids := cgroupIDRegex.FindAllString(string(cgroup), -1)
	for i := len(ids) - 1; i >= 0; i-- {
		if name, ok := dockerNames[ids[i]]; ok {
			return name
		}
		if name, ok := criNames[ids[i]]; ok {
			return name
		}
	}
	return g.hostLabel(pid)
}

// hostLabel keeps unattributed processes apart: "host:llama-server", not just "host".
func (g *gpuAttributor) hostLabel(pid string) string {
	comm, err := os.ReadFile(filepath.Join(g.procRoot, pid, "comm"))
	if name := strings.TrimSpace(string(comm)); err == nil && name != "" {
		return "host:" + name
	}
	return "host"
}

func (g *gpuAttributor) usernameFor(pid string) string {
	info, err := os.Stat(filepath.Join(g.procRoot, pid))
	if err != nil {
		return "unknown"
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "unknown"
	}
	if g.users == nil || time.Since(g.usersAt) > time.Minute {
		g.users, g.usersAt = readPasswd(g.passwdPath), time.Now()
	}
	if name, ok := g.users[st.Uid]; ok {
		return name
	}
	// same fallback as nvitop-exporter: the raw uid
	return strconv.FormatUint(uint64(st.Uid), 10)
}

func readPasswd(path string) map[uint32]string {
	users := map[uint32]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		return users
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 3 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		if uid, err := strconv.ParseUint(fields[2], 10, 32); err == nil {
			if _, dup := users[uint32(uid)]; !dup {
				users[uint32(uid)] = fields[0]
			}
		}
	}
	return users
}

// nvidiaSmiComputeApps lists (PID, GPU index) for every compute process.
func nvidiaSmiComputeApps() ([]pidIndex, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	gpus, err := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=uuid,index", "--format=csv,noheader").Output()
	if err != nil {
		return nil, err
	}
	apps, err := exec.CommandContext(ctx, "nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader").Output()
	if err != nil {
		return nil, err
	}
	return parseComputeApps(string(gpus), string(apps)), nil
}

func parseComputeApps(gpus, apps string) []pidIndex {
	indexByUUID := map[string]string{}
	for _, row := range csvRows(gpus, 2) {
		indexByUUID[row[0]] = row[1]
	}
	var result []pidIndex
	for _, row := range csvRows(apps, 2) {
		if index, ok := indexByUUID[row[0]]; ok {
			result = append(result, pidIndex{pid: row[1], index: index})
		}
	}
	return result
}

// csvRows splits nvidia-smi's csv output, skipping anything that isn't a
// row of exactly `columns` fields (nvidia-smi prints errors to stdout).
func csvRows(out string, columns int) [][]string {
	var rows [][]string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, ",")
		if len(fields) != columns {
			continue
		}
		for i := range fields {
			fields[i] = strings.TrimSpace(fields[i])
		}
		if fields[0] == "" || fields[1] == "" {
			continue
		}
		rows = append(rows, fields)
	}
	return rows
}

// dockerContainerNames maps every running container's full id to its name.
func dockerContainerNames(client *http.Client) map[string]string {
	resp, err := client.Get("http://localhost/containers/json")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var containers []struct {
		Id    string
		Names []string
	}
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return nil
	}
	names := make(map[string]string, len(containers))
	for _, c := range containers {
		if len(c.Names) > 0 {
			names[c.Id] = strings.TrimPrefix(c.Names[0], "/")
		}
	}
	return names
}

// containerNames maps every running CRI container's full id to
// "k8s:<namespace>/<pod>/<container>", the same name collect() reports.
func (c *criCollector) containerNames() map[string]string {
	out, err := c.run("ps", "-o", "json")
	if err != nil {
		return nil
	}
	var ps criPsResponse
	if err := json.Unmarshal(out, &ps); err != nil {
		return nil
	}
	names := make(map[string]string, len(ps.Containers))
	for _, ctr := range ps.Containers {
		pod := ctr.Labels["io.kubernetes.pod.name"]
		name := ctr.Labels["io.kubernetes.container.name"]
		if pod == "" || name == "" {
			continue
		}
		namespace := ctr.Labels["io.kubernetes.pod.namespace"]
		if namespace == "" {
			namespace = "default"
		}
		names[ctr.Id] = "k8s:" + namespace + "/" + pod + "/" + name
	}
	return names
}
