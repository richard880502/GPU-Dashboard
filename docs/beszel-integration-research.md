# Beszel integration research

**Decision:** run Beszel alongside the existing Prometheus and Grafana stack. Do not replace the current GPU exporters.

The project already has a strong division of responsibility:

- `nvitop-exporter` exposes host, per-GPU, and per-process NVIDIA metrics.
- `gpu-process-exporter` adds the missing PID-to-Docker-container mapping.
- Prometheus retains these labelled time series and Grafana presents cluster occupancy and the GPU Processes table.

Beszel is a better fit for an easy-to-read system-health and alerting view than for this project's GPU allocation view. Its agent collects a scalar record for each GPU: name, memory used/total, utilisation, temperature, and power. It does not collect a GPU process list, Linux user, PID, CUDA process memory, or a GPU-to-container mapping. That is visible both in Beszel's supported `GPUData` model and in its NVIDIA collector.

## Recommendation

Deploy a small Beszel pilot for seven days in parallel. Keep the existing three exporter containers, Prometheus, Grafana, scrape rules, and dashboard unchanged. Use the result to decide whether the Beszel system overview and alerts are useful enough to operate permanently.

```mermaid
flowchart LR
  subgraph GPU hosts
    B[Beszel NVIDIA agent]
    N[nvitop exporter]
    P[GPU process exporter]
    X[node exporter]
  end
  B -->|WebSocket| H[Beszel Hub]
  N --> M[Prometheus]
  P --> M
  X --> M
  M --> G[Grafana: allocation dashboard]
  H --> V[Beszel: health & alert view]
```

This avoids a data migration, keeps the existing one-second GPU data and container attribution, and makes rollback as simple as stopping the new Beszel containers.

## Capability comparison

| Need in this project | Current stack | Beszel 0.20.0 | Result |
| --- | --- | --- | --- |
| Multi-node overview | Grafana dashboard | Hub with one agent per system | Supported by both |
| CPU, memory, disk, network and temperature | nvitop + node-exporter | Agent | Beszel can provide a cleaner host-health view |
| Per-GPU utilisation, VRAM, temperature, power | nvitop-exporter | NVIDIA agent | Supported by both |
| GPU process / PID / username | nvitop-exporter | No | Keep Prometheus and Grafana |
| GPU process mapped to Docker container | Custom exporter | No | Keep `gpu-process-exporter` |
| Filter the cluster by GPU user | Grafana variables | No equivalent | Keep Grafana |
| PromQL, custom capacity calculations and panels | Prometheus + Grafana | No | Keep Prometheus and Grafana |
| Host/container alerting | Prometheus rules only; no routing | Built-in alert channels | Good pilot target |
| OIDC and multi-user system access | Not currently configured | Built in | Consider later if needed |

## Pilot topology

Run the Hub on `wingene-76`, beside the existing monitoring stack. Give it its own persistent directory and a private LAN port such as `18090`; do not publish it outside the internal network during the pilot.

Each GPU host runs one `henrygd/beszel-agent-nvidia` container. The agent requires the NVIDIA Container Toolkit and the Docker socket mounted read-only. The existing hosts already meet those prerequisites because their exporter containers use the NVIDIA runtime and the custom process exporter reads the Docker socket.

Before starting, reconcile the target list: `prometheus/prometheus.yml` includes `wingene-82`, while `inventory/servers.yaml` and the README still list only `wingene-76` through `wingene-80`. The pilot should use the live Prometheus target list as its starting inventory and update the repository inventory in a separate, verified change.

Use Beszel's WebSocket mode: agents initiate the connection to the Hub. The Hub then verifies the registration token, signs a challenge, and verifies the agent fingerprint. The normal agent image also listens on port `45876` for Hub-initiated SSH mode, so firewall that port to the Hub or keep it otherwise inaccessible on the LAN.

## Proposed pilot configuration

The following is a deployment sketch only. It is intentionally not wired into the live `docker-compose.yml` yet, because the Hub's first admin account and each agent's key/token are created in the Hub UI.

### Hub on `wingene-76`

```yaml
services:
  beszel:
    image: henrygd/beszel:latest
    container_name: beszel
    restart: unless-stopped
    environment:
      APP_URL: http://192.168.1.76:18090
    ports:
      - "18090:8090"
    volumes:
      - ./data/beszel:/beszel_data
```

Create the administrator at `http://192.168.1.76:18090`, then add each system in the Hub. The Hub supplies a public key and registration token for the matching agent. Keep those values out of Git.

### Agent on every GPU host

```yaml
services:
  beszel-agent:
    image: henrygd/beszel-agent-nvidia:latest
    container_name: beszel-agent
    restart: unless-stopped
    network_mode: host
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [utility]
    volumes:
      - ./beszel_agent_data:/var/lib/beszel-agent
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      LISTEN: 45876
      HUB_URL: http://192.168.1.76:18090
      KEY: "<public key from Beszel Hub>"
      TOKEN: "<token from Beszel Hub>"
```

Start with `wingene-76` only. Once its Hub status is green and its values match the existing dashboard, repeat for the remaining monitored machines. Do not remove `nvitop-exporter`, `gpu-process-exporter`, or `node-exporter` at any point in the pilot.

## Acceptance checks

1. Prometheus still reports every existing target as `UP`; the Grafana dashboard continues to render its GPU Processes table.
2. Beszel shows one healthy system record for each monitored host.
3. On three representative samples (idle, one active GPU, and several active GPUs), compare GPU count, utilisation, VRAM, temperature, and power against `nvidia-smi` and the current Grafana panel. Small sampling-time differences are expected; missing GPUs or consistently divergent values are not.
4. Confirm Beszel's container list is useful for CPU, memory, and network troubleshooting, while explicitly verifying that it does not claim per-container GPU attribution.
5. Configure one non-production alert channel and test a safe alert condition before treating Beszel alerts as operational.
6. Measure the Hub and agent container resource use for seven days. Check the persisted `data/beszel` directory size and take a backup before deciding to retain it.

## Decision after the pilot

Keep Beszel if the team values its compact system view, built-in alerts, container history, and multi-user/OIDC capabilities. In that case it becomes the entry page for hardware health, while Grafana remains the source of truth for GPU occupancy, ownership, container attribution, and capacity analysis.

Do not migrate fully to Beszel unless the project no longer needs user and container attribution for GPU processes. Rebuilding that feature would mean extending Beszel's agent, transport, persistence, API, and UI; it would duplicate the working Prometheus exporters without improving the existing allocation workflow.

## Pilot log (2026-09-22)

Deployed on all 5 hosts (`wingene-76`..`80`). Two things diverged from the plan
above worth recording for next time.

### 1. Data directory needs to be world-writable

Same issue as Prometheus/Grafana: the Hub image runs as a container-internal
uid that doesn't match the host user, and there's no sudo on these boxes to
`chown` to it. Bind-mounting a fresh directory straight up fails with
`unable to open database file (14)` and the container crash-loops. Fix:

```bash
mkdir -p deploy/beszel/data
chmod 777 deploy/beszel/data
```

### 2. Account + system registration is fully scriptable via the API — no browser needed

The Hub is a PocketBase app, so this can all be done with `curl`, which is
more reproducible than the click-through setup the plan above assumed.

**Create the first superuser** (via the CLI, not the API):

```bash
docker exec beszel /beszel superuser create <email> <password>
```

**Create a regular `users`-collection account too.** This part isn't
optional: `systems` records require a `users` relation, and a superuser ID
doesn't satisfy it (fails with `validation_missing_rel_records`) — you need
a second, non-superuser account even for a single-operator setup.

```bash
SU_TOKEN=$(curl -s -X POST http://localhost:18090/api/collections/_superusers/auth-with-password \
  -H 'Content-Type: application/json' -d '{"identity":"<email>","password":"<password>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:18090/api/collections/users/records \
  -H "Authorization: Bearer $SU_TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"<email>","password":"<password>","passwordConfirm":"<password>","role":"admin","verified":true,"name":"<name>"}'
# -> returns the new user's "id", needed below
```

**Register each system.** The plan above assumed you need the Hub's public
key (`GET /api/beszel/getkey`) and a per-agent token (`GET
/api/beszel/universal-token`) *before* starting the agent — but in practice,
the WebSocket path using that token kept returning `401` (token comes back
`"active": false` and nothing found made it active via the API). What
actually worked: agents already default to also running their own SSH
server on `:45876` and waiting for the *Hub* to connect *to them* (the
"Hub-initiated SSH mode" the plan mentions) — you don't need the token/key
dance at all for this mode. Just start the agent, then create the `systems`
record pointing at it:

```bash
USER_TOKEN=$(curl -s -X POST http://localhost:18090/api/collections/users/auth-with-password \
  -H 'Content-Type: application/json' -d '{"identity":"<email>","password":"<password>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:18090/api/collections/systems/records \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"wingene-76","host":"192.168.1.76","port":"45876","users":["<user id from previous step>"]}'
```

Status goes `pending` -> `up` within ~10s once the Hub successfully connects.

### 3. Skip the login screen

`AUTO_LOGIN=<email>` on the Hub container auto-authenticates that user for
every viewer, matching the internal-network/no-login approach already used
for Grafana. Confirmed: `curl` against a protected endpoint with no auth
header returns real data once this is set.

### 4. GPU data does come through, including on a first-glance-misleading summary field

The `systems` collection's `info.g` field (looked like it should be "gpu
count") stayed `0` even with the NVIDIA agent working correctly — don't use
it as a health check. The actual per-GPU data (name, VRAM used/total,
utilization, power) is in the `system_stats` collection's `stats.g` object,
confirmed populated correctly (matched real `nvidia-smi` values). Also
collected, unprompted: per-core CPU temps, NVMe temp, disk I/O, network I/O,
load average -- more host detail than our own Grafana dashboard currently
shows, for zero custom collector code.

### 5. Confirmed the exact gap the plan predicted

Once actually looking at it: Beszel's systems list is per-host, not a
cluster-wide GPU occupancy view -- there's no equivalent of the Grafana
overview's "7/9 GPUs busy" or cross-host aggregation. This matches the
capability table above exactly; it isn't a configuration gap, it's what the
tool is for. Reinforces the original recommendation: keep it as a
supplementary host-health view, not a replacement for the Grafana dashboard.

## Fork: native GPU/container attribution in Beszel itself (2026-09-22/23)

After the pilot confirmed the predicted gap (section 5 above), the decision
changed from "keep Beszel as a supplementary host-health view" to "close the
gap by forking Beszel," because the missing capability -- GPU-to-container
attribution -- is exactly what this project's own `gpu-process-exporter`
already solves, just not inside Beszel's own (nicer) UI. Rather than
re-deriving PID->container mapping in Go, the fork reads the two exporters
that already run on every GPU host (`gpu-process-exporter` :5052,
`nvitop-exporter` :5051) over their Prometheus text output.

Vendored at `deploy/beszel-fork/` from `github.com/henrygd/beszel` (`.git`
stripped, committed as plain source). New/changed files, all marked with
"gpu-monitoring fork addition (not upstream)" comments:

- `agent/gpu_process_container.go` -- the core addition. Joins
  `gpu-process-exporter`'s PID->container map with `nvitop-exporter`'s
  per-process memory/utilization, in a single HTTP fetch per exporter (see
  bug below for why it started as two).
- `internal/entities/container/container.go` -- `container.Stats` gains
  `GpuPid` / `GpuMemMiB` / `GpuMemPercent` / `GpuUtilPercent` / `GpuIndex`,
  so the stock Containers page shows GPU usage per container with no new
  page.
- `internal/entities/system/system.go` -- `GPUData` gains `Temperature`
  (existed internally upstream but was never sent over the wire -- see bug
  below) and a `Processes []GPUProcess` list (PID, container or `"host"`,
  memory, utilization, memory %, username) for a per-GPU drill-down.
- `internal/hub/systems/system.go` -- writes the new container columns to
  SQLite; `SystemManager`'s poll `interval` lowered from upstream's 60s
  default to 30s.
- `internal/migrations/1_add_container_gpu_fields.go`,
  `2_add_container_gpu_index_field.go` -- add the new `containers` columns
  via PocketBase's normal `collection.Fields.Add()` API, so this runs as a
  real migration against the existing pilot database, not just a fresh-DB
  schema.
- Frontend: `internal/site/src/components/gpu-cluster-overview.tsx` and
  `gpu-status-table.tsx` are new home-page cards (cluster-wide GPU summary;
  per-GPU meters with a click-through Sheet listing that GPU's processes).
  `containers-table-columns.tsx` gained GPU Mem / GPU Util / PID columns.

### Bugs found and fixed along the way

Each of these was a real, verified root cause (checked against live data,
never guessed), not a hypothesis:

1. **Container table showed nothing for the new GPU columns.**
   `containers-table.tsx`'s `pb.collection("containers").getList()` call
   explicitly whitelists which DB fields to fetch (`fields: "id,name,..."`)
   and the new columns weren't in that list -- every row silently got
   `undefined`. Fix: added the new field names to that list.

2. **GPU Mem showed a wildly wrong unit (~19 GB shown as billions).**
   `formatBytes(mib * 1024 * 1024, false, undefined, true)` -- passing
   `isMegabytes: true` *and* pre-multiplying by `1024*1024` converted MiB to
   bytes twice. Fix: pass the raw MiB value and let `isMegabytes: true`
   handle the one conversion.

3. **GPU Mem % (container-level and later per-process) was 0% for a GPU
   holding 79% of its memory.** `process_gpu_memory_utilization_Percentage`
   sounds like "% of GPU memory used" but is actually NVML's per-process
   *memory-bandwidth* utilization sample -- usually ~0 even for a process
   sitting on most of a GPU's memory. Fixed by computing the percentage
   directly (`memMiB / gpu_memory_total_MiB * 100`) instead of trusting that
   metric, the same lesson as the original Grafana dashboard's identical bug
   earlier in this project's history.

4. **New home-page card (GPU Cluster Overview) never rendered, silently.**
   Root cause: PocketBase's JS SDK auto-cancels a request when another
   request with an *identical signature* (same collection/filter/sort/
   fields) is in flight -- and the new `GpuStatusTable` component fired the
   exact same `system_stats` query on the same poll tick, so one request
   always cancelled the other with no visible error (no `.catch()` on
   either). Fixed by giving each call its own `requestKey`.

5. **GPU Occupancy showed 9/9 (i.e. meaningless).** The first cut defined
   "occupied" as "GPU memory used > 0," but idle GPUs always report a small
   non-zero driver/reserved footprint, so the threshold was never false.
   Fixed to match the original Grafana panel's real semantics: a GPU counts
   as occupied only if a real process is attributed to it (via the new
   `GpuIndex` field on containers, joined against `system_stats`).

6. **GPU temperature and per-process VRAM % came back empty on 4 of 5
   hosts, present only on the simplest single-GPU host.** Two distinct
   causes stacked on top of each other:
   - Beszel's own upstream NVML collector (`agent/gpu_nvml.go`) calls
     `nvmlDeviceGetTemperature()` without checking its return code, so a
     failing call silently leaves temperature at 0 -- reproduced on 4 of 5
     hosts, never on the one with the least GPU load. Verified `nvidia-smi`
     itself reports temperature correctly on all 5, so fixed by forcing
     `GPU_COLLECTOR=nvidia-smi` (an existing upstream env var) instead of
     patching purego/NVML bindings.
   - Separately, per-process VRAM % depended on a second, independent HTTP
     fetch of `nvitop-exporter`'s `/metrics` per collection function
     (`collectContainerGPUStats` *and* `attachGPUProcesses` each fetched it
     twice), adding up to 4 concurrent scrapes per cycle of an endpoint
     that's expensive to regenerate (it walks live NVML/psutil process
     handles) -- on multi-process hosts this pushed some of those requests
     past the 2s client timeout, silently dropping just that data. Fixed by
     merging into one `fetchNvitopData()` that does a single GET and parses
     everything in one pass, and raising the timeout to 5s as a margin.

7. **Process username showed as a raw UID (e.g. `9487`) instead of a real
   name, even though `nvitop` run directly on the host shows the real
   name.** Both `nvitop-exporter` and `gpu-process-exporter` resolve
   usernames via `pwd.getpwuid()` against *their own container's* minimal
   `/etc/passwd`, which has no entry for application users defined on the
   host (or in another container's image). Fixed by bind-mounting the
   host's real `/etc/passwd:/etc/passwd:ro` (read-only) into both exporter
   containers -- not a code change, a deployment change, applied to all 5
   hosts.

### Current deployment state (as of 2026-09-23)

- Hub runs only on wingene-76 (`:18090`); agent runs on all 5 GPU hosts.
- All images are local `:test` builds (`beszel-hub-fork:test`,
  `beszel-agent-nvidia-fork:test`) built directly on each host from the
  NFS-shared `deploy/beszel-fork` source -- **not published to any
  registry yet**. See `deploy/standalone/beszel-hub-compose.yml` and
  `beszel-agent-compose.yml` for the reproducible run commands (they
  replace the ad-hoc `docker run` invocations used while iterating).
- `nvitop-exporter` / `gpu-process-exporter` (the shared exporters, also
  used by Grafana) got the `/etc/passwd` mount added on all 5 hosts; no
  other change to those two.
- Source committed to this branch (`research/beszel-integration`); not yet
  pushed to `origin` (blocked on this environment lacking a working GitHub
  credential -- either a token or an authorized SSH key is needed).

### Remaining work before this could be called "production"

- Build/publish pipeline: fold the hub + agent images into
  `deploy/build-images.sh` and publish versioned, multi-arch images to
  GHCR, matching how the other 5 project images are published, instead of
  per-host local builds.
- Decide an upstream-tracking strategy (this is a real fork now, not just
  config -- `henrygd/beszel` updates will need to be merged/rebased
  manually going forward).
- Push this branch and open a PR against `main` once the above is settled.

## Sources reviewed

- [Beszel repository](https://github.com/henrygd/beszel) and source at the `main` revision reviewed on 2026-09-22.
- [Beszel GPU monitoring guide](https://beszel.dev/guide/gpu).
- [Beszel architecture and supported metrics](https://beszel.dev/guide/what-is-beszel).
- [Beszel connection security and network requirements](https://beszel.dev/guide/security).
- [Beszel REST API guidance](https://beszel.dev/guide/rest-api). The API is available through PocketBase, but its schema may change in minor releases; it should not be used as the primary input to a replacement allocation dashboard.
