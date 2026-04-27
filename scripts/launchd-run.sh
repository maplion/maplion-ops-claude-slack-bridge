#!/usr/bin/env zsh
# Wrapper used by launchd to start the bridge with a real shell environment
# (PATH, nvm, etc.). launchd processes don't inherit your interactive shell's
# env, so without this you'd hit "command not found: node".

set -euo pipefail

# Source profile to populate PATH (nvm, asdf, brew, etc.)
[[ -f "$HOME/.zshrc" ]]    && source "$HOME/.zshrc"
[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"

# cd to repo root regardless of where launchd invokes the script
cd "${0:A:h}/.."

exec npm run start
