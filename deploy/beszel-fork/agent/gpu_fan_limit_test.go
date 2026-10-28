//go:build testing

package agent

import (
	"testing"

	"github.com/henrygd/beszel/internal/entities/system"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// gpu-monitoring fork: nvidia-smi now also reports fan.speed and power.limit
// (last two CSV columns). "no value" must stay nil, a real 0 must not.
func TestParseNvidiaDataFanAndPowerLimit(t *testing.T) {
	f := func(v float64) *float64 { return &v }

	tests := []struct {
		name      string
		input     string
		wantFan   map[string]*float64
		wantLimit map[string]*float64
	}{
		{
			name:      "fan and limit",
			input:     "0, NVIDIA GeForce RTX 4090, 57, 4822, 24564, 87, 300.18, 51, 450.00\n",
			wantFan:   map[string]*float64{"0": f(51)},
			wantLimit: map[string]*float64{"0": f(450)},
		},
		{
			name:      "fan N/A (no fan, datacenter card)",
			input:     "0, NVIDIA H100, 40, 100, 81559, 10, 120.5, [N/A], 700.00\n",
			wantFan:   map[string]*float64{"0": nil},
			wantLimit: map[string]*float64{"0": f(700)},
		},
		{
			name:      "limit not supported",
			input:     "0, NVIDIA GeForce RTX 3090, 44, 100, 24576, 0, 25, 30, [Not Supported]\n",
			wantFan:   map[string]*float64{"0": f(30)},
			wantLimit: map[string]*float64{"0": nil},
		},
		{
			name:      "insufficient permissions and old-driver N/A",
			input:     "0, NVIDIA A, 40, 1, 2, 3, 4, [Insufficient Permissions], N/A\n",
			wantFan:   map[string]*float64{"0": nil},
			wantLimit: map[string]*float64{"0": nil},
		},
		{
			name:      "zero-fan mode is a real 0, not missing",
			input:     "0, NVIDIA GeForce RTX 3090, 38, 100, 24576, 0, 20, 0, 350.00\n",
			wantFan:   map[string]*float64{"0": f(0)},
			wantLimit: map[string]*float64{"0": f(350)},
		},
		{
			name:      "empty fields",
			input:     "0, NVIDIA A, 40, 1, 2, 3, 4, , \n",
			wantFan:   map[string]*float64{"0": nil},
			wantLimit: map[string]*float64{"0": nil},
		},
		{
			name: "several GPUs keep their own values",
			input: "0, NVIDIA GeForce RTX 4090, 57, 1, 2, 3, 4, 80, 450.00\n" +
				"1, NVIDIA GeForce RTX 4090, 51, 1, 2, 3, 4, [N/A], 450.00\n" +
				"2, NVIDIA GeForce RTX 3090, 50, 1, 2, 3, 4, 60, [Not Supported]\n",
			wantFan:   map[string]*float64{"0": f(80), "1": nil, "2": f(60)},
			wantLimit: map[string]*float64{"0": f(450), "1": f(450), "2": nil},
		},
		{
			name:      "older 7-column output",
			input:     "0, NVIDIA Test GPU, 50, 1024, 4096, 25, 100\n",
			wantFan:   map[string]*float64{"0": nil},
			wantLimit: map[string]*float64{"0": nil},
		},
		{
			name:      "only the fan column present",
			input:     "0, NVIDIA Test GPU, 50, 1024, 4096, 25, 100, 33\n",
			wantFan:   map[string]*float64{"0": f(33)},
			wantLimit: map[string]*float64{"0": nil},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gm := &GPUManager{GpuDataMap: make(map[string]*system.GPUData)}
			require.True(t, gm.parseNvidiaData([]byte(tt.input)))
			for id := range tt.wantFan {
				got := gm.GpuDataMap[id]
				require.NotNil(t, got, "gpu %s", id)
				assert.Equal(t, tt.wantFan[id], got.FanSpeed, "fan gpu %s", id)
				assert.Equal(t, tt.wantLimit[id], got.PowerLimit, "limit gpu %s", id)
			}
		})
	}
}

// the existing columns must still parse the same with the two extra ones
func TestParseNvidiaDataFanColumnsKeepOtherFields(t *testing.T) {
	gm := &GPUManager{GpuDataMap: make(map[string]*system.GPUData)}
	require.True(t, gm.parseNvidiaData([]byte("0, NVIDIA GeForce RTX 4090, 57, 4822, 24564, 87, 300.18, 51, 450.00\n")))
	got := gm.GpuDataMap["0"]
	require.NotNil(t, got)
	assert.Equal(t, "GeForce RTX 4090", got.Name)
	assert.InDelta(t, 57, got.Temperature, 0.01)
	assert.InDelta(t, 87, got.Usage, 0.01)
	assert.InDelta(t, 300.18, got.Power, 0.01)
}

// a card that stops reporting a value must not keep showing the old one, and
// the values reach GetCurrentData untouched (they are instantaneous, not averaged)
func TestFanAndPowerLimitAreInstantaneous(t *testing.T) {
	gm := &GPUManager{GpuDataMap: make(map[string]*system.GPUData)}
	require.True(t, gm.parseNvidiaData([]byte("0, NVIDIA GeForce RTX 4090, 57, 4822, 24564, 87, 300, 51, 450.00\n")))

	got := gm.GetCurrentData(1000)["0"]
	require.NotNil(t, got.FanSpeed)
	assert.Equal(t, 51.0, *got.FanSpeed)
	require.NotNil(t, got.PowerLimit)
	assert.Equal(t, 450.0, *got.PowerLimit)

	// same sample count, new reading: the no-new-data path must still refresh them
	gm.GpuDataMap["0"].FanSpeed = func() *float64 { v := 77.0; return &v }()
	got = gm.GetCurrentData(1000)["0"]
	require.NotNil(t, got.FanSpeed)
	assert.Equal(t, 77.0, *got.FanSpeed)

	// the next sample reports N/A for both
	require.True(t, gm.parseNvidiaData([]byte("0, NVIDIA GeForce RTX 4090, 57, 4822, 24564, 87, 300, [N/A], [Not Supported]\n")))
	got = gm.GetCurrentData(1000)["0"]
	assert.Nil(t, got.FanSpeed)
	assert.Nil(t, got.PowerLimit)
}

func TestParseNvidiaSmiOptional(t *testing.T) {
	for in, wantNil := range map[string]bool{
		"": true, "  ": true, "[N/A]": true, "[Not Supported]": true, "[Unknown Error]": true,
		"N/A": true, "n/a": true, "abc": true, "-5": true,
		"0": false, "51": false, " 450.00 ": false,
	} {
		got := parseNvidiaSmiOptional(in)
		assert.Equal(t, wantNil, got == nil, "input %q", in)
	}
	assert.Equal(t, 450.0, *parseNvidiaSmiOptional(" 450.00 "))
	assert.Equal(t, 0.0, *parseNvidiaSmiOptional("0"))
}
