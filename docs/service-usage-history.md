# Service CPU / GPU usage history (implementation plan)

Status: **Phase 1 foundation committed; monthly service reports not implemented yet.**

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

## Delivery phases

- **Phase 1 (this branch):** repair existing container GPU history rollups + regression tests.
- **Phase 2:** create durable service_usage_daily collection, service rules and transactional ingestion, with tests.
- **Phase 3:** authenticated Hub API and Services Usage Analytics UI.
- **Phase 4:** richer Compose/Kubernetes attribution, alerts and exports.

Do not enable long-term billing or treat values as precise service costs until measurement contracts and coverage have been validated against ground truth.
