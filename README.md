# GPU Dashboard

Centralized NVIDIA GPU cluster monitoring built on **Beszel**, **nvitop-exporter**, and a custom **gpu-process-exporter**.

The dashboard is designed for shared GPU servers where `nvidia-smi` alone is not enough. Besides GPU utilization, VRAM, temperature, and power, it can answer:

> **Which user, process, Docker container, or Kubernetes pod is using this GPU?**

This repository contains the Beszel fork, GPU exporters, Docker Compose files, and operational commands used by the current cluster.

## Features

- Multi-node NVIDIA GPU monitoring from one web dashboard
- GPU utilization, VRAM, temperature, power, and per-process metrics
- PID → Linux user attribution
- PID → Docker container attribution
- PID → Kubernetes / CRI container and pod attribution
- Per-GPU process drill-down in the Beszel UI
- SMART disk monitoring through the Beszel agent
- Optional Slack live GPU dashboard
- Docker Compose based deployment with published GHCR images

## Current deployment

| Role | Host |
| --- | --- |
| Beszel Hub | `wingene-76` / `192.168.1.76:13000` |
| GPU nodes | `wingene-76` … `wingene-80` |
| Beszel Agent | `:45876` on every monitored node |
| nvitop-exporter | `:5051` on every monitored node |
| gpu-process-exporter | `:5052` on every monitored node |

The current inventory is in [`inventory/servers.yaml`](inventory/servers.yaml).

---

# Command cheat sheet

These are the commands you will use most often.

## Update the repository

```bash
cd ~/GPU-Dashboard
git pull --ff-only origin main
```

If the repo is not cloned yet:

```bash
git clone https://github.com/richard880502/GPU-Dashboard.git
cd GPU-Dashboard
```

## Check the current stack

On the hub:

```bash
cd ~/GPU-Dashboard/deploy/standalone

docker compose -f beszel-hub-compose.yml ps
docker logs --tail 100 beszel
curl -sS http://127.0.0.1:13000 >/dev/null && echo "Beszel hub OK"
```

On a monitored GPU node:

```bash
cd ~/GPU-Dashboard/deploy/standalone

docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  ps

docker logs --tail 100 beszel-agent
docker logs --tail 100 nvitop-exporter
docker logs --tail 100 gpu-process-exporter

curl -fsS http://127.0.0.1:5051/metrics >/dev/null && echo "nvitop-exporter OK"
curl -fsS http://127.0.0.1:5052/metrics >/dev/null && echo "gpu-process-exporter OK"
```

GPU sanity check:

```bash
nvidia-smi
docker exec beszel-agent nvidia-smi
```

## Restart services

Hub:

```bash
cd ~/GPU-Dashboard/deploy/standalone
docker compose -f beszel-hub-compose.yml restart
```

Monitored node:

```bash
cd ~/GPU-Dashboard/deploy/standalone

docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  restart
```

Slack monitor:

```bash
cd ~/GPU-Dashboard/deploy/standalone
docker compose -f slack-monitor-compose.yml restart
```

## Pull the versions pinned by the compose files and recreate

Hub:

```bash
cd ~/GPU-Dashboard
git pull --ff-only origin main
cd deploy/standalone

docker compose -f beszel-hub-compose.yml pull
docker compose -f beszel-hub-compose.yml up -d
```

Monitored node (recommended `.env.node` workflow):

```bash
cd ~/GPU-Dashboard
git pull --ff-only origin main
cd deploy/standalone

docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  pull

docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  up -d
```

If the node was started with inline variables instead, repeat those variables when running `up`, `down`, `pull`, or other Compose commands.

To inspect the environment of an already-running agent:

```bash
docker inspect beszel-agent \
  --format '{{range .Config.Env}}{{println .}}{{end}}'
```

---

# Fresh deployment

The recommended layout is:

```text
                    ┌────────────────────────────┐
                    │         Beszel Hub         │
                    │      Web UI :13000         │
                    └─────────────┬──────────────┘
                                  │
                 ┌────────────────┼────────────────┐
                 │                │                │
                 ▼                ▼                ▼
            GPU Node 1       GPU Node 2       GPU Node N
            ──────────       ──────────       ──────────
            Beszel Agent     Beszel Agent     Beszel Agent
            nvitop exporter  nvitop exporter  nvitop exporter
            process exporter process exporter process exporter
```

For a new node, prefer [`deploy/standalone/monitored-node-compose.yml`](deploy/standalone/monitored-node-compose.yml). It starts all three node-side services together.

## 0. Prerequisites

Each GPU node should have:

- Linux
- NVIDIA driver
- Docker Engine
- Docker Compose plugin
- NVIDIA Container Toolkit

Quick check:

```bash
nvidia-smi
docker --version
docker compose version
docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi
```

Clone the project:

```bash
git clone https://github.com/richard880502/GPU-Dashboard.git
cd GPU-Dashboard
```

## 1. Start the Beszel Hub

Run this once on the monitoring server.

For the current deployment, the hub is `wingene-76` (`192.168.1.76`).

```bash
cd ~/GPU-Dashboard
git pull --ff-only origin main
cd deploy/standalone

cp -n .env.example .env
```

Edit `.env` and set at least:

```dotenv
USER_PASSWORD=replace-with-a-real-password
```

The current compose file stores PocketBase/Beszel data on local disk at:

```text
/tmp2/richard/beszel-hub-data
```

Create it before the first start:

```bash
mkdir -p /tmp2/richard/beszel-hub-data
chmod 777 /tmp2/richard/beszel-hub-data
```

Then start the hub:

```bash
docker compose -f beszel-hub-compose.yml pull
docker compose -f beszel-hub-compose.yml up -d
```

Verify:

```bash
docker compose -f beszel-hub-compose.yml ps
docker logs --tail 100 beszel
curl -sS http://127.0.0.1:13000 | head
```

Open:

```text
http://192.168.1.76:13000
```

### Using a different hub host

The compose defaults are for the current `wingene` cluster. For another cluster, override `APP_URL` and `ACCOUNT_EMAIL`, and change the host-side data path in `beszel-hub-compose.yml`.

Example:

```bash
APP_URL=http://10.0.0.10:13000 \
ACCOUNT_EMAIL=gpu@internal.local \
USER_PASSWORD='replace-with-a-real-password' \
docker compose -f beszel-hub-compose.yml up -d
```

## 2. Get the Hub SSH public key

Every Beszel agent needs the hub's public key.

The easiest method is to open **Add System** in the Beszel UI and copy the key.

You can also retrieve it from the API.

From the hub host:

```bash
cd ~/GPU-Dashboard/deploy/standalone
set -a
source .env
set +a

TOKEN=$(
  curl -fsS -X POST \
    http://127.0.0.1:13000/api/collections/users/auth-with-password \
    -H 'Content-Type: application/json' \
    -d "{\"identity\":\"${ACCOUNT_EMAIL:-wingene@internal.local}\",\"password\":\"${USER_PASSWORD}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
)

curl -fsS \
  http://127.0.0.1:13000/api/beszel/getkey \
  -H "Authorization: Bearer $TOKEN"
```

The result contains something similar to:

```text
ssh-ed25519 AAAA...
```

Use that value as `HUB_SSH_PUBLIC_KEY` on every monitored node.

## 3. Prepare a GPU node

First identify the host and its base disk device.

```bash
hostname
nvidia-smi -L
lsblk -d -o NAME,TYPE,SIZE,MODEL
```

For SMART monitoring, use a **base device**, not a partition.

Examples:

```text
/dev/nvme0
/dev/sda
```

Do not blindly copy the disk path from another machine.

### Recommended: create a node `.env`

Using a `.env` file makes later `up`, `down`, `pull`, and restart operations much easier.

On the GPU node:

```bash
cd ~/GPU-Dashboard/deploy/standalone

cat > .env.node <<'EOF'
HOSTNAME=wingene-77
HUB_URL=http://192.168.1.76:13000
HUB_SSH_PUBLIC_KEY=ssh-ed25519 AAAA_REPLACE_ME
SMART_DEVICE_1=/dev/nvme0
EOF
```

Edit the four values for the actual machine.

Start the complete node stack:

```bash
docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  pull

docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  up -d
```

Verify:

```bash
docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  ps

curl -fsS http://127.0.0.1:5051/metrics >/dev/null && echo "nvitop-exporter OK"
curl -fsS http://127.0.0.1:5052/metrics >/dev/null && echo "gpu-process-exporter OK"
```

### Same deployment without `.env.node`

```bash
HOSTNAME=wingene-77 \
HUB_URL=http://192.168.1.76:13000 \
HUB_SSH_PUBLIC_KEY="ssh-ed25519 AAAA..." \
SMART_DEVICE_1=/dev/nvme0 \
docker compose -f monitored-node-compose.yml up -d
```

## 4. Register the node in Beszel

Starting the agent does not automatically create a system record in the hub.

In the dashboard:

1. Open `http://192.168.1.76:13000`
2. Click **Add System**
3. Enter the node name/IP
4. Use agent port `45876`
5. Save

The system should move from `pending` to `up` after the hub connects successfully.

## 5. Kubernetes / containerd node

Kubernetes pods are not visible through Docker's socket, so a Kubernetes node also needs CRI access.

Find the real CRI socket:

```bash
cat /etc/crictl.yaml 2>/dev/null || true

ls -la \
  /run/containerd/containerd.sock \
  /var/run/containerd/containerd.sock \
  /var/run/k3s/containerd/containerd.sock 2>/dev/null
```

Confirm the pod log directory if you want CRI container logs in Beszel:

```bash
ls -ld /var/log/pods
```

Example `.env.node` for a normal containerd node:

```dotenv
HOSTNAME=h30laimgpu05
HUB_URL=http://192.168.1.76:13000
HUB_SSH_PUBLIC_KEY=ssh-ed25519 AAAA_REPLACE_ME
SMART_DEVICE_1=/dev/sda

CRI_SOCKET_PATH=/run/containerd/containerd.sock
CRI_MOUNT_PATH=/run/containerd/containerd.sock
CRI_LOG_PATH=/var/log/pods
```

Start it:

```bash
docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  up -d
```

This enables both:

- Beszel CRI container visibility / logs
- GPU process → Kubernetes pod/container attribution

### Nested k3s/containerd inside another Docker container

If the Kubernetes runtime socket lives inside another Docker container, use `CRI_EXEC_CONTAINER` instead of trying to bind-mount that socket.

Example:

```bash
HOSTNAME=gpu-node \
HUB_URL=http://192.168.1.76:13000 \
HUB_SSH_PUBLIC_KEY="ssh-ed25519 AAAA..." \
SMART_DEVICE_1=/dev/nvme0 \
CRI_SOCKET_PATH=/run/k3s/containerd/containerd.sock \
CRI_EXEC_CONTAINER=sandbox-docker \
docker compose -f monitored-node-compose.yml up -d
```

## 6. Unified-memory ARM64 NVIDIA systems

Most amd64 GPU nodes use:

```text
GPU_COLLECTOR=nvidia-smi
```

For unified-memory systems such as GB10, use both collectors:

```bash
GPU_COLLECTOR=nvml,nvidia-smi \
docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  up -d
```

This is needed because `nvidia-smi` CLI memory fields can be unavailable on those systems while NVML still reports usable memory data.

## 7. Firewall

On every monitored GPU node, only the hub should need access to exporter ports.

For the current hub:

```bash
sudo ufw allow from 192.168.1.76 to any port 5051 proto tcp
sudo ufw allow from 192.168.1.76 to any port 5052 proto tcp
sudo ufw deny 5051/tcp
sudo ufw deny 5052/tcp
```

The Beszel agent also listens on `45876`; allow that from the hub if the node firewall blocks it:

```bash
sudo ufw allow from 192.168.1.76 to any port 45876 proto tcp
```

---

# Slack live GPU dashboard

`deploy/standalone/slack-monitor-compose.yml` can maintain one persistent GPU status message in Slack and update it in place.

## Initial setup

Create a Slack App and give the bot `chat:write`, install it to the workspace, invite it to the target channel, then collect:

- Bot token: `xoxb-...`
- Channel ID: `C...`

On the hub host:

```bash
cd ~/GPU-Dashboard/deploy/standalone
cp -n .env.example .env
```

Set:

```dotenv
USER_PASSWORD=the-same-password-used-by-beszel
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C...
```

Start it:

```bash
docker compose -f slack-monitor-compose.yml up -d --build
```

Useful commands:

```bash
docker compose -f slack-monitor-compose.yml ps
docker logs -f gpu-slack-monitor
docker compose -f slack-monitor-compose.yml restart
```

After changing Slack App settings, force a fresh session with:

```bash
docker compose -f slack-monitor-compose.yml restart
```

Read the persisted Slack message state:

```bash
docker exec gpu-slack-monitor cat /data/state.json
```

---

# Exporters only

Normally use `monitored-node-compose.yml`. If you only want the two GPU exporters, use `exporter-compose.yml`.

Plain Docker host:

```bash
cd ~/GPU-Dashboard/deploy/standalone

HOSTNAME=wingene-77 \
docker compose -f exporter-compose.yml up -d
```

Kubernetes/containerd host:

```bash
CRI_SOCKET_PATH=/run/containerd/containerd.sock \
CRI_MOUNT_PATH=/run/containerd/containerd.sock \
HOSTNAME=gpu-node \
docker compose -f exporter-compose.yml up -d
```

Verify:

```bash
curl -fsS http://127.0.0.1:5051/metrics | head
curl -fsS http://127.0.0.1:5052/metrics | head
```

---

# Build images from source

Published images are normally enough. Build from source only when changing exporter code.

Validate both amd64 and arm64 builds:

```bash
cd ~/GPU-Dashboard
VERSION=v1.5.0 ./deploy/build-images.sh
```

Build and push to GHCR:

```bash
docker login ghcr.io

docker run --privileged --rm \
  tonistiigi/binfmt --install all

VERSION=v1.5.0 ./deploy/build-images.sh --push
```

`build-images.sh` builds both:

```text
ghcr.io/richard880502/gpu-dashboard/nvitop-exporter
ghcr.io/richard880502/gpu-dashboard/gpu-process-exporter
```

---

# Troubleshooting command cookbook

## Compose says a required variable is missing

Check what the compose file resolves to:

```bash
docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  config
```

If the service is already running, inspect its current environment:

```bash
docker inspect beszel-agent \
  --format '{{range .Config.Env}}{{println .}}{{end}}'
```

## Agent is running but the system is `pending`

Check the agent:

```bash
docker logs --tail 200 beszel-agent
ss -lntp | grep 45876
```

From the hub, test network reachability:

```bash
nc -vz <GPU_NODE_IP> 45876
```

Then confirm:

- the system exists in the Beszel UI
- its IP is correct
- port is `45876`
- `HUB_SSH_PUBLIC_KEY` matches the current hub

## GPU is missing in the dashboard

```bash
nvidia-smi
docker exec beszel-agent nvidia-smi
docker logs --tail 200 beszel-agent
```

Also inspect the collector:

```bash
docker inspect beszel-agent \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep GPU_COLLECTOR
```

## GPU process shows as `host` instead of a container

For Docker workloads:

```bash
docker ps
docker exec gpu-process-exporter ls -l /var/run/docker.sock
docker logs --tail 200 gpu-process-exporter
```

For Kubernetes workloads:

```bash
ls -l /run/containerd/containerd.sock
docker exec gpu-process-exporter crictl \
  --runtime-endpoint unix:///run/containerd/containerd.sock ps
```

If the socket path is different, use the actual `CRI_SOCKET_PATH` configured on that node.

## CRI container is visible but Logs is empty

Make sure the pod log directory is mounted:

```bash
ls -ld /var/log/pods
```

Then set:

```dotenv
CRI_LOG_PATH=/var/log/pods
```

and recreate the node stack:

```bash
docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  up -d
```

## Wrong SMART device

Never guess the device path.

```bash
lsblk -d -o NAME,TYPE,SIZE,MODEL
```

Use the base device, for example `/dev/nvme0` or `/dev/sda`, not a partition such as `/dev/nvme0n1p1`.

## YAML / Compose syntax check

```bash
docker compose \
  --env-file .env.node \
  -f monitored-node-compose.yml \
  config >/dev/null && echo "Compose config OK"
```

---

# Repository layout

```text
GPU-Dashboard/
├── inventory/
│   └── servers.yaml
├── deploy/
│   ├── build-images.sh
│   ├── install-exporter.sh
│   ├── docker/
│   │   ├── nvitop-exporter/
│   │   ├── gpu-process-exporter/
│   │   └── slack-monitor/
│   ├── standalone/
│   │   ├── beszel-hub-compose.yml
│   │   ├── beszel-agent-compose.yml
│   │   ├── exporter-compose.yml
│   │   ├── monitored-node-compose.yml
│   │   └── slack-monitor-compose.yml
│   └── beszel-fork/
└── docs/
    └── beszel-integration-research.md
```

# Components

| Component | Purpose |
| --- | --- |
| Beszel Hub | Central web dashboard and metric storage |
| Beszel Agent | Host, container, SMART, and GPU collection |
| nvitop-exporter | Detailed NVIDIA GPU and per-process metrics |
| gpu-process-exporter | PID → Docker/CRI/Kubernetes workload attribution |
| Beszel fork | GPU process drill-down and attribution integration |
| Slack monitor | Optional persistent cluster status message |

# Why the Beszel fork exists

Upstream Beszel provides the lightweight host/container monitoring foundation. This repository's fork adds the GPU-specific pieces needed for a shared GPU cluster, especially GPU process inspection and workload attribution.

The earlier Prometheus + Grafana stack has been retired. Detailed implementation history and bug notes are kept in [`docs/beszel-integration-research.md`](docs/beszel-integration-research.md).

# Known gaps

- Hub database backup is not automated yet.
- AlertManager-style notification routing is not included.
- Triton and vLLM application-level metrics are not included yet.
