# Netdata (research branch)

Self-hosted Netdata, no Cloud claiming — parent/child streaming across
wingene-76 (parent) + wingene-77/78/79 (children). wingene-80/81 intentionally
excluded (no GPU / not needed per current scope).

## Custom pieces

- `Dockerfile` — `FROM netdata/netdata:latest` + bakes in `gpu_processes.plugin`.
  Rebuild + recreate the container whenever the plugin script changes.
- `gpu_processes.plugin` — a Netdata **Functions** plugin (table, not a chart —
  Netdata charts are time series, this is a live lookup). Maps each GPU PID to
  its Docker container via `/proc/<pid>/cgroup` + a raw HTTP call to
  `/var/run/docker.sock` (no `docker` CLI or Python package needed/available in
  the base image). Same idea as the container-mapping we already built for
  Grafana, reimplemented as a native Netdata Function so it shows up in
  Netdata's own UI too, not just Grafana's.

## Deploy (per host)

```bash
docker build -t netdata-custom:local deploy/docker/netdata
docker run -d --name=netdata \
  --pid=host --network=host --gpus all \
  -v netdataconfig:/etc/netdata -v netdatalib:/var/lib/netdata -v netdatacache:/var/cache/netdata \
  -v /etc/passwd:/host/etc/passwd:ro -v /etc/group:/host/etc/group:ro \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /etc/os-release:/host/etc/os-release:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  --restart unless-stopped --cap-add SYS_PTRACE --cap-add SYS_ADMIN \
  --security-opt apparmor=unconfined \
  netdata-custom:local
```

Parent (.76) additionally needs `/etc/netdata/stream.conf` with a
`[<api-key-uuid>]` receive section (`enabled = yes`). Each child needs
`/etc/netdata/stream.conf` with `[stream] enabled = yes / destination =
192.168.1.76:19999 / api key = <same uuid>`, plus `netdata.conf`
`[global] hostname = <name> / memory mode = none` (child keeps no local
history — it's centralized on the parent).

The API key itself is a shared secret, generated with `uuidgen`/
`/proc/sys/kernel/random/uuid` — not committed here; regenerate and keep it
out of git.

## Calling the function per node

Node-scoped API calls go through a `/host/<hostname>/` URL prefix, not a query
param or header:

```
GET http://192.168.1.76:19999/host/wingene-78/api/v1/function?function=gpu-processes&timeout=10
```

## Known side effect

Mounting `/var/run/docker.sock` also gives Netdata's own built-in
service-discovery access to it, so it starts auto-probing every discovered
container's exposed ports (saw noisy failed Postgres-connection log lines on
.79 from containers we have no credentials for) — harmless, just log noise.

## Decision: Netdata Cloud claiming — declined

User chose to stay fully local/unclaimed (no external account), accepting the
plainer local dashboard over the Cloud's more polished multi-node "Rooms" UI.
