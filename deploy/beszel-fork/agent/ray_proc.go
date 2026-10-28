package agent

// gpu-monitoring fork addition (not upstream): recognizes the processes of a
// Ray node (vLLM's --distributed-executor-backend ray, Ray Serve, ...) from
// their cmdline, so the GPU process panel can leave the runtime's own
// listening sockets out and say whether a container is the Ray head or a
// worker. Process title / path shapes (Ray 2.x):
//
//	ray::IDLE, ray::RayWorkerWrapper.execute_method   workers and actors (setproctitle)
//	.../ray/core/src/ray/raylet/raylet --gcs-address=IP:PORT ...   every node
//	.../ray/core/src/ray/gcs/gcs_server --gcs_server_port=...      head only
//	python .../ray/dashboard/dashboard.py --port=8265             head only
//	python .../ray/dashboard/agent.py ...                         every node
//	python .../ray/autoscaler/_private/monitor.py                 head only
//	python .../ray/_private/{log_monitor,runtime_env/...}         every node
//	python /usr/local/bin/ray start --head | --address=IP:PORT   the CLI

import (
	"net"
	"path/filepath"
	"strings"
)

// rayProc is what one process's cmdline says about Ray.
type rayProc struct {
	internal bool   // part of the Ray runtime: its sockets are not "the service"
	head     bool   // only a head node runs it (gcs_server, dashboard, ray start --head)
	worker   bool   // says it joins a head (raylet, ray start --address)
	headAddr string // host of the head node it points at, if it says so
}

func classifyRayProc(argv []string) rayProc {
	var p rayProc
	if len(argv) == 0 || argv[0] == "" {
		return p
	}
	if title, ok := strings.CutPrefix(argv[0], "ray::"); ok {
		// Ray Serve's controller / proxy / replicas are Ray actors but *are*
		// the service (the HTTP proxy listens on 8000 by default)
		p.internal = !strings.HasPrefix(title, "Serve") && !strings.HasPrefix(title, "ProxyActor")
		return p
	}
	base := filepath.Base(argv[0])
	switch base {
	case "raylet":
		p.internal, p.worker = true, true
	case "gcs_server":
		p.internal, p.head = true, true
	}
	for i, arg := range argv {
		switch {
		case strings.Contains(arg, "/ray/core/src/ray/"):
			p.internal = true
		case strings.Contains(arg, "/ray/dashboard/dashboard.py"):
			p.internal, p.head = true, true
		case strings.Contains(arg, "/ray/autoscaler/_private/monitor.py"):
			p.internal, p.head = true, true
		case strings.Contains(arg, "/ray/dashboard/"), strings.Contains(arg, "/ray/_private/"), strings.Contains(arg, "/ray/autoscaler/"):
			p.internal = true
		case filepath.Base(arg) == "ray" && i+1 < len(argv) && argv[i+1] == "start":
			p.internal = true
			for j := i + 2; j < len(argv); j++ {
				switch a := argv[j]; {
				case a == "--head":
					p.head = true
				case strings.HasPrefix(a, "--address="):
					p.worker, p.headAddr = true, hostOfAddress(strings.TrimPrefix(a, "--address="))
				case a == "--address" && j+1 < len(argv):
					p.worker, p.headAddr = true, hostOfAddress(argv[j+1])
				}
			}
		}
		for _, flag := range []string{"--gcs-address=", "--gcs_address="} {
			if v, ok := strings.CutPrefix(arg, flag); ok && p.headAddr == "" {
				p.headAddr = hostOfAddress(v)
			}
		}
	}
	return p
}

// hostOfAddress returns the host of "host:port" / "[v6]:port" / "host", "" if
// it isn't an address ("auto", "ray://...").
func hostOfAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" || addr == "auto" || strings.Contains(addr, "://") {
		return ""
	}
	host := strings.Trim(addr, "[]")
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}
	// it ends up in the portMap text and the UI: keep it to address characters
	for _, r := range host {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '.' || r == '-' || r == '_' || r == ':') {
			return ""
		}
	}
	return host
}

// rayNode accumulates the Ray processes of one container.
type rayNode struct {
	head, worker bool
	workerHead   string // head address a worker process points at
	anyHead      string // any address seen (raylet --gcs-address of a head points at itself)
}

func (n *rayNode) add(p rayProc) {
	n.head = n.head || p.head
	n.worker = n.worker || p.worker
	if p.worker && p.headAddr != "" && n.workerHead == "" {
		n.workerHead = p.headAddr
	}
	if p.headAddr != "" && n.anyHead == "" {
		n.anyHead = p.headAddr
	}
}

// role is "head" if the container runs anything only a head runs, "worker"
// if it only joins a head, "" if it isn't a Ray node.
func (n *rayNode) role() string {
	switch {
	case n.head:
		return "head"
	case n.worker:
		return "worker"
	}
	return ""
}

// headAddr is where a worker's head node is, "" for a head or when unknown.
func (n *rayNode) headAddr() string {
	if n.role() != "worker" {
		return ""
	}
	if n.workerHead != "" {
		return n.workerHead
	}
	return n.anyHead
}
