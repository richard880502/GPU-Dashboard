#!/usr/bin/env bash
# Run on each GPU server (192.168.1.76-80) as the normal user (no sudo needed —
# these boxes don't grant passwordless sudo, but the deploy user is in the
# `docker` group, so exporters run as containers instead of systemd units).
#
# Deploys two containers:
#   nvitop-exporter        :5051  GPU/host metrics (util, VRAM, temp, power, CPU, RAM)
#   gpu-process-exporter   :5052  maps each GPU-using PID to its Docker container
#
# Port 5050 is already taken by other services on some of these boxes
# (pgAdmin on .78, an unidentified listener on .79), so nvitop-exporter is
# published on 5051 everywhere for consistency.
set -euo pipefail

HOSTNAME_LABEL="${1:-$(hostname)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker build -q -t nvitop-exporter:local "$SCRIPT_DIR/docker/nvitop-exporter"
docker rm -f nvitop-exporter 2>/dev/null || true
docker run -d --name nvitop-exporter --restart=always --gpus all --pid host \
    -p 5051:5050 nvitop-exporter:local \
    --bind-address 0.0.0.0 --port 5050 --hostname "$HOSTNAME_LABEL"

docker build -q -t gpu-process-exporter:local "$SCRIPT_DIR/docker/gpu-process-exporter"
docker rm -f gpu-process-exporter 2>/dev/null || true
docker run -d --name gpu-process-exporter --restart=always --gpus all --pid host \
    -e EXPORTER_HOSTNAME="$HOSTNAME_LABEL" \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -p 5052:5052 gpu-process-exporter:local

sleep 3
curl -sf --max-time 4 "http://127.0.0.1:5051/metrics" >/dev/null \
    && echo "OK: nvitop-exporter running on :5051 as hostname=$HOSTNAME_LABEL" \
    || (echo "nvitop-exporter did not come up, check: docker logs nvitop-exporter" >&2; exit 1)
curl -sf --max-time 4 "http://127.0.0.1:5052/metrics" >/dev/null \
    && echo "OK: gpu-process-exporter running on :5052 as hostname=$HOSTNAME_LABEL" \
    || (echo "gpu-process-exporter did not come up, check: docker logs gpu-process-exporter" >&2; exit 1)
