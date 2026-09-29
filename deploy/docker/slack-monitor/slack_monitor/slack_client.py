"""Slack Web API client implementing the bootstrap-once-then-update-forever
pattern this whole service exists for: chat.postMessage exactly once (when
no state exists yet), then chat.update for every refresh after that, keyed
by the channel+ts saved from that first post.

The one thing this module must never do is call chat.postMessage twice for
what should be the same ongoing dashboard message -- see publish()'s comment
on why a chat.update failure does NOT fall back to posting a new message.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

import httpx

from . import config

log = logging.getLogger(__name__)

_client = httpx.Client(
    base_url="https://slack.com/api",
    headers={"Authorization": f"Bearer {config.SLACK_BOT_TOKEN}"},
    timeout=10.0,
)


def _load_state() -> dict | None:
    path = Path(config.STATE_PATH)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("could not read state file %s, treating as absent: %s", path, e)
        return None


def _save_state(channel: str, ts: str) -> None:
    """Write to a temp file then rename, so a crash mid-write can never
    leave a half-written (and therefore unparseable, and therefore
    treated-as-absent) state file -- that would cause a duplicate bootstrap
    post the next time this service starts."""
    path = Path(config.STATE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=".state-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"channel": channel, "ts": ts}, f)
        os.replace(tmp_path, path)
    except Exception:
        os.unlink(tmp_path)
        raise


def _call(method: str, **payload: object) -> dict:
    resp = _client.post(f"/{method}", json=payload)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Slack API {method} failed: {data.get('error')}")
    return data


def publish(blocks: list[dict], fallback_text: str) -> None:
    """Update the persistent dashboard message, creating it on first run."""
    state = _load_state()

    if state is not None:
        try:
            _call("chat.update", channel=state["channel"], ts=state["ts"], text=fallback_text, blocks=blocks)
            return
        except RuntimeError as e:
            if "message_not_found" not in str(e):
                # Any other failure (rate limit, network blip, transient
                # Slack 5xx, auth hiccup) must NOT fall through to posting a
                # replacement -- a missed refresh is fine, a second
                # permanent dashboard message in the channel is not. Log and
                # let the next cycle retry the update against the same ts.
                log.error("chat.update failed, will retry next cycle: %s", e)
                return
            log.warning("saved message no longer exists (message_not_found); posting a replacement")

    result = _call("chat.postMessage", channel=config.SLACK_CHANNEL_ID, text=fallback_text, blocks=blocks)
    _save_state(result["channel"], result["ts"])
    log.info("posted new dashboard message channel=%s ts=%s", result["channel"], result["ts"])
