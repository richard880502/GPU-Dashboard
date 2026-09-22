# GPU Monitoring

Prometheus + Grafana monitoring for the GPU cluster (`wingene-76` … `wingene-80`,
`192.168.1.76-80`), built on `nvitop-exporter`, with the monitoring stack itself
running on `wingene-76` (`192.168.1.76`). Scope follows the MVP in the build plan:
metrics pipeline + dashboard only — no AlertManager, SSO, or custom frontend yet.

**Status: deployed and live** — all 5 GPU servers and the Prometheus/Grafana/nginx
stack are running as of this setup. See "Deployment notes" below for what differs
from the original plan text and why.

## Layout

```
gpu-monitoring/
├── docker-compose.yml          # Prometheus + Grafana + Nginx (monitoring server)
├── inventory/servers.yaml      # GPU server list
├── prometheus/
│   ├── prometheus.yml          # scrape config: gpu-servers (5051), gpu-process-containers (5052),
│   │                            # node-exporter (9100)
│   └── rules/gpu-alerts.yml    # rule definitions, visible in Prometheus UI only
│                                # (no Alertmanager wired up yet)
├── grafana/
│   └── provisioning/
│       ├── datasources/prometheus.yml
│       └── dashboards/
│           ├── dashboards.yml
│           └── files/cluster-overview.json   # hand-built dashboard (see "Default home
│                                              # dashboard" below) — the official
│                                              # nvitop-dashboard it started from was
│                                              # later removed, see git history
├── nginx/nginx.conf            # reverse proxy -> grafana:3000
└── deploy/
    ├── install-exporter.sh     # run on each GPU server — deploys the containers below
    └── docker/
        ├── nvitop-exporter/Dockerfile
        └── gpu-process-exporter/{Dockerfile,gpu_process_exporter.py}
```

## 1. On each GPU server (192.168.1.76 / .77 / .78 / .79 / .80)

Two ways to get the two custom exporter images running — pick one:

### Option A: pull the published images (fastest, no repo checkout needed)

```bash
docker pull ghcr.io/richard880502/gpu-dashboard/nvitop-exporter:v1.0.0
docker pull ghcr.io/richard880502/gpu-dashboard/gpu-process-exporter:v1.0.0

docker run -d --name nvitop-exporter --restart=always --gpus all --pid host \
    -p 5051:5050 ghcr.io/richard880502/gpu-dashboard/nvitop-exporter:v1.0.0 \
    --bind-address 0.0.0.0 --port 5050 --hostname wingene-76

docker run -d --name gpu-process-exporter --restart=always --gpus all --pid host \
    -e EXPORTER_HOSTNAME=wingene-76 \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -p 5052:5052 ghcr.io/richard880502/gpu-dashboard/gpu-process-exporter:v1.0.0
```

Swap `wingene-76` for the actual hostname of whichever box you're on. Images are
public — no `docker login` needed to pull. Only `nvitop-exporter` and
`gpu-process-exporter` are published; `node-exporter` below is the official
upstream image, nothing custom to publish.

Verified (2026-09-22): a completely fresh `git clone` of this repo, with no local
image builds at all — just `docker pull` for these two plus `docker compose up -d`
for the monitoring stack — reproduced a fully working deployment (16/16 Prometheus
targets up, dashboard queries returning correct data) on a different checkout path
than the one that had been manually tweaked all along. The repo doesn't secretly
depend on some untracked local state.

### Option B: build from source (if you've changed the exporter code)

```bash
scp -r deploy richard@192.168.1.76:/tmp/deploy
ssh richard@192.168.1.76 '/tmp/deploy/install-exporter.sh wingene-76'
```

Repeat either option for `.77`/`wingene-77`, `.78`/`wingene-78`, `.79`/`wingene-79`,
`.80`/`wingene-80`. Either way you end up with three containers running
(`install-exporter.sh` also handles the third one, `node-exporter`, either way):

- **nvitop-exporter** (`:5051`, `--gpus all --pid host`) — GPU/host metrics
  (util, VRAM, temp, power, CPU%, RAM%).
- **gpu-process-exporter** (`:5052`, `--gpus all --pid host`) — a small custom
  exporter that maps each GPU-using PID to the Docker container it's running
  in (via `/proc/<pid>/cgroup` + the Docker API), so the dashboard can answer
  "whose container is holding this GPU" without SSH-ing in to run `docker ps`
  by hand. Needs `/var/run/docker.sock` mounted read-only.
- **node-exporter** (`:9100`, official `prom/node-exporter` image, `--net=host
  --pid=host`) — nvitop-exporter's host metrics don't include disk usage or
  CPU temperature (it's a GPU-process tool, not a general host exporter), so
  this fills that gap: disk usage % (`node_filesystem_avail_bytes` /
  `node_filesystem_size_bytes` for `mountpoint="/"`) and CPU package
  temperature (`node_hwmon_temp_celsius`, `--collector.hwmon`, filtered to the
  sensor labelled `"Package id 0"` — confirmed present via `coretemp` on all 5
  hosts before deploying).

Verify either option worked:

```bash
curl http://192.168.1.76:5051/metrics | head
curl http://192.168.1.76:5052/metrics | head
curl http://192.168.1.76:9100/metrics | head
```

## 2. On the monitoring server (192.168.1.76)

```bash
git clone https://github.com/richard880502/gpu-dashboard.git
cd gpu-dashboard
cp .env.example .env   # set a real GRAFANA_ADMIN_PASSWORD
docker compose up -d
```

No image building here at all — `prometheus`, `grafana`, and `nginx` are all
pulled straight from Docker Hub as official images.

Prometheus/Grafana data lives under `./data/prometheus` and `./data/grafana`
(bind mounts, gitignored) rather than Docker-managed named volumes — makes it
obvious where the data actually is and easy to `du -sh` or back up directly.
Since Prometheus runs as uid 65534 and Grafana as uid 472 inside their
containers (not your own host uid, and you likely don't have root to `chown`
to those either), the directories need to be world-writable:

```bash
mkdir -p data/prometheus data/grafana
chmod 777 data/prometheus data/grafana
```

- Prometheus: `http://192.168.1.76:9090` — check **Status → Targets**, all 5
  `gpu-servers`, all 5 `gpu-process-containers`, and all 5 `node-exporter`
  targets should show `UP` (16 total, including Prometheus scraping itself).
- Grafana: `http://192.168.1.76:13000` (or through nginx on port 80, no login
  needed — see below) — opens straight to **GPU Cluster Overview** (see
  "Default home dashboard" below). This is the only dashboard now — the
  official nvitop-dashboard it was originally imported from was deleted
  (2026-09-22, accepted trade-off: lost per-GPU historical trend charts / PCIe
  / NVLink, everything else was already ported over first).

Anonymous viewer access is enabled (internal network, so no login prompt for
viewing). Admin login is still available at `/login` for editing
(`admin` / see `.env`).

### Default home dashboard

There's no config-file way to set this — `GF_DASHBOARDS_DEFAULT_HOME_UID` looked
like the right env var but turned out to only register as a fallback that
`/api/dashboards/home` doesn't actually consult (confirmed the hard way, so it's
not set in `docker-compose.yml` at all now). What actually works is the **org
preference**, set via one API call after the stack is up. It's stored in
`./data/grafana`, so a fresh clone or a wiped data directory both mean redoing
this. The dashboard's Grafana UID is auto-generated fresh each time (not pinned
in the JSON), so look it up first rather than reusing an old one from another
instance:

```bash
UID=$(curl -s http://localhost:13000/api/search | python3 -c \
  "import json,sys; print(json.load(sys.stdin)[-1]['uid'])")
curl -X PUT -u admin:<password> -H 'Content-Type: application/json' \
  http://192.168.1.76:13000/api/org/preferences \
  -d "{\"homeDashboardUID\": \"$UID\"}"
```

## 3. Firewall (Phase 9 of the plan)

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
user, so `ufw` needs to be run interactively with the box's sudo password. Do this
next.

## Deployment notes (what differs from the original plan text, and why)

- **Exporters run in Docker, not systemd.** None of the 5 GPU servers grant
  passwordless sudo to the `richard` account, so the systemd-unit approach in the
  plan doc can't be applied non-interactively. All 5 boxes already have Docker with
  the NVIDIA runtime working and `richard` in the `docker` group, so exporters run
  as `--restart=always` containers instead — same effect (auto-start, auto-restart),
  no root needed.
- **nvitop-exporter's port is 5051, not 5050.** Port `5050` was already bound by
  other services: `pretrieval-pgadmin` (pgAdmin4) on `.78`, and an unidentified
  native process on `.79`. Using `5051` everywhere avoids both conflicts and keeps
  the scrape config uniform across all 5 hosts.
- **`hostname` label:** `nvitop-exporter` defaults to labelling metrics with its own
  container's internal IP (e.g. `172.17.0.5`), not the real machine name — it reads
  this from a `--hostname` CLI flag, not from the container's actual hostname. Each
  container is started with `--hostname wingene-XX` explicitly so Grafana's
  `hostname` filter shows the real box names.
- **Container attribution (`gpu-process-exporter`) is a custom addition**, not part
  of `nvitop-exporter` itself. It replicates a PID→container lookup (via
  `/proc/<pid>/cgroup` + the Docker API) and emits a `gpu_process_container_info`
  metric with the *exact same* label set nvitop-exporter uses for its own
  per-process metrics (`hostname, index, pid, username, uuid`) — this is required
  for Grafana's `merge`/`groupBy` transform on the "GPU Processes" table to fold it
  into the same row instead of creating a separate orphan row. This included
  matching nvitop-exporter's own username-resolution fallback (raw UID string when
  the name isn't in the container's local `/etc/passwd`) so the two exactly agree.
- **Grafana host port is 13000, not 3000** — changed directly on the monitoring
  server outside of this repo's sync (kept as-is rather than reverted). nginx on
  port 80 is unaffected since it talks to the `grafana` container over the internal
  Docker network on its container port 3000, regardless of the host mapping.
- **Anonymous Grafana access** (`GF_AUTH_ANONYMOUS_ENABLED=true`, role `Viewer`) —
  added because this is an internal-only network; admin login still guards actual
  edits.

## What's deliberately not in this version

Per the plan's own MVP scope: AlertManager routing, OAuth/LDAP/SSO in front of
Grafana, Kubernetes/service discovery, Triton/vLLM metrics, and a custom frontend.
The alert *rules* file exists (so thresholds are visible in Prometheus's own UI) but
nothing is wired to notify anyone yet — add Alertmanager later when you're ready for
Phase 10.

## Known gaps to fill in

- Firewall rule above — needs interactive sudo on each GPU box.
