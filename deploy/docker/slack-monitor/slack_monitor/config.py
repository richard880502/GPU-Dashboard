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


SLACK_BOT_TOKEN = _require("SLACK_BOT_TOKEN")
SLACK_CHANNEL_ID = _require("SLACK_CHANNEL_ID")
REFRESH_INTERVAL_SECONDS = int(_optional("SLACK_REFRESH_INTERVAL_SECONDS", "30"))

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
