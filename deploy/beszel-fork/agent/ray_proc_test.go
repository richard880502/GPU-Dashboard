package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestClassifyRayProc(t *testing.T) {
	const r = "/usr/local/lib/python3.12/dist-packages/ray"
	tests := []struct {
		name string
		argv []string
		want rayProc
	}{
		{"empty", nil, rayProc{}},
		{"vllm serve is not Ray", []string{"/usr/bin/python3", "/usr/local/bin/vllm", "serve", "--distributed-executor-backend", "ray", "--port", "8287"}, rayProc{}},
		{"uvicorn", []string{"python", "-m", "uvicorn", "app:app"}, rayProc{}},
		{"idle worker", []string{"ray::IDLE"}, rayProc{internal: true}},
		{"actor", []string{"ray::RayWorkerWrapper.execute_method"}, rayProc{internal: true}},
		{"serve proxy actor is the service", []string{"ray::ProxyActor"}, rayProc{}},
		{"serve replica is the service", []string{"ray::ServeReplica:app:Model"}, rayProc{}},
		{"raylet", []string{r + "/core/src/ray/raylet/raylet", "--gcs-address=10.0.0.1:6380"}, rayProc{internal: true, worker: true, headAddr: "10.0.0.1"}},
		{"gcs_server", []string{r + "/core/src/ray/gcs/gcs_server", "--gcs_server_port=6380"}, rayProc{internal: true, head: true}},
		{"dashboard", []string{"python3", "-u", r + "/dashboard/dashboard.py", "--port=8265"}, rayProc{internal: true, head: true}},
		{"dashboard agent", []string{"python3", "-u", r + "/dashboard/agent.py"}, rayProc{internal: true}},
		{"autoscaler monitor", []string{"python3", "-u", r + "/autoscaler/_private/monitor.py"}, rayProc{internal: true, head: true}},
		{"log monitor", []string{"python3", r + "/_private/log_monitor.py"}, rayProc{internal: true}},
		{"ray start --head", []string{"python3", "/usr/local/bin/ray", "start", "--head", "--block"}, rayProc{internal: true, head: true}},
		{"ray start --address=", []string{"python3", "/usr/local/bin/ray", "start", "--address=10.0.0.1:6380", "--block"}, rayProc{internal: true, worker: true, headAddr: "10.0.0.1"}},
		{"ray start --address x", []string{"/usr/local/bin/ray", "start", "--address", "head.local:6380"}, rayProc{internal: true, worker: true, headAddr: "head.local"}},
		{"ray start --address=auto", []string{"/usr/local/bin/ray", "start", "--address=auto"}, rayProc{internal: true, worker: true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, classifyRayProc(tt.argv))
		})
	}
}

func TestHostOfAddress(t *testing.T) {
	assert.Equal(t, "192.168.1.79", hostOfAddress("192.168.1.79:6380"))
	assert.Equal(t, "192.168.1.79", hostOfAddress("192.168.1.79"))
	assert.Equal(t, "::1", hostOfAddress("[::1]:6380"))
	assert.Equal(t, "head.local", hostOfAddress("head.local:6380"))
	assert.Equal(t, "", hostOfAddress("auto"))
	assert.Equal(t, "", hostOfAddress("ray://10.0.0.1:10001"))
	assert.Equal(t, "", hostOfAddress("10.0.0.1;rm -rf"), "only address characters survive")
	assert.Equal(t, "", hostOfAddress(""))
}

func TestRayNodeRole(t *testing.T) {
	var worker rayNode
	worker.add(rayProc{internal: true, worker: true, headAddr: "10.0.0.1"})
	assert.Equal(t, "worker", worker.role())
	assert.Equal(t, "10.0.0.1", worker.headAddr())

	// a head's raylet also has --gcs-address (itself): head wins, no head address
	var head rayNode
	head.add(rayProc{internal: true, worker: true, headAddr: "10.0.0.1"})
	head.add(rayProc{internal: true, head: true})
	assert.Equal(t, "head", head.role())
	assert.Empty(t, head.headAddr())

	var none rayNode
	none.add(rayProc{})
	assert.Empty(t, none.role())
}

func TestFormatContainerListen(t *testing.T) {
	assert.Equal(t, "", formatContainerListen(containerListen{}))
	assert.Equal(t, "L:8000", formatContainerListen(containerListen{ports: []uint16{8000}}))
	assert.Equal(t, "R:head", formatContainerListen(containerListen{role: "head"}))
	assert.Equal(t, "R:head;L:8287", formatContainerListen(containerListen{role: "head", ports: []uint16{8287}}))
	assert.Equal(t, "R:worker", formatContainerListen(containerListen{role: "worker"}))
	assert.Equal(t, "R:worker=10.0.0.1", formatContainerListen(containerListen{role: "worker", head: "10.0.0.1"}))
	assert.True(t, isListenPortMap("host"))
	assert.True(t, isListenPortMap("L:8000"))
	assert.True(t, isListenPortMap("R:head;L:8000"))
	assert.False(t, isListenPortMap("8000→8000"))
	assert.False(t, isListenPortMap(""))
}
