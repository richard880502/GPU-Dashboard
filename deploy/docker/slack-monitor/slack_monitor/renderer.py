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
_BUSY_THRESHOLD = 1.0  # % GPU utilization below which a GPU counts as idle, not busy


def _bar(percent: float, width: int = 20) -> str:
    """A Unicode block-character progress bar -- plain text, so it renders
    identically in every Slack client without needing an image."""
    percent = max(0.0, min(100.0, percent))
    filled = round(width * percent / 100)
    return "█" * filled + "░" * (width - filled)


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


def _activity_label(server: ServerStatus) -> str:
    if server.status == "down":
        return "Offline"
    if server.status != "up":
        return server.status.capitalize()
    if any(gpu.util_percent >= _BUSY_THRESHOLD for gpu in server.gpus):
        return "Busy"
    return "Idle"


def _gpu_block(gpu) -> str:
    """One GPU's block: utilization line, a VRAM-occupancy bar (the number
    that actually matters for "can I fit a job on this GPU"), and temp --
    bar width kept short (10 chars) since this whole thing has to fit
    alongside a second GPU's block inside a 200-char card body."""
    vram_pct = (gpu.memory_used_mib / gpu.memory_total_mib * 100) if gpu.memory_total_mib else 0
    mem_used_gb = gpu.memory_used_mib / 1024
    mem_total_gb = gpu.memory_total_mib / 1024
    temp = f" {gpu.temp_c:.0f}°C" if gpu.temp_c is not None else ""
    return (
        f"GPU{gpu.index} {gpu.util_percent:>3.0f}%\n"
        f"{_bar(vram_pct, width=10)} {mem_used_gb:.1f}/{mem_total_gb:.1f}GB{temp}"
    )


def _gpu_lines(server: ServerStatus) -> str:
    if server.status == "down":
        return "Unreachable"
    if not server.gpus:
        return "No GPU data yet"
    return "\n".join(_gpu_block(gpu) for gpu in server.gpus)


def _running_block(server: ServerStatus) -> str:
    all_procs = [p for gpu in server.gpus for p in gpu.processes]
    if not all_procs:
        return "_No active GPU workloads_"
    top = max(all_procs, key=lambda p: p.util_percent)
    who = top.username or "?"
    # A fenced code block reads as a distinct bordered box in Slack's client,
    # the closest thing to the mockup's own bordered "Running" panel that
    # plain mrkdwn text can do.
    return f"Running\n```{who}\n{top.container}```"


def _card_for(server: ServerStatus) -> dict:
    gpu_model = _gpu_model_name(server.gpus[0].name) if server.gpus else None
    subtitle = f"{gpu_model} ×{len(server.gpus)}  ·  {_activity_label(server)}" if gpu_model else "no GPU data"

    cpu = f"{server.cpu_percent:.0f}%" if server.cpu_percent is not None else "-"
    mem = f"{server.mem_percent:.0f}%" if server.mem_percent is not None else "-"

    body = _gpu_lines(server)
    subtext = f"{_running_block(server)}\nCPU {cpu}  ·  RAM {mem}"

    return {
        "type": "card",
        "title": {"type": "mrkdwn", "text": f"{_status_dot(server.status)} {server.hostname}"[:150]},
        "subtitle": {"type": "mrkdwn", "text": subtitle[:150]},
        "body": {"type": "mrkdwn", "text": body[:200]},
        "subtext": {"type": "mrkdwn", "text": subtext[:200]},
        "actions": [
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Open details"},
                "action_id": f"open_dashboard_{server.system_id}",
                "url": config.DASHBOARD_URL,
            }
        ],
    }


def render(servers: list[ServerStatus]) -> list[dict]:
    up = sum(1 for s in servers if s.status == "up")
    total = len(servers)
    now = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")

    all_gpus = [gpu for s in servers for gpu in s.gpus]
    total_gpus = len(all_gpus)
    busy_gpus = sum(1 for gpu in all_gpus if gpu.util_percent >= _BUSY_THRESHOLD)
    vram_used_gb = sum(gpu.memory_used_mib for gpu in all_gpus) / 1024
    offline = sum(1 for s in servers if s.status != "up")

    blocks: list[dict] = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*GPU Cluster Monitor*   {_status_dot('up' if offline == 0 else 'down')} {up}/{total} online\n"
                    f"Updated {now} · auto-refresh every {config.REFRESH_INTERVAL_SECONDS}s\n"
                    # A code block is the only mrkdwn container that
                    # preserves alignment -- regular text collapses runs of
                    # spaces the same way HTML does, so padded columns
                    # outside one would just render as single spaces.
                    "```"
                    f"Total GPUs   GPU Busy   VRAM Used   Offline\n"
                    f"{total_gpus:<13}{busy_gpus:<11}{vram_used_gb:<7.1f}GB    {offline}"
                    "```"
                ),
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
