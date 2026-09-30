"""Slack Web API client implementing the bootstrap-once-then-update-forever
pattern this whole service exists for, independently per target (any mix of
shared channels and DMs): chat.postMessage exactly once per target (when no
state exists for it yet), then chat.update for every refresh after that,
keyed by the channel+ts saved from that target's first post.

The one thing this module must never do is call chat.postMessage twice for
what should be the same ongoing dashboard message -- see publish()'s comment
on why a chat.update failure does NOT fall back to posting a new message.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from . import config, subscribers

log = logging.getLogger(__name__)

_client = httpx.Client(
    base_url="https://slack.com/api",
    headers={"Authorization": f"Bearer {config.SLACK_BOT_TOKEN}"},
    timeout=10.0,
)


@dataclass(frozen=True)
class Target:
    state_key: str  # stable key into state.json, independent of the resolved channel id
    is_dm: bool
    id: str  # a channel id, or a user id when is_dm


def _targets() -> list[Target]:
    targets = [Target(state_key=f"channel:{c}", is_dm=False, id=c) for c in config.SLACK_CHANNEL_IDS]
    # Statically configured DM recipients, plus anyone who's self-subscribed
    # by DMing the bot directly (see event_listener.py) -- re-read every
    # call rather than cached, since publish() (and therefore this) runs
    # every refresh cycle and a subscriber added moments ago must be picked
    # up on the very next one, not require a restart.
    dm_ids = sorted(set(config.SLACK_DM_USER_IDS) | subscribers.load())
    targets += [Target(state_key=f"dm:{u}", is_dm=True, id=u) for u in dm_ids]
    return targets


def _load_state() -> dict:
    path = Path(config.STATE_PATH)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("could not read state file %s, treating as absent: %s", path, e)
        return {}


def _save_state(state: dict) -> None:
    """Write to a temp file then rename, so a crash mid-write can never
    leave a half-written (and therefore unparseable, and therefore
    treated-as-absent) state file -- that would cause a duplicate bootstrap
    post the next time this service starts."""
    path = Path(config.STATE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=".state-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
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


def _resolve_post_channel(target: Target) -> str:
    """Where to send the *bootstrap* message for one target. conversations.open
    is idempotent -- repeated calls for the same user return the same DM
    channel id -- so this never needs its own cache; it only runs on the
    one-time-per-target bootstrap path anyway."""
    if target.is_dm:
        return _call("conversations.open", users=target.id)["channel"]["id"]
    return target.id


def publish(blocks: list[dict], fallback_text: str) -> None:
    """Update every configured target's persistent dashboard message,
    bootstrapping (or re-bootstrapping, if a saved message was deleted) any
    target that doesn't have one yet. One target's failure never blocks the
    others."""
    state = _load_state()
    state_changed = False

    for target in _targets():
        entry = state.get(target.state_key)

        if entry is not None:
            try:
                _call("chat.update", channel=entry["channel"], ts=entry["ts"], text=fallback_text, blocks=blocks)
                continue
            except RuntimeError as e:
                if "message_not_found" not in str(e):
                    # Any other API-level failure (Slack responded, but with
                    # ok:false) must NOT fall through to posting a
                    # replacement -- a missed refresh for this target is
                    # fine, a second permanent dashboard message in its
                    # channel/DM is not. Retry against the same ts next cycle.
                    log.error("chat.update failed for %s, will retry next cycle: %s", target.state_key, e)
                    continue
                log.warning("saved message for %s no longer exists; posting a replacement", target.state_key)
            except httpx.HTTPError as e:
                # A transport-level failure (rate limit / other 4xx/5xx from
                # raise_for_status, timeout, connection error) -- same
                # never-fall-through-to-a-replacement reasoning as the
                # RuntimeError case above. This used to be uncaught here,
                # which meant one target's rate limit or network blip
                # aborted this whole publish() call, skipping every target
                # still left in _targets() for the rest of this cycle -- not
                # just failing to update the one that actually errored.
                log.error("chat.update request failed for %s, will retry next cycle: %s", target.state_key, e)
                continue

        try:
            channel_id = _resolve_post_channel(target)
            result = _call("chat.postMessage", channel=channel_id, text=fallback_text, blocks=blocks)
        except (RuntimeError, httpx.HTTPError) as e:
            log.error("failed to bootstrap %s, will retry next cycle: %s", target.state_key, e)
            continue

        state[target.state_key] = {"channel": result["channel"], "ts": result["ts"]}
        state_changed = True
        log.info("posted new dashboard message target=%s channel=%s ts=%s", target.state_key, result["channel"], result["ts"])

    if state_changed:
        _save_state(state)
