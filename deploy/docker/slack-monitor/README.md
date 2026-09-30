# slack-monitor

A live GPU cluster dashboard posted to Slack: one persistent message per
target (channel and/or DM), kept up to date in place via `chat.update`
instead of spamming a new message every refresh. Implements the design from
GitHub issue #2, with one deliberate deviation -- see
[Architecture](#architecture) below.

Entirely separate from the Beszel hub/agent (`deploy/beszel-fork`): its own
Dockerfile, its own compose file, its own image. A failure here can't affect
the main dashboard.

## What it does

- Posts a Block Kit **Carousel** with one **Card** per server: status,
  GPU model/count, a busy/idle activity label, a per-GPU utilization % and
  VRAM occupancy bar, temperature, the top GPU process (user + container),
  and CPU/RAM.
- A summary section on top: total GPUs, how many are busy, total VRAM used
  across the cluster, and how many servers are offline.
- Refreshes every 30s by default (`SLACK_REFRESH_INTERVAL_SECONDS`), editing
  the *same* message every time -- never a new one.
- Optionally (see [Interactive features](#interactive-features)):
  @-mention the bot anywhere for an on-demand fresh snapshot in-thread, or
  DM it directly to self-subscribe to your own persistent dashboard message.

## Architecture

Pulls all cluster data from **the Beszel hub's own API**
(`hub_client.py`), not by scraping each host's nvitop-exporter/
gpu-process-exporter directly the way issue #2 originally proposed. The hub
already merges per-GPU utilization/VRAM/temp/power *and* per-process
container attribution into `system_stats` -- host CPU/RAM/disk metrics used
to additionally need a separate `node-exporter` per host, but that was
removed (2026-09) once nothing was found to be scraping it anymore, since
beszel-agent already collects the same data natively. Going straight to the
hub turns "N hosts x 2-3 ports" into one dependency, and keeps this service
from re-deriving something Beszel already has.

Run this on the same host as the hub only (`wingene-76` in this cluster) --
it talks to the hub over `127.0.0.1`, same as any other client of the
dashboard.

## Setup

### 1. Create the Slack App

1. https://api.slack.com/apps -> **Create New App** -> **Blank app** (not
   "AI agent" or "Starter app" -- both pre-wire event listeners/Assistant
   API scaffolding this service doesn't use; a blank app keeps scope down
   to exactly what's needed).
2. Name it, pick your workspace.

### 2. Bot Token Scopes (OAuth & Permissions -> Scopes -> Bot Token Scopes)

| Scope | Needed for |
| --- | --- |
| `chat:write` | Posting/updating the dashboard message (always required) |
| `im:write` | DM targets (`SLACK_DM_USER_ID`) -- opens/reuses a DM via `conversations.open` |
| `app_mentions:read` | @-mention reply (optional feature) |
| `im:history` | DM self-subscribe/unsubscribe (optional feature) |

Add only what you're actually using. **Install to Workspace** (or
**Reinstall** if you add scopes later) after each change, and copy the **Bot
User OAuth Token** (`xoxb-...`).

### 3. App Home -- allow people to message the bot

Even with the right scopes, Slack blocks users from *sending* the bot a
message by default. Go to **App Home** and, under **Messages Tab**, check
**"Allow users to send Slash commands and messages from the messages tab"**.
Skipped, this shows up as "已關閉傳送訊息到此應用程式的功能" ("messaging to
this app is turned off") in the DM view with no compose box at all --
looks like a bug, isn't one.

### 4. Only if using @-mention or DM self-subscribe: Socket Mode

These two features run over Socket Mode (a persistent *outbound* WebSocket
this service opens to Slack), not the Events API's inbound webhook -- so
nothing needs to be publicly reachable, consistent with the rest of this
project's "outbound HTTPS only" design.

1. **Socket Mode** (left sidebar) -> enable it.
2. **Basic Information -> App-Level Tokens** -> generate one with the
   `connections:write` scope. Copy the `xapp-...` token -- this is
   `SLACK_APP_TOKEN`, a *different* token from the bot token above.
3. **Event Subscriptions** -> turn on -> **Subscribe to bot events** -> add:
   - `app_mention` for the @-mention reply
   - `message.im` for DM self-subscribe (not the broader `message.channels`
     -- that would also fire on ordinary channel chatter)
4. Reinstall the app if prompted.

### 5. Get target IDs

- **Channel ID**: right-click the channel -> View channel details -> ID at
  the bottom. Invite the bot to it first: `/invite @<app name>`.
- **User ID** (for a static DM target): click their profile -> **More** (
  the `...`/`:` menu) -> **Copy member ID**.

### 6. Deploy

```bash
cd deploy/standalone
cp .env.example .env
```

Fill in `.env`:

```env
USER_PASSWORD=<same value beszel-hub-compose.yml uses -- this service logs into the hub as that account>
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0123456789          # optional, comma-separated for more than one
SLACK_DM_USER_ID=U0123456789          # optional, comma-separated for more than one
SLACK_APP_TOKEN=xapp-...              # optional, only for @-mention/DM subscribe
```

At least one of `SLACK_CHANNEL_ID` / `SLACK_DM_USER_ID` is required; both
can be set together, and each gets its own independently maintained
persistent message.

```bash
docker compose -f slack-monitor-compose.yml up -d
docker logs -f gpu-slack-monitor   # confirm chat.postMessage then chat.update every cycle
```

## Interactive features

Both are entirely optional -- unset `SLACK_APP_TOKEN` and neither runs;
everything else behaves the same.

- **@-mention the bot** anywhere it's present: replies in-thread with a
  fresh snapshot. A manual "get me a current one right now" escape hatch --
  useful if a persistent message ever gets deleted by a workspace
  message-retention policy (outside this service's control) before the next
  scheduled refresh would have noticed and re-bootstrapped it.
- **DM the bot anything**: self-subscribes you to your own persistent
  dashboard message (the self-service alternative to being added to the
  static `SLACK_DM_USER_ID` list). DM `unsubscribe` (or `stop`/`取消`/`退訂`)
  to stop -- this only removes you from future refresh cycles; your last
  message is left as a frozen final snapshot, not deleted.

  Self-subscribers are stored in `subscribers.json` (in the same `/data`
  volume as `state.json`), merged with the static `SLACK_DM_USER_ID` list on
  every refresh cycle -- no restart needed for a new subscription to take
  effect.

## Configuration reference

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | -- | `xoxb-...` |
| `SLACK_CHANNEL_ID` | one of this/`SLACK_DM_USER_ID` | -- | comma-separated for more than one |
| `SLACK_DM_USER_ID` | one of this/`SLACK_CHANNEL_ID` | -- | comma-separated for more than one |
| `SLACK_APP_TOKEN` | no | -- | `xapp-...`, enables @-mention + DM subscribe |
| `SLACK_REFRESH_INTERVAL_SECONDS` | no | `30` | |
| `HUB_URL` | no | `http://127.0.0.1:13000` | |
| `HUB_EMAIL` / `HUB_PASSWORD` | yes | -- | same account as the hub's own `USER_EMAIL`/`USER_PASSWORD` |
| `DASHBOARD_URL` | no | `HUB_URL` | link target for each card's "Open details" button |
| `STATE_PATH` | no | `/data/state.json` | per-target bootstrap state (channel+ts) |
| `SUBSCRIBERS_PATH` | no | `/data/subscribers.json` | dynamic DM self-subscriber list |

## Troubleshooting

- **"messaging to this app is turned off" in the DM view, no compose box**:
  see [step 3](#3-app-home----allow-people-to-message-the-bot) above.
- **Mention/DM events never show up in the logs**: double check the Event
  Subscriptions are actually saved (not just the scopes -- these are two
  separate things in Slack's UI) and that you reinstalled the app after
  adding them.
- **`signing_secret must not be empty` crash on startup**: shouldn't happen
  (handled in `event_listener.py`), but if you're modifying that file,
  note `slack_bolt.App` requires a non-empty `signing_secret` even in pure
  Socket Mode, where it's never actually used (that verifier only guards
  inbound HTTP requests, which Socket Mode doesn't receive).
