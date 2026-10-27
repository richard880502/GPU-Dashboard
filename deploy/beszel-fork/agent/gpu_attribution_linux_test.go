//go:build linux && testing

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

const (
	dockerID  = "1111111111111111111111111111111111111111111111111111111111111111"
	wrapperID = "2222222222222222222222222222222222222222222222222222222222222222"
	podID     = "3333333333333333333333333333333333333333333333333333333333333333"
)

func fakeProc(t *testing.T, procs map[string][2]string) string {
	t.Helper()
	root := t.TempDir()
	for pid, files := range procs {
		dir := filepath.Join(root, pid)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		if files[0] != "" {
			require.NoError(t, os.WriteFile(filepath.Join(dir, "cgroup"), []byte(files[0]), 0o644))
		}
		if files[1] != "" {
			require.NoError(t, os.WriteFile(filepath.Join(dir, "comm"), []byte(files[1]+"\n"), 0o644))
		}
	}
	return root
}

func TestGpuAttributorResolvesContainers(t *testing.T) {
	root := fakeProc(t, map[string][2]string{
		// plain Docker container (cgroup v2)
		"100": {"0::/system.slice/docker-" + dockerID + ".scope\n", "python3"},
		// k8s pod inside the Docker container running a nested k3s node:
		// the wrapper is a known Docker container too, but the pod is innermost
		"200": {"0::/system.slice/docker-" + wrapperID + ".scope/kubepods/burstable/pod1/cri-containerd-" + podID + ".scope\n", "vllm"},
		// not in a container
		"300": {"0::/user.slice/user-1017.slice/session-3.scope\n", "llama-server"},
		// gone between nvidia-smi and the lookup
		"400": {"", ""},
	})
	passwd := filepath.Join(t.TempDir(), "passwd")
	uid := strconv.Itoa(os.Getuid())
	require.NoError(t, os.WriteFile(passwd, []byte("root:x:0:0::/root:/bin/sh\nalice:x:"+uid+":"+uid+"::/home/alice:/bin/sh\n"), 0o644))

	calls := 0
	g := &gpuAttributor{
		procRoot:   root,
		passwdPath: passwd,
		computeApps: func() ([]pidIndex, error) {
			calls++
			return []pidIndex{
				{pid: "100", index: "0"},
				{pid: "100", index: "1"}, // multi-GPU process
				{pid: "200", index: "1"},
				{pid: "300", index: "0"},
				{pid: "400", index: "0"},
			}, nil
		},
		dockerNames: func() map[string]string {
			return map[string]string{dockerID: "vllm-server", wrapperID: "sandbox-docker"}
		},
		criNames: func() map[string]string { return map[string]string{podID: "k8s:ml/infer-0/worker"} },
	}

	got := g.containers()
	assert.Equal(t, map[pidIndex]pidContainer{
		{pid: "100", index: "0"}: {container: "vllm-server", username: "alice"},
		{pid: "100", index: "1"}: {container: "vllm-server", username: "alice"},
		{pid: "200", index: "1"}: {container: "k8s:ml/infer-0/worker", username: "alice"},
		{pid: "300", index: "0"}: {container: "host:llama-server", username: "alice"},
		{pid: "400", index: "0"}: {container: "host", username: "alice"},
	}, got)

	// both callers in one poll share the result
	g.containers()
	assert.Equal(t, 1, calls)
}

func TestGpuAttributorUsernameFallsBackToUID(t *testing.T) {
	root := fakeProc(t, map[string][2]string{"100": {"0::/\n", "x"}})
	g := &gpuAttributor{procRoot: root, passwdPath: filepath.Join(t.TempDir(), "missing")}
	assert.Equal(t, strconv.Itoa(os.Getuid()), g.usernameFor("100"))
	assert.Equal(t, "unknown", g.usernameFor("999"))
}

func TestParseComputeApps(t *testing.T) {
	gpus := "GPU-aaa, 0\nGPU-bbb, 1\n"
	// nvidia-smi prints errors to stdout; those lines must be skipped
	apps := "GPU-aaa, 4125257\nFailed to initialize NVML: Unknown Error\nGPU-bbb, 4125257\nGPU-zzz, 42\n"
	assert.Equal(t, []pidIndex{{pid: "4125257", index: "0"}, {pid: "4125257", index: "1"}}, parseComputeApps(gpus, apps))
	assert.Empty(t, parseComputeApps("", apps))
}

func TestNewGpuAttributorNeedsHostProc(t *testing.T) {
	// opt-in only: unset means "not in the host's PID namespace"
	t.Setenv("HOST_PROC", "")
	assert.Nil(t, newGpuAttributor(nil, nil))

	t.Setenv("HOST_PROC", filepath.Join(t.TempDir(), "nope"))
	assert.Nil(t, newGpuAttributor(nil, nil))

	root := fakeProc(t, map[string][2]string{"1": {"0::/init.scope\n", "systemd"}})
	t.Setenv("HOST_PROC", root)
	g := newGpuAttributor(nil, nil)
	require.NotNil(t, g)
	assert.Equal(t, root, g.procRoot)
	assert.True(t, strings.HasSuffix(g.passwdPath, "/host/etc/passwd"))
}

func TestReadPasswdKeepsFirstEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "passwd")
	require.NoError(t, os.WriteFile(path, []byte("#comment\nbob:x:1000:1000::/:/bin/sh\nbob2:x:1000:1000::/:/bin/sh\nbad line\n"), 0o644))
	assert.Equal(t, map[uint32]string{1000: "bob"}, readPasswd(path))
}

func TestApplyContainerGPUStatsClearsStaleValues(t *testing.T) {
	stale := &container.Stats{Name: "sandbox_howard", GpuPid: "1551450", GpuMemMiB: 232, GpuIndex: "0"}
	busy := &container.Stats{Name: "vllm"}
	byPID := map[pidIndex]pidContainer{
		{pid: "900", index: "0"}: {container: "vllm"},
		{pid: "12", index: "1"}:  {container: "vllm"},
	}
	applyContainerGPUStats([]*container.Stats{stale, busy}, byPID)
	assert.Equal(t, "", stale.GpuPid, "no GPU process left: fields cleared")
	assert.Zero(t, stale.GpuMemMiB)
	assert.Equal(t, "", stale.GpuIndex)
	assert.Equal(t, "12,900", busy.GpuPid, "pids sorted numerically")
	assert.Equal(t, "0,1", busy.GpuIndex)
}
