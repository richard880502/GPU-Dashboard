"""Environment-driven configuration, loaded once at import time so a
misconfigured deployment fails immediately on startup instead of failing
confusingly on the first poll cycle."""

import os


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _optional(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


def _optional_list(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


SLACK_BOT_TOKEN = _require("SLACK_BOT_TOKEN")

# One live dashboard message per target, kept independently up to date --
# any mix of shared channels (the bot must be invited to each) and DMs
# (needs the im:write scope in addition to chat:write) is fine, e.g.
# SLACK_CHANNEL_ID=C0123,C0456 SLACK_DM_USER_ID=U0123,U0456
SLACK_CHANNEL_IDS = _optional_list("SLACK_CHANNEL_ID")
SLACK_DM_USER_IDS = _optional_list("SLACK_DM_USER_ID")
if not SLACK_CHANNEL_IDS and not SLACK_DM_USER_IDS:
    raise RuntimeError("set SLACK_CHANNEL_ID and/or SLACK_DM_USER_ID (comma-separated for more than one)")

REFRESH_INTERVAL_SECONDS = int(_optional("SLACK_REFRESH_INTERVAL_SECONDS", "30"))

# Optional: reply with a fresh snapshot whenever the bot is @-mentioned (see
# mention_listener.py). Needs a separate app-level token (xapp-...,
# connections:write scope, from Basic Information -> App-Level Tokens) and
# the app_mentions:read bot scope, plus enabling Socket Mode itself in the
# app's settings. Left unset, this feature is simply off -- everything else
# behaves exactly as before.
SLACK_APP_TOKEN = _optional("SLACK_APP_TOKEN", "")

# All cluster data comes from the Beszel hub's own API -- see hub_client.py
# for why this replaced scraping each host's exporters directly.
HUB_URL = _optional("HUB_URL", "http://127.0.0.1:13000").rstrip("/")
HUB_EMAIL = _require("HUB_EMAIL")
HUB_PASSWORD = _require("HUB_PASSWORD")

# Link back to the full dashboard from each Slack card -- defaults to
# whatever HUB_URL is, but is separate because HUB_URL may be an
# internal/loopback address while DASHBOARD_URL needs to be something a
# person's browser can actually reach.
DASHBOARD_URL = _optional("DASHBOARD_URL", HUB_URL).rstrip("/")

STATE_PATH = _optional("STATE_PATH", "/data/state.json")
