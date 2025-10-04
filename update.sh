#!/usr/bin/env bash
set -euo pipefail
APP_DIR="/opt/app-bot/testslcatbot"
cd "$APP_DIR"
git fetch --all --prune
git reset --hard origin/main
# re-install if package.json changed
if command -v pnpm >/dev/null 2>&1; then pnpm install --prod=false; else npm install --omit=dev; fi
pm2 reload ecosystem.config.js --update-env
echo "Updated & reloaded."
