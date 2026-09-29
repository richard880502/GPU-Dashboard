"""Turns a list[ServerStatus] into a Slack Block Kit payload: one summary
section, one Carousel of up-to-10 per-server Cards, and a footer link back
to the full Beszel dashboard.

No alert/threshold logic here by design (that's a separate, later phase) --
this module only ever describes the cluster's *current* state, so it's easy
to verify by eye against what Slack actually renders.

Card field limits (title/subtitle 150 chars, body/subtext 200 chars, max 3
action buttons, max 10 cards per carousel) are from Slack's own Block Kit
reference: https://docs.slack.dev/reference/block-kit/blocks/card-block/
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from . import config
from .models import ServerStatus

_MAX_CARDS_PER_CAROUSEL = 10
_STATUS_DOT = {"up": "\U0001f7e2", "down": "\U0001f534", "paused": "⏸️", "pending": "\U0001f7e1"}
_TRAILING_DEVICE_INDEX = re.compile(r"\s\d$")


def _gpu_model_name(raw_name: str) -> str:
    """On a multi-GPU host, nvidia-smi's own device name ends in the
    per-card index (e.g. "GeForce RTX 4090 0", "GeForce RTX 3090 1") --
    redundant and confusing once we're about to append " x{count}" for the
    subtitle. Single-GPU hosts don't get this suffix at all, so only strip
    a trailing single digit (an index, 0-9), never a multi-digit model
    number like the "4090" in "RTX 4090" itself."""
    return _TRAILING_DEVICE_INDEX.sub("", raw_name)


def _status_dot(status: str) -> str:
    return _STATUS_DOT.get(status, "⚪")


def _gpu_lines(server: ServerStatus) -> str:
    if server.status == "down":
        return "Unreachable"
    if not server.gpus:
        return "No GPU data yet"
    lines = []
    for gpu in server.gpus:
        temp = f"{gpu.temp_c:.0f}C" if gpu.temp_c is not None else "-"
        mem_used_gb = gpu.memory_used_mib / 1024
        mem_total_gb = gpu.memory_total_mib / 1024
        lines.append(f"GPU{gpu.index} {gpu.util_percent:.0f}% | {mem_used_gb:.1f}/{mem_total_gb:.1f}GB | {temp}")
    return "\n".join(lines)


def _top_process_line(server: ServerStatus) -> str:
    all_procs = [p for gpu in server.gpus for p in gpu.processes]
    if not all_procs:
        return "idle"
    top = max(all_procs, key=lambda p: p.util_percent)
    who = top.username or "?"
    return f"{who} / {top.container} ({top.util_percent:.0f}%)"


def _card_for(server: ServerStatus) -> dict:
    gpu_model = _gpu_model_name(server.gpus[0].name) if server.gpus else None
    subtitle = f"{gpu_model} x{len(server.gpus)}" if gpu_model else "no GPU data"

    cpu = f"{server.cpu_percent:.0f}%" if server.cpu_percent is not None else "-"
    mem = f"{server.mem_percent:.0f}%" if server.mem_percent is not None else "-"

    body = _gpu_lines(server)
    subtext = f"{_top_process_line(server)}\nCPU {cpu} | RAM {mem}"

    return {
        "type": "card",
        "title": {"type": "mrkdwn", "text": f"{_status_dot(server.status)} {server.hostname}"[:150]},
        "subtitle": {"type": "mrkdwn", "text": subtitle[:150]},
        "body": {"type": "mrkdwn", "text": body[:200]},
        "subtext": {"type": "mrkdwn", "text": subtext[:200]},
        "actions": [
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "View in Beszel"},
                "action_id": f"open_dashboard_{server.system_id}",
                "url": config.DASHBOARD_URL,
            }
        ],
    }


def render(servers: list[ServerStatus]) -> list[dict]:
    up = sum(1 for s in servers if s.status == "up")
    down = sum(1 for s in servers if s.status == "down")
    total = len(servers)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    blocks: list[dict] = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*GPU Cluster*\n{up}/{total} online"
                + (f" · {down} unreachable" if down else "")
                + f"\nLast updated: {now}",
            },
        }
    ]

    # Slack caps a single carousel at 10 cards; split into multiple carousel
    # blocks if the fleet ever grows past that instead of silently dropping
    # hosts off the end.
    for i in range(0, len(servers), _MAX_CARDS_PER_CAROUSEL):
        chunk = servers[i : i + _MAX_CARDS_PER_CAROUSEL]
        blocks.append({"type": "carousel", "elements": [_card_for(s) for s in chunk]})

    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"<{config.DASHBOARD_URL}|Open full dashboard>"}],
        }
    )
    return blocks
