# maplion-ops-claude-slack-bridge

A long-lived local process that turns Slack into a remote control for Claude Code.

`@mention` the **Claude Code MCP** bot in a routed channel and the bridge spawns a
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) session
with `cwd` set to the org's local repo directory. Claude reads code, runs commands,
and replies in the thread.

## Architecture

```
Slack workspace ──Socket Mode──► bridge process ──Claude Agent SDK──► Claude
                                       │                                  │
                                       └──reply via Bolt◄─────text────────┘
```

- **Single bot, single process** — one Slack app handles all GitHub orgs.
- **Channel-based routing** — `src/routes.ts` maps `channel_id → { cwd, label }`.
- **User allowlist** — only `ALLOWED_USERS` from `routes.ts` can invoke.
- **Stateless per turn** — each `@mention` re-fetches thread history and sends as prompt.

## Prerequisites

- Node.js ≥ 20
- Either:
  - **A Claude Pro/Max subscription** (the default — no API key needed; uses
    OAuth tokens at `~/.claude/` from `claude login`), **or**
  - **An Anthropic API key** (set `ANTHROPIC_API_KEY` for pay-as-you-go billing)
- A Slack app with the manifest in this repo's wiki/docs (Socket Mode on,
  `app_mention` + `message.im` events, scopes for `chat:write`, `channels:history`,
  `groups:history`, etc.)

### Auth: subscription vs API key

The bridge spawns the Claude Code CLI as a subprocess. That CLI reads
`ANTHROPIC_API_KEY` first; if unset, it falls back to OAuth credentials in
`~/.claude/.credentials.json` (created when you ran `claude login`).

| Mode | Cost | Caveats |
|---|---|---|
| **Subscription (no env var)** | Counts against your Pro/Max quota | Heavy bridge usage can exhaust your 5-hour windows, blocking interactive Claude Code use. Anthropic may rate-limit automated/agent-style use of subscription auth. |
| **API key (`ANTHROPIC_API_KEY` set)** | Per-token API billing | Independent of your subscription. Better for high-volume or long-running agents. |

To switch modes: set or unset `ANTHROPIC_API_KEY` in `.env` and restart the bridge.

> ⚠️ If `ANTHROPIC_API_KEY` is exported in `~/.zshrc`, the launchd wrapper will
> pick it up even if `.env` doesn't set it. To force subscription mode, either
> remove it from `~/.zshrc` or add `unset ANTHROPIC_API_KEY` to
> `scripts/launchd-run.sh` after the source line.

## Setup

```bash
git clone git@github.com:maplion/maplion-ops-claude-slack-bridge.git
cd maplion-ops-claude-slack-bridge
npm install
cp .env.example .env
# fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ANTHROPIC_API_KEY
```

## Run

```bash
npm run dev      # tsx watch (auto-reload)
npm run start    # one-shot
```

Logs `[bridge] running. model=…, channels=[…]` when ready.

## Run as a service (macOS / launchd)

For "always on, restart on crash, start at login":

```bash
./scripts/install-launchd.sh
```

This:
- copies [launchd/com.maplion.claude-slack-bridge.plist](launchd/com.maplion.claude-slack-bridge.plist) to `~/Library/LaunchAgents/`
- creates `~/Library/Logs/maplion-ops-claude-slack-bridge/{out,err}.log`
- bootstraps the agent into the GUI domain so it runs as your login user
- starts it immediately

**Manage it:**

```bash
# tail logs
tail -f ~/Library/Logs/maplion-ops-claude-slack-bridge/out.log \
        ~/Library/Logs/maplion-ops-claude-slack-bridge/err.log

# restart (e.g. after editing routes.ts)
launchctl kickstart -k gui/$(id -u)/com.maplion.claude-slack-bridge

# stop without uninstalling
launchctl disable gui/$(id -u)/com.maplion.claude-slack-bridge

# remove entirely
./scripts/uninstall-launchd.sh
```

**Why a wrapper script?** launchd processes don't inherit your interactive shell's
PATH, so `node`/`npm` aren't on $PATH unless we source `.zshrc`. The wrapper at
[scripts/launchd-run.sh](scripts/launchd-run.sh) handles that.

## Usage

In a routed channel (default: `#claude-chat`):

> `@Claude Code MCP what's in package.json?`

The bot replies in a thread. Continue the conversation by replying in the thread —
the bridge re-sends the full thread as context each turn.

## Adding a new org / channel

1. Create a private channel in Slack (e.g. `#pensieve-claude`).
2. Invite the bot: `/invite @Claude Code MCP`.
3. Get the channel ID: right-click channel → *View channel details* → copy ID.
4. Edit [src/routes.ts](src/routes.ts):
   ```ts
   "C…NEW_CHANNEL_ID": { cwd: "/Users/rozzum/git/my-pensieve", label: "my-pensieve" },
   ```
5. Restart the bridge.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | (required) | `xoxb-…` from OAuth & Permissions |
| `SLACK_APP_TOKEN` | (required) | `xapp-…` with `connections:write` |
| `ANTHROPIC_API_KEY` | optional | If unset, uses Claude subscription auth via `~/.claude/` |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Override to use Opus / Haiku |

## Security notes

- `permissionMode: "bypassPermissions"` is set so Claude can run tools unattended.
  Combined with `cwd` access, that's full read/write/shell on the routed repo
  directory. The user allowlist is the only access control.
- **Keep your Slack account secure** — anyone who can post as you can run code
  via this bridge.
- **Don't commit `.env`** — `.gitignore` covers it.
- The Slack bot token is also stored in macOS Keychain (via `docker mcp secret`)
  for the in-CLI Slack MCP server. Both copies are separate; rotating one does
  not rotate the other.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bridge starts but mentions are ignored | Channel not in `ROUTES`, or user not in `ALLOWED_USERS` |
| `Sorry, only the operator can invoke me here.` | Your Slack user ID isn't in `ALLOWED_USERS` |
| `not_in_channel` error | Bot isn't a member — `/invite @Claude Code MCP` |
| Connection drops repeatedly | Check `SLACK_APP_TOKEN` has `connections:write` scope |
| `not_authed` / `invalid_auth` | Bot token rotated — update `.env` |

## Roadmap

- [ ] Stream Claude's progress as edits to the placeholder (currently single update at end)
- [ ] Persist `session_id` per `thread_ts` for cheaper continuations
- [ ] Optional Slack MCP attach so Claude can post mid-thinking
- [ ] Per-channel model override
