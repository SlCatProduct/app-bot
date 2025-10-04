#!/usr/bin/env bash
set -euo pipefail

# -------- Config (can override via env/CLI) --------
APP_NAME="testslcatbot"
REPO_URL="https://github.com/SlCatProduct/app-bot.git"
REPO_SUBDIR="testslcatbot"
APP_DIR="/opt/app-bot/${REPO_SUBDIR}"
NODE_VERSION_LTS="18"                   # Ubuntu compatible LTS
SERVER_PORT="${SERVER_PORT:-3000}"      # server.js serves vip_configs.json on :3000

# Read key=value args
for arg in "$@"; do
  case "$arg" in
    *=*) export "$arg" ;;
    *) echo "Ignoring arg: $arg" ;;
  esac
done

# Required secrets (can be empty now; interactive prompt later)
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}"
FIREBASE_JSON_B64="${FIREBASE_JSON_B64:-}" # Optional if you scp the file

# -------- Helpers --------
log() { echo -e "\033[1;32m[+] $*\033[0m"; }
warn(){ echo -e "\033[1;33m[!] $*\033[0m"; }
err() { echo -e "\033[1;31m[!] $*\033[0m"; exit 1; }

require_root(){
  if [[ $EUID -ne 0 ]]; then
    err "Please run as root: sudo bash install.sh ..."
  fi
}

# -------- 0) Sanity / OS deps --------
require_root
export DEBIAN_FRONTEND=noninteractive

log "Updating apt & installing base tools..."
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw

# -------- 1) Install Node.js (LTS) + PM2 --------
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js ${NODE_VERSION_LTS}.x ..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION_LTS}.x | bash -
  apt-get install -y nodejs
fi

log "Node version: $(node -v)"
log "NPM version : $(npm -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing PM2..."
  npm i -g pm2
fi

# -------- 2) Fetch code --------
if [[ -d "$APP_DIR/.git" ]]; then
  log "Repo exists — pulling latest..."
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" reset --hard origin/main
else
  log "Cloning repo..."
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO_URL" "$(dirname "$APP_DIR")"
  # ensure we end up in the subdir
fi

cd "$APP_DIR"

# -------- 3) Install Node deps --------
log "Installing dependencies..."
# Prefer pnpm if present, else npm
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --prod=false
else
  npm install --omit=dev
fi

# -------- 4) Secrets / config files --------
# firebase-adminsdk.json (can come from B64 or existing file)
if [[ -n "$FIREBASE_JSON_B64" ]]; then
  log "Writing firebase-adminsdk.json from FIREBASE_JSON_B64 ..."
  echo "$FIREBASE_JSON_B64" | base64 -d > "$APP_DIR/firebase-adminsdk.json"
fi

if [[ ! -s "$APP_DIR/firebase-adminsdk.json" ]]; then
  warn "firebase-adminsdk.json missing in $APP_DIR."
  read -rp "Paste FIREBASE_JSON_B64 now (or leave empty if you already copied the file): " PASTE_B64 || true
  if [[ -n "${PASTE_B64:-}" ]]; then
    echo "$PASTE_B64" | base64 -d > "$APP_DIR/firebase-adminsdk.json"
  fi
fi

# .env for runtime variables
ENV_FILE="$APP_DIR/.env"
touch "$ENV_FILE"
grep -q '^TELEGRAM_TOKEN=' "$ENV_FILE" 2>/dev/null || {
  if [[ -z "$TELEGRAM_TOKEN" ]]; then
    read -rp "Enter TELEGRAM_TOKEN: " TELEGRAM_TOKEN
  fi
  echo "TELEGRAM_TOKEN=${TELEGRAM_TOKEN}" >> "$ENV_FILE"
}
grep -q '^SERVER_PORT=' "$ENV_FILE" 2>/dev/null || echo "SERVER_PORT=${SERVER_PORT}" >> "$ENV_FILE"

# -------- 5) Patch code for env usage (safe token handling) --------
# Replace any hardcoded TOKEN in bot*.js to use process.env.TELEGRAM_TOKEN
shopt -s nullglob
for f in "$APP_DIR"/bot*.js; do
  if grep -q "const TOKEN = '" "$f"; then
    log "Patching $f to use env TELEGRAM_TOKEN ..."
    sed -i "s/const TOKEN = .*/const TOKEN = process.env.TELEGRAM_TOKEN;/" "$f"
  fi
done

# -------- 6) Open firewall for server.js --------
log "Configuring UFW (allow 22, ${SERVER_PORT})..."
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow "${SERVER_PORT}/tcp" >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

# -------- 7) Create PM2 ecosystem & start --------
log "Creating PM2 processes (bot.js + server.js)..."
cat > "$APP_DIR/ecosystem.config.js" <<'EOF'
module.exports = {
  apps: [
    {
      name: "slcat-bot",
      script: "bot.js",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "slcat-server",
      script: "server.js",
      env: {
        NODE_ENV: "production",
        PORT: process.env.SERVER_PORT || 3000
      }
    }
  ]
}
EOF

# Export .env to both processes
export $(grep -v '^#' "$ENV_FILE" | xargs -d '\n' -I {} echo {})

pm2 start "$APP_DIR/ecosystem.config.js" --update-env
pm2 save
pm2 startup systemd -u "$(logname)" --hp "/home/$(logname)" >/dev/null 2>&1 || true

log "All set ✅"
echo
echo "Bot logs      : pm2 logs slcat-bot --lines 200"
echo "Server logs   : pm2 logs slcat-server --lines 200"
echo "Server URL    : http://<your-ip>:${SERVER_PORT}/vip_configs.json"
echo
echo "Update code   : sudo bash $APP_DIR/update.sh"
echo "Uninstall     : sudo bash $APP_DIR/uninstall.sh"
