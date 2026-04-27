#!/usr/bin/env bash
# Install the bridge as a launchd user agent (starts on login, restarts on crash).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.maplion.claude-slack-bridge.plist"
PLIST_SRC="$REPO_DIR/launchd/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LOG_DIR="$HOME/Library/Logs/maplion-ops-claude-slack-bridge"

if [[ ! -f "$REPO_DIR/.env" ]]; then
  echo "ERROR: $REPO_DIR/.env not found. Copy .env.example and fill it in first."
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# Make scripts executable
chmod +x "$REPO_DIR/scripts/launchd-run.sh"

# Copy (don't symlink — launchd dislikes following links across reboots)
cp "$PLIST_SRC" "$PLIST_DST"

# Bootstrap into the per-user gui domain (modern launchctl)
launchctl bootout "gui/$(id -u)/com.maplion.claude-slack-bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable   "gui/$(id -u)/com.maplion.claude-slack-bridge"
launchctl kickstart -k "gui/$(id -u)/com.maplion.claude-slack-bridge"

echo "Installed $PLIST_NAME"
echo "  plist: $PLIST_DST"
echo "  logs:  $LOG_DIR/{out,err}.log"
echo
echo "Tail logs with: tail -f \"$LOG_DIR/out.log\" \"$LOG_DIR/err.log\""
