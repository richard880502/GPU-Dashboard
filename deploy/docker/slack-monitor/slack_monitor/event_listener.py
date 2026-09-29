"""Two things a person can do by talking to the bot, both over the same
Socket Mode connection:

- @-mention it anywhere it's present: replies in-thread with a fresh
  snapshot. A manual "get me a current one right now" escape hatch, useful
  if a persistent dashboard message ever disappears (e.g. a workspace
  message-retention policy deleting it -- outside this service's control)
  before the next scheduled refresh would have noticed and re-bootstrapped it.

- DM it directly (anything at all): self-subscribes that person to their own
  persistent, auto-updating dashboard DM (see subscribers.py), the
  self-service alternative to being added to the static SLACK_DM_USER_ID
  list. DM "unsubscribe" (or "stop"/"取消"/"退訂") to stop.

Socket Mode is a persistent outbound WebSocket this process opens to Slack,
not the Events API's inbound webhook -- keeps this whole service's "only
ever connects outbound, nothing reaches in" property intact. Needs its own
app-level token (xapp-..., connections:write scope), plus the
app_mentions:read and im:history bot scopes (on top of chat:write/im:write),
and both app_mention and message.im subscribed under Event Subscriptions.

Entirely optional: if SLACK_APP_TOKEN isn't set, main.py never starts this,
and the rest of the service behaves exactly as it did before this existed.
"""

from __future__ import annotations

import logging

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from . import config, hub_client, renderer, slack_client, subscribers

log = logging.getLogger(__name__)

_UNSUBSCRIBE_WORDS = {"unsubscribe", "stop", "取消", "退訂"}


def _handle_mention(event: dict, say) -> None:
    try:
        servers = hub_client.fetch_cluster_status()
        blocks = renderer.render(servers)
        say(text="GPU cluster live status", blocks=blocks, thread_ts=event.get("ts"))
    except Exception:
        log.exception("failed to respond to mention")
        say(text="Couldn't fetch the current cluster status -- check the container logs.", thread_ts=event.get("ts"))


def _handle_message(event: dict, say) -> None:
    # Only genuine, plain human DMs subscribe/unsubscribe someone -- not
    # channel messages (message.im is the only message subtype this service
    # subscribes to, but check anyway rather than trust that), not this
    # bot's own messages (message.im events fire for parts of the
    # conversation, including our own text -- without this check, every DM
    # we send would immediately "subscribe" the bot to itself and loop), and
    # not edits/deletes/other subtypes, which carry no real "user said X" text.
    if event.get("channel_type") != "im" or event.get("bot_id") or event.get("subtype"):
        return
    user_id = event.get("user")
    if not user_id:
        return

    text = (event.get("text") or "").strip().lower()
    if text in _UNSUBSCRIBE_WORDS:
        removed = subscribers.remove(user_id)
        say(
            text="Unsubscribed -- I'll stop updating your dashboard message."
            if removed
            else "You weren't subscribed to begin with."
        )
        return

    newly_added = subscribers.add(user_id)
    if newly_added:
        say(text='Subscribed! Your live GPU cluster dashboard is on its way -- DM "unsubscribe" any time to stop.')

    # Publish right away rather than waiting for the next scheduled cycle to
    # notice this (new, or already-subscribed) target -- goes through the
    # exact same multi-target publish every other refresh does, so this
    # person's message bootstraps/updates exactly like any other target's.
    try:
        servers = hub_client.fetch_cluster_status()
        blocks = renderer.render(servers)
        slack_client.publish(blocks, fallback_text="GPU cluster live status")
    except Exception:
        log.exception("failed to publish after a DM from %s", user_id)


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
    app.event("message")(_handle_message)
    log.info("event listener starting (Socket Mode)")
    SocketModeHandler(app, config.SLACK_APP_TOKEN).start()
