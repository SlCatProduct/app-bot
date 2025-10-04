#!/usr/bin/env bash
set -euo pipefail

############################################
# SL CAT — app-bot (system + testslcatbot)
# Ubuntu 22.04/24.04 one-shot installer
############################################

# ---- Config you can tweak -----------------------------------------
REPO_URL="${REPO_URL:-https://github.com/SlCatProduct/app-bot.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"

APP_ROOT="${APP_ROOT:-/opt/app-bot}"
SYS_DIR="${SYS_DIR:-${APP_ROOT}/system}"
BOT_DIR="${BOT_DIR:-${APP_ROOT}/testslcatbot}"

SYS_PORT="${SYS_PORT:-3000}"
TIMEZONE_DEFAULT="${TIMEZONE_DEFAULT:-Asia/Colombo}"

# ---- Must be root --------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash install.sh"; exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# ---- Inputs --------------------------------------------------------
read -rp "Domain for web admin (e.g. free.slcatehiteam.shop): " APP_DOMAIN
APP_DOMAIN=${APP_DOMAIN:-free.slcatehiteam.shop}

read -rp "Server timezone [${TIMEZONE_DEFAULT}]: " TZ_INPUT
TZ_INPUT=${TZ_INPUT:-$TIMEZONE_DEFAULT}

read -rp "Enable HTTPS via Let's Encrypt? [y/N]: " ENABLE_SSL
ENABLE_SSL=${ENABLE_SSL:-N}

echo
echo "=== Telegram Bot ==="
read -rp "Telegram Bot Token: " TELEGRAM_BOT_TOKEN
if [[ -z "${TELEGRAM_BOT_TOKEN}" ]]; then echo "Bot token required"; exit 1; fi

read -rp "FREE_ADMINS CSV [6191785700,7981133656,7348879007]: " FREE_ADMINS_CSV
FREE_ADMINS_CSV=${FREE_ADMINS_CSV:-"6191785700,7981133656,7348879007"}

read -rp "VIP_ADMINS  CSV [7981133656]: " VIP_ADMINS_CSV
VIP_ADMINS_CSV=${VIP_ADMINS_CSV:-"7981133656"}

echo
echo "=== Firebase Service Account (Base64) ==="
echo "Paste single-line base64 of firebase-adminsdk.json (use: base64 -w0 file.json)"
read -rsp "FIREBASE_ADMIN_JSON_B64: " FIREBASE_ADMIN_JSON_B64
echo

read -rp "Admin username for /admin [admin]: " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}
read -rsp "Admin password for /admin [password123]: " ADMIN_PASS
ADMIN_PASS=${ADMIN_PASS:-password123}; echo

read -rp "Email for Let's Encrypt (if HTTPS=y) [admin@${APP_DOMAIN}]: " LE_EMAIL
LE_EMAIL=${LE_EMAIL:-"admin@${APP_DOMAIN}"}

echo
echo "==> Summary"
echo "Domain:        ${APP_DOMAIN}"
echo "Timezone:      ${TZ_INPUT}"
echo "HTTPS:         ${ENABLE_SSL}"
echo "Repo:          ${REPO_URL} (${REPO_BRANCH})"
echo "App root:      ${APP_ROOT}"
echo "System port:   ${SYS_PORT}"
echo

# ---- OS deps -------------------------------------------------------
apt-get update -y
apt-get upgrade -y
apt-get install -y git curl unzip ufw nginx ca-certificates gnupg

timedatectl set-timezone "${TZ_INPUT}" || true

# Node 20
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm i -g pm2@latest

# Firewall
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
yes | ufw enable || true

# ---- Clone or update repo -----------------------------------------
mkdir -p "${APP_ROOT}"
if [[ -d "${APP_ROOT}/.git" ]]; then
  echo "Repo exists → pulling latest..."
  git -C "${APP_ROOT}" fetch --all
  git -C "${APP_ROOT}" checkout "${REPO_BRANCH}"
  git -C "${APP_ROOT}" pull --ff-only origin "${REPO_BRANCH}"
else
  echo "Cloning repo..."
  git clone --branch "${REPO_BRANCH}" --depth 1 "${REPO_URL}" "${APP_ROOT}"
fi

# Validate subfolders
if [[ ! -d "${SYS_DIR}" ]] || [[ ! -d "${BOT_DIR}" ]]; then
  echo "Expected folders not found: ${SYS_DIR} and/or ${BOT_DIR}"
  exit 1
fi

# ---- Secrets & env -------------------------------------------------
# Firebase JSON next to bot.js
echo "${FIREBASE_ADMIN_JSON_B64}" | base64 -d > "${BOT_DIR}/firebase-adminsdk.json"
chmod 640 "${BOT_DIR}/firebase-adminsdk.json"; chown root:root "${BOT_DIR}/firebase-adminsdk.json"

# Bot .env
cat > "${BOT_DIR}/.env" <<EOF
NODE_ENV=production
TZ=${TZ_INPUT}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
FREE_ADMINS_CSV=${FREE_ADMINS_CSV}
VIP_ADMINS_CSV=${VIP_ADMINS_CSV}
EOF
chmod 640 "${BOT_DIR}/.env"

# System .env
SESSION_SECRET="$(openssl rand -hex 24)"
cat > "${SYS_DIR}/.env" <<EOF
NODE_ENV=production
TZ=${TZ_INPUT}
PORT=${SYS_PORT}
SESSION_SECRET=${SESSION_SECRET}
ADMIN_USERNAME=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASS}
EOF
chmod 640 "${SYS_DIR}/.env"

# ---- Install deps --------------------------------------------------
pushd "${BOT_DIR}" >/dev/null
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
popd >/dev/null

pushd "${SYS_DIR}" >/dev/null
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
popd >/dev/null

# ---- Decide entry points ------------------------------------------
# Adjust if your files are named differently
BOT_ENTRY="bot.js"
SYS_ENTRY="server.js"
[[ -f "${BOT_DIR}/${BOT_ENTRY}" ]] || { echo "Missing ${BOT_ENTRY} in ${BOT_DIR}"; exit 1; }
[[ -f "${SYS_DIR}/${SYS_ENTRY}" ]] || { echo "Missing ${SYS_ENTRY} in ${SYS_DIR}"; exit 1; }

# ---- PM2 config ----------------------------------------------------
cat > /opt/ecosystem.app-bot.cjs <<EOF
module.exports = {
  apps: [
    {
      name: "slcat-bot",
      cwd: "${BOT_DIR}",
      script: "${BOT_ENTRY}",
      env: {
        NODE_ENV: "production",
        TZ: "${TZ_INPUT}",
        TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN}",
        FREE_ADMINS_CSV: "${FREE_ADMINS_CSV}",
        VIP_ADMINS_CSV: "${VIP_ADMINS_CSV}"
      },
      autorestart: true,
      max_restarts: 20
    },
    {
      name: "slcat-system",
      cwd: "${SYS_DIR}",
      script: "${SYS_ENTRY}",
      env: {
        NODE_ENV: "production",
        TZ: "${TZ_INPUT}",
        PORT: "${SYS_PORT}"
      },
      autorestart: true,
      max_restarts: 20
    }
  ]
}
EOF

pm2 start /opt/ecosystem.app-bot.cjs
pm2 save
pm2 startup systemd -u $(whoami) --hp /root | bash || true

# ---- NGINX reverse proxy ------------------------------------------
SITE="/etc/nginx/sites-available/${APP_DOMAIN}.conf"
cat > "${SITE}" <<EOF
server {
  listen 80;
  server_name ${APP_DOMAIN};

  location / {
    proxy_pass         http://127.0.0.1:${SYS_PORT};
    proxy_http_version 1.1;
    proxy_set_header   Upgrade \$http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host \$host;
    proxy_set_header   X-Real-IP \$remote_addr;
    proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto \$scheme;
  }

  location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico)$ {
    expires 7d;
    access_log off;
    add_header Cache-Control "public, max-age=604800";
    try_files \$uri @node;
  }

  location @node { proxy_pass http://127.0.0.1:${SYS_PORT}; }
}
EOF

ln -sf "${SITE}" "/etc/nginx/sites-enabled/${APP_DOMAIN}.conf"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---- HTTPS ---------------------------------------------------------
if [[ "${ENABLE_SSL^^}" == "Y" ]]; then
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "${APP_DOMAIN}" --agree-tos -m "${LE_EMAIL}" --redirect -n
  systemctl reload nginx
fi

# ---- Done ----------------------------------------------------------
echo
echo "✅ Deployment complete."
echo "Repo root: ${APP_ROOT}"
echo "Bot:       ${BOT_DIR}  (pm2 app: slcat-bot)"
echo "System:    ${SYS_DIR}  (pm2 app: slcat-system)"
echo "Domain:    http://${APP_DOMAIN}/"
[[ "${ENABLE_SSL^^}" == "Y" ]] && echo "HTTPS:     https://${APP_DOMAIN}/"
echo
pm2 status
echo
echo "Useful:"
echo "  pm2 logs slcat-bot"
echo "  pm2 logs slcat-system"
echo "  pm2 restart slcat-bot && pm2 restart slcat-system"
