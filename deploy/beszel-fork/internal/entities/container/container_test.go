package container

import (
	"testing"

	"github.com/fxamacker/cbor/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// gpu-monitoring fork: Pid (cbor 106) travels from the agent to the hub, and an
// older agent that does not send it decodes to 0, which the hub stores as "unknown".
func TestStatsPidTransport(t *testing.T) {
	data, err := cbor.Marshal(Stats{Name: "vllm", Id: "abc123def456", Pid: 48213, GpuPid: "2611205,2611206"})
	require.NoError(t, err)
	var back Stats
	require.NoError(t, cbor.Unmarshal(data, &back))
	assert.Equal(t, uint32(48213), back.Pid)
	assert.Equal(t, "2611205,2611206", back.GpuPid)

	// no PID: the key is left out of the payload
	data, err = cbor.Marshal(Stats{Name: "vllm", Id: "abc123def456"})
	require.NoError(t, err)
	var raw map[int]any
	require.NoError(t, cbor.Unmarshal(data, &raw))
	assert.NotContains(t, raw, 106)

	// an older agent's payload has no key 106
	old, err := cbor.Marshal(map[int]any{0: "vllm", 7: "abc123def456"})
	require.NoError(t, err)
	var oldBack Stats
	require.NoError(t, cbor.Unmarshal(old, &oldBack))
	assert.Equal(t, uint32(0), oldBack.Pid)
}
