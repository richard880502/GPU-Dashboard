"""Entry point: polls the hub, renders, publishes to Slack, sleeps, repeats.

A failure in any single cycle is logged and retried next cycle rather than
crashing the process -- a live dashboard that occasionally skips a refresh
beats one that stays down until someone notices the container exited.
"""

from __future__ import annotations

import logging
import time

from . import config, hub_client, renderer, slack_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger(__name__)


def run_once() -> None:
    servers = hub_client.fetch_cluster_status()
    blocks = renderer.render(servers)
    slack_client.publish(blocks, fallback_text="GPU cluster live status")


def main() -> None:
    log.info(
        "slack-monitor starting: hub=%s channels=%s dm_users=%s interval=%ss",
        config.HUB_URL,
        config.SLACK_CHANNEL_IDS,
        config.SLACK_DM_USER_IDS,
        config.REFRESH_INTERVAL_SECONDS,
    )
    while True:
        start = time.monotonic()
        try:
            run_once()
            log.info("refresh ok")
        except Exception:
            log.exception("refresh cycle failed, will retry next cycle")
        elapsed = time.monotonic() - start
        time.sleep(max(0.0, config.REFRESH_INTERVAL_SECONDS - elapsed))


if __name__ == "__main__":
    main()
