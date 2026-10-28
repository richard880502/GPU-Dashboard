package agent

import (
	"strconv"
	"testing"

	"github.com/henrygd/beszel/internal/entities/container"
	"github.com/stretchr/testify/assert"
)

func TestFormatPortMap(t *testing.T) {
	p := func(ip string, pub, priv uint16, typ string) container.ApiPort {
		return container.ApiPort{IP: ip, PublicPort: pub, PrivatePort: priv, Type: typ}
	}
	tests := []struct {
		name  string
		ports []container.ApiPort
		mode  string
		want  string
	}{
		{"nothing published", nil, "bridge", ""},
		{"exposed only, not published", []container.ApiPort{p("", 0, 8000, "tcp")}, "bridge", ""},
		{"host network", []container.ApiPort{p("0.0.0.0", 8000, 8000, "tcp")}, "host", "host"},
		{"host network without ports", nil, "host", "host"},
		{"single", []container.ApiPort{p("0.0.0.0", 18000, 8000, "tcp")}, "default", "18000→8000"},
		{
			"IPv4 and IPv6 wildcard collapse",
			[]container.ApiPort{p("0.0.0.0", 8000, 8000, "tcp"), p("::", 8000, 8000, "tcp")},
			"bridge", "8000→8000",
		},
		{"bound ip kept", []container.ApiPort{p("127.0.0.1", 9000, 9000, "tcp")}, "bridge", "127.0.0.1:9000→9000"},
		{"udp marked, tcp default and missing type", []container.ApiPort{p("", 53, 53, "udp"), p("", 80, 80, "")}, "bridge", "53→53/udp, 80→80"},
		{
			"same host port on tcp and udp stay separate",
			[]container.ApiPort{p("0.0.0.0", 7000, 7000, "udp"), p("0.0.0.0", 7000, 7000, "tcp")},
			"bridge", "7000→7000, 7000→7000/udp",
		},
		{
			"consecutive ports become a range",
			[]container.ApiPort{
				p("0.0.0.0", 8003, 8003, "tcp"), p("0.0.0.0", 8001, 8001, "tcp"),
				p("0.0.0.0", 8002, 8002, "tcp"), p("0.0.0.0", 8000, 8000, "tcp"),
			},
			"bridge", "8000-8003→8000-8003",
		},
		{
			"offset range, gap splits it",
			[]container.ApiPort{
				p("", 18000, 8000, "tcp"), p("", 18001, 8001, "tcp"), p("", 18003, 8003, "tcp"),
			},
			"bridge", "18000-18001→8000-8001, 18003→8003",
		},
		{
			"host ports consecutive but container ports are not: no range",
			[]container.ApiPort{p("", 8000, 9000, "tcp"), p("", 8001, 9005, "tcp")},
			"bridge", "8000→9000, 8001→9005",
		},
		{
			"sorted by host port",
			[]container.ApiPort{p("", 9000, 1, "tcp"), p("", 80, 2, "tcp"), p("", 443, 3, "tcp")},
			"bridge", "80→2, 443→3, 9000→1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, formatPortMap(tt.ports, tt.mode))
		})
	}
}

func TestFormatListenPorts(t *testing.T) {
	many := make([]uint16, 0, 60)
	for i := 0; i < 60; i++ {
		many = append(many, uint16(1000+i*2)) // 60 separate ports
	}
	tests := []struct {
		name  string
		ports []uint16
		want  string
	}{
		{"none", nil, ""},
		{"zero ignored", []uint16{0}, ""},
		{"single", []uint16{8000}, "L:8000"},
		{"sorted and deduped", []uint16{8265, 8000, 8000, 6379}, "L:6379, 8000, 8265"},
		{"consecutive ports become a range", []uint16{10002, 10003, 10004, 8000, 10006}, "L:8000, 10002-10004, 10006"},
		{"ephemeral ports go last", []uint16{45999, 8000, 33000, 33001}, "L:8000, 33000-33001, 45999"},
		{"only ephemeral ports", []uint16{45999}, "L:45999"},
		{"capped at 20 entries, low ports first", append(append([]uint16{}, many...), 45999), "L:" + func() string {
			s := ""
			for i := 0; i < 20; i++ {
				if i > 0 {
					s += ", "
				}
				s += strconv.Itoa(1000 + i*2)
			}
			return s
		}()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, formatListenPorts(tt.ports))
		})
	}
}
