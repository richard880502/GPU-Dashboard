# Service CPU / GPU usage history (implementation plan)

Status: **MVP implemented on feature/service-resource-usage-history.** Backend daily ingestion, PocketBase collection, persistent system-level cursor, monthly UI and collection access rules are committed. GitHub Actions CI must still pass before production rollout.

## Goal

Add a Hub-side Services → Usage Analytics view to report monthly and daily CPU and GPU resource consumption, across Docker containers, replicas and monitored hosts, without requiring Prometheus.

## Existing behavior and first fix

- The agent already sends per-container CPU, GPU utilization and GPU VRAM metrics.
- Hub stores 1m container_stats and rolls up to 10m / 20m / 120m / 480m.
- Before this branch, AverageContainerStatsSlice dropped all container GPU metrics from longer retention tiers.
- This branch preserves mean GPU utilization, GPU VRAM MiB and VRAM percentage during rollups, including the union of GPU indices, with regression tests.
- The standard 480m retention tier is deleted after 30 days. It is **not** a durable month-history store.
- Existing historic rollups with lost GPU fields cannot be reconstructed without raw/exported samples.

## Proposed durable data model

Use a new Hub-side `service_usage_daily` collection. One record per `system_id + service_id + day`; preserve system and service display names for deleted/redeployed workloads. UTC timestamps for integration, explicit configurable reporting time zone for calendar-day/month partitioning.

Fields:

- system_id, service_id, day, service_name
- covered_seconds, missing_seconds, sample_count, last_seen_at
- cpu_core_seconds (resource integral, NOT a percentage)
- gpu_util_equivalent_seconds (sum of per-GPU utilization fractions integrated over time)
- gpu_allocated_seconds (optional, only if actual allocation data exists)
- vram_mib_seconds (integrated allocated per-process VRAM)
- peak_cpu_cores, peak_gpu_util, peak_vram_mib
- attribution_source and estimation/coverage flags

Derive `CPU core-hours = cpu_core_seconds / 3600`, `GPU utilization-equivalent hours = gpu_util_equivalent_seconds / 3600`, and `VRAM GiB-hours = vram_mib_seconds / 1024 / 3600`. Distinguish **allocation hours** from **utilization-equivalent hours** in the UI. These are different concepts. Process GPU utilization samples can add above 100% when more than one process or GPU is involved; keep per-GPU samples/attribution whenever possible rather than clamping combined utilization to 100%.

**CPU measurement contract:** check the agent's per-container CPU normalization before converting to core-seconds. Current reported `container.Stats.Cpu` is bounded at 100% by the agent and should not automatically be treated as Docker-style 100% per core; otherwise core-hours will be incorrect. If necessary collect cgroup CPU usage nanoseconds (monotonic) or explicitly use per-container CPU share plus online CPU capacity. This may require an Agent protocol revision after the Hub-only MVP.

## Hub ingestion and durability

1. Hook on **new 1m container_stats**, not on rollups. Ingest each sample once, keyed by (system, service, day).
2. Integrate elapsed time between consecutive valid polls; split intervals at local midnight. Never fill outages longer than a bounded max-gap threshold.
3. Avoid double counting on retries/restarts by persisting a cursor or maintaining idempotent bucket keys; memory-only accumulation plus periodic flush risks losing data on abrupt crashes.
4. Persist daily counters using transactional updates; retain daily rows indefinitely or with separately configured annual retention.
5. Add index on (system, service, day) and (day), permissions matching systems membership.
6. Ensure data survive container replacement and retain the service label if a monitored system disappears.
7. Track coverage explicitly. No sample is **unknown**, not automatically zero usage. An absent container in a successfully sampled node may be zero for that specific interval.

## Service attribution

Start with a Hub-managed mapping of `system + container name pattern → service_id`. Explicit user rules take precedence. Use stable service identifiers, not container IDs. Follow up with Compose label `com.docker.compose.service`, Kubernetes namespace/workload and deployment metadata; that can require a small Agent change. Store attribution provenance and avoid grouping unrelated names across hosts.

## UI

Services → Usage Analytics: service selector, date range / month, daily and monthly charts, CPU core-hours, GPU utilization-equivalent hours, VRAM GiB-hours, total covered time, missing-data indication, comparisons by server and GPU. Month-to-month comparisons use the same local time zone and filter.

## Required tests

- Multi-day and midnight splitting, including time-zone offset/DST.
- Missing and out-of-order samples; gap cap; zero GPU vs no GPU sensor data.
- Service restart / renamed container / multiple replicas / multi-GPU attribution.
- Rollup preservation of CPU/GPU/VRAM fields (partly covered by Phase 1).
- Repeated or failed flush, hub restart and idempotency.
- End-to-end authenticated API access for allowed vs unrelated systems.
- Monthly aggregates for partial months and sparse history.

## Delivered MVP

- Existing container GPU usage, GPU memory and GPU index fields survive the standard 10m / 20m / 120m / 480m rollups.
- New `service_usage_daily` stores per-system, per-service, per-calendar-day counters without the standard 30-day retention sweep.
- New `service_usage_cursor` stores the most recently accounted poll timestamp for each system, written in the same transaction as the daily increment.
- Each incoming system update integrates CPU share, GPU process utilization and VRAM samples, splitting at the Hub's configured local midnight.
- `SERVICE_USAGE_GROUPS` environment mapping optionally groups replica container names into stable services. Without a mapping, each distinct container name is a service.
- `/services-analytics` shows month, service and host filters, daily usage and per-service totals.
- `service_usage_daily` reads obey system membership rules; the ingestion cursor is private.
- No changes required to monitored agents for this initial feature.

## How to try it

1. Check out `feature/service-resource-usage-history`.
2. From `deploy/beszel-fork` run:

   ```bash
   bun install --cwd internal/site
   bun run --cwd internal/site build
   go test -tags='testing no_ui' ./internal/records/... ./internal/hub/...
   docker build -f internal/dockerfile_hub -t beszel-hub-fork:usage-history .
   ```

3. Test against a **separate** Beszel data directory first; migrations create two new collections.
4. Optionally set a Compose `.env` entry:

   ```dotenv
   SERVICE_USAGE_GROUPS='{"vllm-api":["vllm-api-*","vllm-api"],"whisperx":["asr-*","whisperx"]}'
   ```

   The Hub's `deploy/standalone/beszel-hub-compose.yml` forwards it to the Hub container. Exact container names are used when omitted. The first matching group in lexicographic order wins; avoid overlapping patterns.

5. Access `http://<hub-host>:<port>/services-analytics` after authenticating.

## GPU active clock-hours (additional, independent metric)

The permanent `service_gpu_active_hours` collection tracks one **GPU-active
clock-hour bucket** per monitored host / service / local calendar hour.
The Hub inserts a marker on the first actual GPU-attributed poll in each
clock-hour, even if GPU utilization is 0% but the process still holds VRAM.
A CPU-only container with no GPU attribution is **not** GPU-active.

- A service observed at 10:05 and again at 10:45 counts **1 hour**, not two.
- Observed at 10:59 and 11:01 counts **2 hours**, even if total runtime
  was only a few minutes.
- 5% and 95% GPU utilization both count **1 active clock-hour** if the
  service is observed during that hour.
- Across replicas / hosts, the UI counts each **service + actual clock-hour**
  once when All Servers is selected; filtering to a host restricts the count.
- The hour key is the UTC instant of that *local* hour's start (distinct
  for repeated DST hours), while the date key follows the Hub's `TZ`.
- Collection writes happen in the same transaction as the sampling cursor,
  so repeated polls/restarts do not duplicate an hour.
- This is an hourly **presence/occupancy** metric: not an actual duration,
  not GPU utilization-equivalent hours, not GPU allocation/billing time,
  and not multiplied by physical GPU count.
- Earlier `service_usage_daily` data cannot reveal which exact hours had
  activity, so this indicator begins with the first GPU-attributed samples
  after deploying the new migration. Historical backfill requires raw
  `container_stats` samples where GPU attribution fields were preserved.

Migrations are **additive**: migration 7 creates the new collection, leaving
migration 6 and existing daily data intact. Its read access is restricted by
the same system membership policy as other Services Analytics records.

## Metric semantics and limitations

- **CPU core-hours** = Σ (per-container CPU% normalized to whole host / 100) × host logical CPU count × elapsed seconds / 3600.
- **GPU utilization-equivalent hours** = Σ (per-container sampled GPU process utilization% / 100) × elapsed seconds / 3600. It is not billable/reserved GPU allocation time. Multiple processes/GPUs may yield more than 1 GPU-equivalent per wall-clock hour.
- **VRAM GiB-hours** = Σ (container sampled VRAM MiB × elapsed seconds) / 1024 / 3600.
- **Recorded service-hours** sum observed intervals across services and nodes, not an always-on uptime percentage.
- Counts begin with **the first subsequent valid pair of polls** after the feature is deployed. Historic lost GPU samples cannot be recovered automatically.
- Gaps over two minutes are dropped; short gaps approximate workload usage using the latest sample.
- GPU measurements with no process association are unknown, not a confirmed zero. Host processes not attributed to a tracked container are not included.
- Daily boundaries use the Hub's `TZ` (Asia/Taipei in the supplied Compose). Month controls use the browser's current month.
- CPU core-hours require a valid reported logical CPU count; the UI reports the measured CPU and GPU durations separately.
- If a system is removed, associated records are retained under the collection but the standard membership rule prevents other users from viewing them.

## Future improvements

- Automatic Docker Compose labels and Kubernetes deployment/namespace identity.
- Per-GPU physical utilization attribution rather than summed sampled process percentages.
- Exports, period comparisons and quality-of-data alerts.
- Hardened backfill/reconciliation from durable raw logs if historical events are later available.
