"""Fetches current cluster state from the Beszel hub's own PocketBase API.

The original design for this service (GitHub issue #2) scraped each host's
nvitop-exporter/gpu-process-exporter directly, mirroring how the hub itself
used to be supplemented by a separate node-exporter for host metrics. That
node-exporter was removed in 2026-09 once it was confirmed nothing was even
scraping it anymore -- beszel-agent already collects the same host metrics
natively, and the hub already merges per-GPU utilization/VRAM/temp/power
*and* per-process container attribution into one place (system_stats.g).
Going straight to the hub for this service too avoids re-deriving something
Beszel already has, and turns "5 hosts x 2-3 ports" into one API dependency.
"""

from __future__ import annotations

import logging

import httpx

from . import config
from .models import GPUProcess, GPUStatus, ServerStatus

log = logging.getLogger(__name__)

_client = httpx.Client(base_url=config.HUB_URL, timeout=10.0)
_token: str | None = None


def _authenticate() -> str:
    resp = _client.post(
        "/api/collections/users/auth-with-password",
        json={"identity": config.HUB_EMAIL, "password": config.HUB_PASSWORD},
    )
    resp.raise_for_status()
    return resp.json()["token"]


def _authed_get(path: str, **params: str | int) -> dict:
    global _token
    if _token is None:
        _token = _authenticate()
    resp = _client.get(path, params=params, headers={"Authorization": _token})
    if resp.status_code == 401:
        # Token expired or was rejected -- re-auth once and retry, rather
        # than failing this whole cycle over a routine token refresh.
        _token = _authenticate()
        resp = _client.get(path, params=params, headers={"Authorization": _token})
    resp.raise_for_status()
    return resp.json()


def _parse_gpu(index: str, raw: dict) -> GPUStatus:
    return GPUStatus(
        index=index,
        name=raw.get("n") or f"GPU {index}",
        util_percent=raw.get("u", 0),
        memory_used_mib=raw.get("mu", 0),
        memory_total_mib=raw.get("mt", 0),
        temp_c=raw.get("t"),
        power_w=raw.get("p"),
        processes=[
            GPUProcess(
                pid=p.get("pid", ""),
                container=p.get("c") or "host",
                memory_mib=p.get("mu", 0),
                util_percent=p.get("u", 0),
                username=p.get("un"),
            )
            for p in raw.get("procs", [])
        ],
    )


def fetch_cluster_status() -> list[ServerStatus]:
    """One pass: list every system, then join in each one's latest 1-minute
    stats record (same "first record seen per system, already sorted newest
    first" pattern the dashboard's own GPU Status table uses). A system with
    no stats record yet (brand new, or actually down) just gets an empty
    ServerStatus -- rendered as its own "unavailable" card, never dropped
    silently and never allowed to abort the whole cluster's refresh.
    """
    systems = _authed_get(
        "/api/collections/systems/records",
        perPage=200,
        fields="id,name,status,updated",
    )["items"]

    stats_by_system: dict[str, dict] = {}
    stats_resp = _authed_get(
        "/api/collections/system_stats/records",
        filter="type='1m'",
        sort="-created",
        perPage=200,
        fields="system,stats,created",
    )
    for item in stats_resp["items"]:
        sid = item["system"]
        if sid not in stats_by_system:
            stats_by_system[sid] = item["stats"]

    results: list[ServerStatus] = []
    for sys in systems:
        stats = stats_by_system.get(sys["id"], {})
        gpus = [_parse_gpu(idx, raw) for idx, raw in sorted(stats.get("g", {}).items())]
        results.append(
            ServerStatus(
                system_id=sys["id"],
                hostname=sys["name"],
                status=sys["status"],
                updated=sys.get("updated"),
                cpu_percent=stats.get("cpu"),
                mem_percent=stats.get("mp"),
                disk_percent=stats.get("dp"),
                gpus=gpus,
            )
        )
    results.sort(key=lambda s: s.hostname)
    return results
