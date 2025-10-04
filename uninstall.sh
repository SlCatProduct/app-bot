#!/usr/bin/env bash
set -euo pipefail
APP_DIR="/opt/app-bot/testslcatbot"
pm2 delete slcat-bot slcat-server || true
pm2 save || true
rm -rf "$APP_DIR"
echo "Removed $APP_DIR and PM2 apps."
