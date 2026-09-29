"""Dynamic DM subscriber list -- user ids added by DMing the bot directly
(see event_listener.py's DM handler), layered on top of whatever's
statically configured via SLACK_DM_USER_ID. Kept separate from
slack_client.py's per-target bootstrap state (channel/ts pairs), since this
list changes based on what people say to the bot, not on what got posted
where.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from . import config

log = logging.getLogger(__name__)


def _path() -> Path:
    return Path(config.SUBSCRIBERS_PATH)


def load() -> set[str]:
    path = _path()
    if not path.exists():
        return set()
    try:
        return set(json.loads(path.read_text()))
    except (json.JSONDecodeError, OSError) as e:
        log.warning("could not read subscribers file %s, treating as empty: %s", path, e)
        return set()


def _save(subscriber_ids: set[str]) -> None:
    """Write to a temp file then rename -- same crash-safety reasoning as
    slack_client.py's state file: a half-written file must never be read
    back as valid, or a crash mid-write could silently drop subscribers."""
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=".subscribers-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(sorted(subscriber_ids), f)
        os.replace(tmp_path, path)
    except Exception:
        os.unlink(tmp_path)
        raise


def add(user_id: str) -> bool:
    """Returns True if this user was newly added, False if already subscribed."""
    subscriber_ids = load()
    if user_id in subscriber_ids:
        return False
    subscriber_ids.add(user_id)
    _save(subscriber_ids)
    return True


def remove(user_id: str) -> bool:
    """Returns True if this user was subscribed (and is now removed), False
    if they weren't subscribed to begin with."""
    subscriber_ids = load()
    if user_id not in subscriber_ids:
        return False
    subscriber_ids.discard(user_id)
    _save(subscriber_ids)
    return True
