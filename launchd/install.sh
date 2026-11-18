#!/bin/sh
# Installs the hourly default model updater as a launchd agent for the current user.
set -e
dir=$(cd "$(dirname "$0")/.." && pwd)
label=dev.t3code.model-router
plist="$HOME/Library/LaunchAgents/$label.plist"
sed -e "s|__LABEL__|$label|" -e "s|__NODE__|$(command -v node)|" -e "s|__DIR__|$dir|g" \
	-e "s|__LOG__|$HOME/Library/Logs/t3-model-router.log|g" "$dir/launchd/model-router.plist" >"$plist"
launchctl unload "$plist" 2>/dev/null || true
launchctl load "$plist"
echo "Installed $plist"
