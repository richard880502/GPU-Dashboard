"""Data this service renders into Slack, decoupled from Beszel's own compact
wire format (single/double-letter JSON keys like "mu"/"mp"/"g") -- see
hub_client.py for that mapping. Keeping these separate means renderer.py
never has to know Beszel's wire format, and hub_client.py is the only place
that needs updating if that format ever changes.
"""

from __future__ import annotations

from pydantic import BaseModel


class GPUProcess(BaseModel):
    pid: str
    container: str
    memory_mib: float = 0
    util_percent: float = 0
    username: str | None = None


class GPUStatus(BaseModel):
    index: str
    name: str
    util_percent: float = 0
    memory_used_mib: float = 0
    memory_total_mib: float = 0
    temp_c: float | None = None
    power_w: float | None = None
    processes: list[GPUProcess] = []


class ServerStatus(BaseModel):
    system_id: str
    hostname: str
    status: str  # "up" | "down" | "paused" | "pending"
    updated: str | None = None
    cpu_percent: float | None = None
    mem_percent: float | None = None
    disk_percent: float | None = None
    gpus: list[GPUStatus] = []
