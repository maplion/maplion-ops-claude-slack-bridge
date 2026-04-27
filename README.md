# maplion-ops-claude-slack-bridge

A long-lived local process that turns Slack into a remote control for Claude Code.

`@mention` the **Claude Code MCP** bot in a routed channel and the bridge spawns a
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) session
with `cwd` set to the org's local repo directory. Claude reads code, runs commands,
and replies in the thread.

## Architecture

```
Slack workspace ──Socket Mode──► bridge process
                                       │
                                       ▼
                  ┌────────────────────────────────────────┐
                  │  Map<thread_ts, ThreadSession>         │
                  │                                        │
                  │  thread T1: ┌──AsyncQueue──► Claude    │
                  │             │                  │       │
                  │             └──reply via Bolt◄─┘       │
                  │                                        │
                  │  thread T2: (independent session)      │
                  └────────────────────────────────────────┘
```

- **Single bot, single process** — one Slack app handles all GitHub orgs.
- **Channel-based routing** — [src/routes.ts](src/routes.ts) maps `channel_id → { cwd, label }`.
- **User allowlist** — only `ALLOWED_USERS` from `routes.ts` can invoke.
- **Session per thread, persistent across restarts** — first `@mention`
  opens a Claude Agent SDK session whose `prompt` is an
  [AsyncQueue](src/async-queue.ts). The SDK's `session_id` is captured and
  written to [~/Library/Application Support/maplion-ops-claude-slack-bridge/threads.json](src/session-store.ts).
  On the next reply (after idle pause OR bridge restart), the bridge calls
  `query({ options: { resume: sessionId } })` and the Claude Code CLI hydrates
  full conversation history from `~/.claude/projects/`.
- **Idle = pause, not end** — after 30 min of silence the in-memory session
  is interrupted but the store entry is kept. Next reply resumes seamlessly.
- **`AskUserQuestion` proxied** — the built-in tool stays disabled (would block
  forever in the SDK), but Claude is given an in-process MCP tool
  `mcp__slack-ux__slack_ask` that posts formatted questions to the Slack
  thread, pauses the turn, and resolves with the user's reply. This is what
  lets interactive GSD workflows (`gsd-discuss-phase`, `gsd-spec-phase`,
  `gsd-debug`, etc.) run end-to-end from Slack.
- **Slack MCP attached** — Claude can react with emoji, post mid-task progress,
  read channel history. Same docker-mcp gateway used by the in-CLI bridge.

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

Routed channels:
- `#kt-claude-chat` → `~/git/kupatikana`
- `#mp-claude-chat` → `~/git/my-pensieve`
- `#opt-claude-chat` → `~/git/onepointtwocapital`

`@mention` to start, reply in the thread to continue:

> **You:**  `@Claude Code MCP what's in package.json?`
> **Bot:**  *(replies in a new thread)*  The package.json shows a workspace…
> **You:**  *(reply in same thread, no @mention needed)*  add a `lint` script too
> **Bot:**  *(continues the same Claude session)*  Done — diff:

The session stays alive across replies. Idle for 30 min → it closes and the
next `@mention` starts fresh.

### Running GSD (and other multi-turn skills) from Slack

Because `AskUserQuestion` is disabled and the system prompt teaches Claude
to ask in plain text:

> **You:**  `@Claude Code MCP run /gsd-discuss-phase 5.3`
> **Bot:**  *(works for a bit, then…)*  I have 3 gray areas to discuss.
>          First: should the cache be in-memory or Redis-backed?
>          A) in-memory  B) Redis  C) start in-memory, migrate later
> **You:**  `B`
> **Bot:**  Got it. Next: TTL strategy …

Same flow works for `gsd-spec-phase`, `gsd-debug`, `gsd-plan-phase`, etc.

⚠️ Long-running phase execution (`gsd-execute-phase`, `gsd-autonomous`) will
run, but if anything errors mid-flight you may not see it until Claude
finishes the turn. Watch logs with `tail -f`.

### Session control commands

Type these as a regular thread message (no `@mention` needed):

| Command | Effect |
|---|---|
| `!clear` (also `!reset`, `!end`, `!new`) | Interrupts the live session, deletes the thread's store entry, and starts fresh on your next message. Use between GSD plan/execute phases per the GSD `/clear` discipline. |
| `!stop` | Cancels Claude's current turn (incl. running tool calls) but keeps the session and conversation history. Your next message continues where the conversation left off. Use when a long task is going off-track. |

Both also reject any pending `slack_ask` so Claude's tool call returns
an error result and the model can adapt.

Example GSD multi-phase flow:

> **You:**  `@Claude Code MCP /gsd-plan-phase 5.3`
> **Bot:**  *(plans phase, asks questions, finalizes plan)*
> **You:**  `!clear`
> **Bot:**  `:broom: Session cleared.`
> **You:**  `@Claude Code MCP /gsd-execute-phase 5.3`
> **Bot:**  *(executes with fresh context — no plan-phase clutter)*

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
| `IDLE_TIMEOUT_MIN` | `30` | Minutes of inactivity before a thread session is reaped |
| `BRIDGE_LOG_LEVEL` | `info` | `info` logs tool calls + results; `debug` adds 240-char result previews |

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
| Bot replies once but ignores my thread follow-ups | First reply must come from the bot; if you replied to your own message before the bot did, no thread exists yet. Wait for the bot's first reply, then continue the thread. |
| `:zzz: Session paused…` | Idle timeout fired. Just reply — the next message resumes. Set `IDLE_TIMEOUT_MIN` higher if 30 min is too short. |
| Bridge won't start: "Another bridge instance is running (pid=…)" | Stale lockfile or a real second instance. Check `ps -p <pid>`; if dead, remove `~/Library/Application Support/maplion-ops-claude-slack-bridge/bridge.lock`. |
| Resumed reply ignores prior context | The `~/.claude/projects/` history file may have been cleared. Run `!clear` and start fresh. |
| `Session error: session not found` | The session_id in `threads.json` no longer exists in `~/.claude/projects/` (e.g., manually deleted). The bridge auto-clears the ref; just send your message again. |

## Observability

`tail -f ~/Library/Logs/maplion-ops-claude-slack-bridge/out.log` shows a
live transcript of what Claude is doing in every thread:

```
14:32:01 [bridge] thread=1722... session start cwd=/Users/.../kupatikana
14:32:01 [bridge] thread=1722... session_id sid=abc123…
14:32:02 [bridge] thread=1722... tool Read(path=…/kt-mobile-ui/package.json)
14:32:02 [bridge] thread=1722... result 1247c
14:32:04 [bridge] thread=1722... tool Bash(cmd=git status -sb)
14:32:05 [bridge] thread=1722... result 89c
14:32:06 [bridge] thread=1722... tool mcp__slack-ux__slack_ask(question…)
14:32:06 [bridge] thread=1722... slack_ask waiting q="Which DB backend?"
14:33:11 [bridge] thread=1722... slack_ask resolved
14:33:14 [bridge] thread=1722... turn done cost=$0.0042 turns=2 dur=3100ms
```

Set `BRIDGE_LOG_LEVEL=debug` for tool-result previews.

## Roadmap

- [x] Persist sessions across bridge restarts (resume by `session_id`)
- [x] User commands for session lifecycle (`!clear`, `!reset`, `!end`, `!new`)
- [x] `!stop` — interrupt a running task without clearing the session
- [x] Tool-call structured logging
- [x] Slack MCP attached so Claude can post progress reactions / mid-flow messages
- [x] `AskUserQuestion` proxied via `slack_ask` in-process MCP
- [ ] Per-channel model override (heavyweight Opus on `#kt-claude-chat`,
      Haiku on a high-frequency channel)
- [ ] Streaming output — chunk long replies as they're produced rather than
      one big post per turn
- [ ] Plan mode (`EnterPlanMode`/`ExitPlanMode`) verification
- [ ] File/image upload from Slack into Claude (currently text-only)
