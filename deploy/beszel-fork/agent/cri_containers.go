package agent

// gpu-monitoring fork addition (not upstream): surfaces containerd/CRI
// (Kubernetes) containers on the same Containers page as Docker containers
// -- a k8s node's pods aren't visible on the Docker socket at all under the
// (normal, current) containerd/CRI-O runtime setup. Reads whatever CRI
// gives us via crictl: CPU%, memory, ports, image, and running state.
//
// Network and Docker-style health checks are NOT available here and are
// left unset rather than faked: network stats are pod/sandbox-level in
// CRI, not per-container, and Docker's health checks have no CRI
// equivalent -- k8s liveness/readiness probe results live in kubelet, not
// on the CRI socket.
//
// Reuses gpu-process-exporter's CRI_SOCKET_PATH / CRI_EXEC_CONTAINER env
// vars (see deploy/docker/gpu-process-exporter): some hosts run their whole
// k8s node nested inside another Docker container (e.g. a k3s-in-docker
// sandbox), where the CRI socket lives in that container's own /run and
// can't be bind-mounted out. CRI_EXEC_CONTAINER routes crictl through the
// Docker Engine API's exec endpoints (over the same docker.sock this agent
// already uses for its own container stats) instead of running it
// directly. Container names use the same "k8s:<namespace>/<pod>/<container>"
// format as gpu-process-exporter's PID attribution, so GPU stats collected
// there (agent/gpu_process_container.go) merge onto these rows automatically.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/henrygd/beszel/agent/utils"
	"github.com/henrygd/beszel/internal/entities/container"
)

type criCollector struct {
	socket        string
	execContainer string
	client        *http.Client // only used when execContainer is set
}

// newCRICollector returns nil (harmless no-op) unless CRI_SOCKET_PATH is set.
func newCRICollector(dockerClient *http.Client) *criCollector {
	socket, ok := utils.GetEnv("CRI_SOCKET_PATH")
	if !ok || socket == "" {
		return nil
	}
	execContainer, _ := utils.GetEnv("CRI_EXEC_CONTAINER")
	if execContainer != "" && dockerClient == nil {
		slog.Warn("CRI_EXEC_CONTAINER set but no Docker client available (DOCKER_HOST disabled?); CRI containers disabled")
		return nil
	}
	return &criCollector{socket: socket, execContainer: execContainer, client: dockerClient}
}

func (c *criCollector) run(args ...string) ([]byte, error) {
	full := append([]string{"--runtime-endpoint", "unix://" + c.socket}, args...)
	if c.execContainer != "" {
		return c.dockerExec(append([]string{"crictl"}, full...))
	}
	return exec.Command("crictl", full...).Output()
}

// dockerExec runs cmd inside c.execContainer via the Docker Engine API's
// exec endpoints, over the same unix-socket client dockerManager uses for
// its own container stats. Tty:true keeps the output stream unframed
// (Docker multiplexes stdout/stderr with 8-byte headers otherwise), which
// is fine here since crictl's JSON goes to stdout and we don't expect
// meaningful stderr output on success.
func (c *criCollector) dockerExec(cmd []string) ([]byte, error) {
	createBody, _ := json.Marshal(map[string]any{
		"Cmd": cmd, "AttachStdout": true, "AttachStderr": true, "Tty": true,
	})
	resp, err := c.client.Post("http://localhost/containers/"+c.execContainer+"/exec", "application/json", bytes.NewReader(createBody))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("create exec: %s: %s", resp.Status, body)
	}
	var created struct {
		Id string
	}
	if err := json.Unmarshal(body, &created); err != nil {
		return nil, err
	}

	startBody, _ := json.Marshal(map[string]any{"Detach": false, "Tty": true})
	resp2, err := c.client.Post("http://localhost/exec/"+created.Id+"/start", "application/json", bytes.NewReader(startBody))
	if err != nil {
		return nil, err
	}
	defer resp2.Body.Close()
	return io.ReadAll(resp2.Body)
}

type criPsResponse struct {
	Containers []struct {
		Id    string `json:"id"`
		Image struct {
			UserSpecifiedImage string `json:"userSpecifiedImage"`
		} `json:"image"`
		ImageRef    string            `json:"imageRef"`
		State       string            `json:"state"`
		CreatedAt   string            `json:"createdAt"` // unix nanoseconds, as a decimal string
		Labels      map[string]string `json:"labels"`
		Annotations map[string]string `json:"annotations"`
	} `json:"containers"`
}

type criStatsResponse struct {
	Stats []struct {
		Attributes struct {
			Id string `json:"id"`
		} `json:"attributes"`
		Cpu struct {
			UsageNanoCores struct {
				Value string `json:"value"`
			} `json:"usageNanoCores"`
		} `json:"cpu"`
		Memory struct {
			WorkingSetBytes struct {
				Value string `json:"value"`
			} `json:"workingSetBytes"`
		} `json:"memory"`
	} `json:"stats"`
}

type criPort struct {
	HostPort int `json:"hostPort"`
}

// collect returns one container.Stats per running CRI container, best-effort
// (a failed or partial crictl call just yields fewer/emptier rows, not an error --
// this must never block the Docker-container stats that share the same poll cycle).
func (c *criCollector) collect() []*container.Stats {
	psOut, err := c.run("ps", "-o", "json")
	if err != nil {
		slog.Debug("crictl ps failed", "err", err)
		return nil
	}
	var ps criPsResponse
	if err := json.Unmarshal(psOut, &ps); err != nil {
		slog.Debug("crictl ps decode failed", "err", err)
		return nil
	}

	var stats criStatsResponse
	statsById := make(map[string]int)
	if statsOut, err := c.run("stats", "-o", "json"); err != nil {
		slog.Debug("crictl stats failed", "err", err)
	} else if err := json.Unmarshal(statsOut, &stats); err != nil {
		slog.Debug("crictl stats decode failed", "err", err)
	} else {
		for i, s := range stats.Stats {
			statsById[s.Attributes.Id] = i
		}
	}

	result := make([]*container.Stats, 0, len(ps.Containers))
	for _, ctr := range ps.Containers {
		if ctr.State != "CONTAINER_RUNNING" {
			continue
		}
		pod := ctr.Labels["io.kubernetes.pod.name"]
		containerName := ctr.Labels["io.kubernetes.container.name"]
		namespace := ctr.Labels["io.kubernetes.pod.namespace"]
		if pod == "" || containerName == "" {
			continue
		}

		image := ctr.Image.UserSpecifiedImage
		if image == "" {
			image = ctr.ImageRef
		}

		cs := &container.Stats{
			Name:   fmt.Sprintf("k8s:%s/%s/%s", namespace, pod, containerName),
			Id:     ctr.Id,
			Image:  image,
			Status: formatCRIUptime(ctr.CreatedAt),
		}

		if idx, ok := statsById[ctr.Id]; ok {
			s := stats.Stats[idx]
			if nanocores, err := strconv.ParseFloat(s.Cpu.UsageNanoCores.Value, 64); err == nil {
				cs.Cpu = utils.TwoDecimals(nanocores / 1e9 * 100)
			}
			if usedBytes, err := strconv.ParseFloat(s.Memory.WorkingSetBytes.Value, 64); err == nil {
				cs.Mem = utils.BytesToMegabytes(usedBytes)
			}
		}

		if portsJSON, ok := ctr.Annotations["io.kubernetes.container.ports"]; ok && portsJSON != "" {
			var ports []criPort
			if err := json.Unmarshal([]byte(portsJSON), &ports); err == nil {
				cs.Ports = formatCRIPorts(ports)
			}
		}

		result = append(result, cs)
	}
	return result
}

func formatCRIPorts(ports []criPort) string {
	seen := make(map[int]struct{}, len(ports))
	parts := make([]string, 0, len(ports))
	for _, p := range ports {
		if p.HostPort == 0 {
			continue
		}
		if _, ok := seen[p.HostPort]; ok {
			continue
		}
		seen[p.HostPort] = struct{}{}
		parts = append(parts, strconv.Itoa(p.HostPort))
	}
	return strings.Join(parts, ", ")
}

// formatCRIUptime turns a crictl createdAt (unix nanoseconds, as a decimal
// string) into a Docker-style "Up ..." status string. Falls back to a bare
// "Up" if the timestamp can't be parsed, rather than erroring the whole row.
func formatCRIUptime(createdAtNanos string) string {
	ns, err := strconv.ParseInt(createdAtNanos, 10, 64)
	if err != nil {
		return "Up"
	}
	d := time.Since(time.Unix(0, ns))
	switch {
	case d < time.Minute:
		return "Up Less than a minute"
	case d < time.Hour:
		return fmt.Sprintf("Up %d minutes", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("Up %d hours", int(d.Hours()))
	default:
		return fmt.Sprintf("Up %d days", int(d.Hours()/24))
	}
}
