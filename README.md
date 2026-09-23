# GPU Monitoring

GPU cluster monitoring (`wingene-76` … `wingene-80`, `192.168.1.76-80`), built on
`nvitop-exporter` + a custom `gpu-process-exporter` for GPU-to-container
attribution, presented through **Beszel** — specifically, this project's own fork
of it (`deploy/beszel-fork/`), which adds native PID→Docker-container GPU
attribution and a per-GPU process drill-down that upstream Beszel doesn't have.
The monitoring stack itself (Beszel hub) runs on `wingene-76` (`192.168.1.76`).

**Status: Beszel is the primary/only dashboard as of 2026-09-23.** The earlier
Prometheus + Grafana + nginx stack has been decommissioned (see
`docs/beszel-integration-research.md` for the full history of why Beszel was
piloted, what gap the fork closes, and every bug found/fixed along the way).

## Layout

```
gpu-monitoring/
├── inventory/servers.yaml      # GPU server list
├── deploy/
│   ├── install-exporter.sh     # run on each GPU server — deploys the exporters below
│   ├── build-images.sh         # builds/publishes the two exporter images
│   ├── docker/
│   │   ├── nvitop-exporter/Dockerfile
│   │   └── gpu-process-exporter/{Dockerfile,gpu_process_exporter.py}
│   ├── standalone/
│   │   ├── exporter-compose.yml        # nvitop-exporter + gpu-process-exporter + node-exporter
│   │   ├── beszel-hub-compose.yml      # Beszel hub — run on the monitoring server only
│   │   └── beszel-agent-compose.yml    # Beszel agent — run on every GPU server
│   └── beszel-fork/            # vendored github.com/henrygd/beszel + our GPU/container patches
└── docs/beszel-integration-research.md   # why Beszel, the fork's design, every bug fixed
```

## 1. On each GPU server (192.168.1.76 / .77 / .78 / .79 / .80)

Two ways to get the two custom exporter images running — pick one:

### Option A: pull the published images (fastest, no repo checkout needed)

```bash
docker pull ghcr.io/richard880502/gpu-dashboard/nvitop-exporter:v1.1.1
docker pull ghcr.io/richard880502/gpu-dashboard/gpu-process-exporter:v1.1.1

docker run -d --name nvitop-exporter --restart=always --gpus all --pid host \
    -v /etc/passwd:/etc/passwd:ro \
    -p 5051:5050 ghcr.io/richard880502/gpu-dashboard/nvitop-exporter:v1.1.1 \
    --bind-address 0.0.0.0 --port 5050 --hostname wingene-76

docker run -d --name gpu-process-exporter --restart=always --gpus all --pid host \
    -e EXPORTER_HOSTNAME=wingene-76 \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v /etc/passwd:/etc/passwd:ro \
    -p 5052:5052 ghcr.io/richard880502/gpu-dashboard/gpu-process-exporter:v1.1.1
```

The `/etc/passwd` mount is read-only and lets each exporter resolve real
usernames from the host's own user database instead of falling back to raw
UIDs (see the research doc's bug #7 for why this is needed).

Swap `wingene-76` for the actual hostname of whichever box you're on. Images are
public — no `docker login` needed to pull. Only `nvitop-exporter` and
`gpu-process-exporter` are published; `node-exporter` below is the official
upstream image, nothing custom to publish.

### Option B: build from source (if you've changed the exporter code)

```bash
scp -r deploy richard@192.168.1.76:/tmp/deploy
ssh richard@192.168.1.76 '/tmp/deploy/install-exporter.sh wingene-76'
```

Repeat either option for `.77`/`wingene-77`, `.78`/`wingene-78`, `.79`/`wingene-79`,
`.80`/`wingene-80`. Either way you end up with three containers running
(`install-exporter.sh` also handles the third one, `node-exporter`, either way):

- **nvitop-exporter** (`:5051`, `--gpus all --pid host`) — GPU/host metrics
  (util, VRAM, temp, power, CPU%, RAM%), including per-process GPU
  memory/utilization.
- **gpu-process-exporter** (`:5052`, `--gpus all --pid host`) — a small custom
  exporter that maps each GPU-using PID to the Docker container it's running
  in (via `/proc/<pid>/cgroup` + the Docker API), so the dashboard can answer
  "whose container is holding this GPU" without SSH-ing in to run `docker ps`
  by hand. Needs `/var/run/docker.sock` mounted read-only. On a Kubernetes
  node (containerd/CRI-O runtime, so k8s pods aren't visible on the Docker
  socket at all), also set `CRI_SOCKET_PATH` to attribute those to their
  pod/container via `crictl` instead of falling back to `"host"` — see
  `deploy/standalone/exporter-compose.yml`.
- **node-exporter** (`:9100`, official `prom/node-exporter` image, `--net=host
  --pid=host`) — host metrics nvitop-exporter doesn't cover (disk usage, CPU
  temperature via `--collector.hwmon`).

Verify either option worked:

```bash
curl http://192.168.1.76:5051/metrics | head
curl http://192.168.1.76:5052/metrics | head
curl http://192.168.1.76:9100/metrics | head
```

## 2. Beszel (monitoring server + every GPU server)

Images are published to GHCR (`ghcr.io/richard880502/gpu-dashboard/beszel-hub`
and `beszel-agent-nvidia`, both public, currently `v2.0.0`) — no build step
needed unless you've changed `deploy/beszel-fork`.

### 2a. Start the hub (monitoring server, `192.168.1.76`, once)

```bash
mkdir -p deploy/beszel/data && chmod 777 deploy/beszel/data
cd deploy/standalone
cp .env.example .env   # set a real USER_PASSWORD
docker compose -f beszel-hub-compose.yml up -d
```

The account email (`wingene@internal.local`) and `AUTO_LOGIN` are fixed in
the compose file — only the password is a secret, kept in the gitignored
`.env`. The email doesn't need to be real/reachable; PocketBase's own user
model just requires an email-shaped identity field, and `AUTO_LOGIN` works
by exact string match against it, not by sending anything. Password only
matters on first run (creates the account); ignored on later runs.

Confirm it's up: `curl -s http://192.168.1.76:13000` should return HTML.

### 2b. Start the agent (every GPU server, including .76 itself)

The agent needs the hub's public key. Grab it once (from the monitoring
server, or anywhere that can reach it):

```bash
TOKEN=$(curl -s -X POST http://192.168.1.76:13000/api/collections/users/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"wingene@internal.local","password":"<the USER_PASSWORD from .env>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -s http://192.168.1.76:13000/api/beszel/getkey -H "Authorization: Bearer $TOKEN"
# -> {"key":"ssh-ed25519 AAAA...", ...}
```

Then on each GPU server:

```bash
HUB_SSH_PUBLIC_KEY="ssh-ed25519 AAAA..." \
  docker compose -f deploy/standalone/beszel-agent-compose.yml up -d
```

`GPU_COLLECTOR=nvidia-smi` in the agent compose file is required, not
optional — Beszel's own NVML collector silently drops GPU temperature on some
hosts (an ignored NVML return code); `nvidia-smi` was verified reliable on
every host in this cluster. Don't remove it when redeploying.

### 2c. Register each system with the hub

The agent alone doesn't make it show up — the hub only tries connecting to
hosts it already knows about. Easiest: open `http://192.168.1.76:13000`,
log in (email/password from step 2a), click **Add System**, and fill in the
hostname/IP (agent port defaults to `45876`). Repeat once per GPU server.

To script this instead (what was actually used to bring up all 5 hosts at
once):

```bash
curl -s -X POST http://192.168.1.76:13000/api/collections/systems/records \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"wingene-76","host":"192.168.1.76","port":"45876","users":["<user id, from the auth response above>"]}'
```

Status goes `pending` → `up` within ~10s once the hub successfully connects.

### 2d. Open the dashboard

`http://192.168.1.76:13000` — home page shows a cluster-wide GPU summary
card, a per-GPU status table (click a row to see what's running on that GPU,
including plain host processes not in any container), and the stock Beszel
systems/containers views. `AUTO_LOGIN` skips the login screen for the
internal network, same approach used for the old Grafana setup.

## 3. Firewall

`nvitop-exporter:5051`, `gpu-process-exporter:5052`, and `node-exporter:9100`
should only be reachable from the monitoring server, not from general users.
On each GPU server:

```bash
ufw allow from 192.168.1.76 to any port 5051 proto tcp
ufw allow from 192.168.1.76 to any port 5052 proto tcp
ufw allow from 192.168.1.76 to any port 9100 proto tcp
ufw deny 5051/tcp
ufw deny 5052/tcp
ufw deny 9100/tcp
```

Not yet applied — none of the 5 GPU boxes grant passwordless sudo to the deploy
user, so `ufw` needs to be run interactively with the box's sudo password.

## Deployment notes (still-relevant history from the original Prometheus/Grafana build)

- **Exporters run in Docker, not systemd.** None of the 5 GPU servers grant
  passwordless sudo to the `richard` account, so exporters run as
  `--restart=always` containers instead — auto-start, auto-restart, no root
  needed.
- **nvitop-exporter's port is 5051, not 5050.** Port `5050` was already bound by
  other services on `.78` and `.79`. Using `5051` everywhere avoids both
  conflicts and keeps things uniform across all 5 hosts.
- **`--hostname` flag:** `nvitop-exporter` defaults to labelling metrics with
  its own container's internal IP, not the real machine name — each container
  is started with `--hostname wingene-XX` explicitly.
- **`gpu-process-exporter` is a custom addition**, not part of `nvitop-exporter`
  itself. It replicates a PID→container lookup (via `/proc/<pid>/cgroup` + the
  Docker API) and emits a `gpu_process_container_info` metric with the same
  label set `nvitop-exporter` uses for its own per-process metrics, which is
  what the Beszel fork's `agent/gpu_process_container.go` joins against.

## What's deliberately not in this version

AlertManager-style notification routing, OAuth/LDAP/SSO in front of the
dashboard, Kubernetes/service discovery, Triton/vLLM metrics.

## Known gaps to fill in

- Firewall rule above — needs interactive sudo on each GPU box.
- No backup mechanism for the Beszel hub's SQLite database
  (`deploy/beszel/data/`).
- No arm64 build yet for Beszel's images (needed if wingene-82 joins this
  stack; the two exporters already support it).
