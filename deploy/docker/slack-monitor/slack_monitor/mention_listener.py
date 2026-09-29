"""Replies with a fresh snapshot of the dashboard whenever the bot is
@-mentioned -- a manual "get me a current one right now" escape hatch. Useful
if the persistent dashboard message itself ever disappears (e.g. a
workspace message-retention policy deleting it -- something this service
has no control over) before the next scheduled refresh would have noticed
and re-bootstrapped it.

Runs over Socket Mode: a persistent outbound WebSocket this process opens to
Slack, not the Events API's inbound webhook -- keeps this whole service's
"only ever connects outbound, nothing reaches in" property intact. Needs its
own app-level token (xapp-..., connections:write scope) and the
app_mentions:read bot scope, in addition to chat:write/im:write.

Entirely optional: if SLACK_APP_TOKEN isn't set, main.py never starts this,
and the rest of the service behaves exactly as it did before this existed.
"""

from __future__ import annotations

import logging

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from . import config, hub_client, renderer

log = logging.getLogger(__name__)


def _handle_mention(event: dict, say) -> None:
    try:
        servers = hub_client.fetch_cluster_status()
        blocks = renderer.render(servers)
        say(text="GPU cluster live status", blocks=blocks, thread_ts=event.get("ts"))
    except Exception:
        log.exception("failed to respond to mention")
        say(text="Couldn't fetch the current cluster status -- check the container logs.", thread_ts=event.get("ts"))


def start() -> None:
    """Blocks forever -- main.py runs this in its own thread alongside the
    polling loop, since both need to run concurrently in one process."""
    # signing_secret is only ever used to verify inbound HTTP requests
    # (Events API mode) -- Socket Mode receives events over the WebSocket
    # this opens below instead, so that verifier is never actually
    # exercised. slack_bolt's App still insists on a non-empty string here
    # regardless of mode, hence the placeholder.
    app = App(token=config.SLACK_BOT_TOKEN, signing_secret="unused-in-socket-mode")
    app.event("app_mention")(_handle_mention)
    log.info("mention listener starting (Socket Mode)")
    SocketModeHandler(app, config.SLACK_APP_TOKEN).start()
