#!/usr/bin/env bash
# Stop and remove the launchd user agent.

set -euo pipefail

PLIST_NAME="com.maplion.claude-slack-bridge.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

launchctl bootout "gui/$(id -u)/com.maplion.claude-slack-bridge" 2>/dev/null || true
rm -f "$PLIST_DST"

echo "Uninstalled $PLIST_NAME"
