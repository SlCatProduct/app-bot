#!/usr/bin/env bash
set -euo pipefail

############################################################
# SL CAT — Telegram Bot + System Web Admin (Ubuntu 22.04/24.04)
# - Creates /opt/testslcatbot (Telegram bot)
# - Creates /opt/system       (Express + Socket.IO admin)
# - Installs Node.js 20, PM2, NGINX, UFW
# - Reverse proxy + optional Let's Encrypt
#
# Optional: You can provide ZIP URLs for your code to auto-deploy:
#   BOT_ZIP_URL= https://.../testslcatbot.zip   (contains bot.js + firebase-adminsdk.json or we will write firebase from B64)
#   SYS_ZIP_URL= https://.../system.zip         (contains your Express app, public/, views/, etc.)
#
# If not provided, minimal skeletons will be created (you can paste your code later).
############################################################

#--- Root check -----------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

#--- Inputs ---------------------------------------------------------
read -rp "Domain for web admin (e.g. free.slcatehiteam.shop): " APP_DOMAIN
APP_DOMAIN=${APP_DOMAIN:-free.slcatehiteam.shop}

read -rp "Your server timezone [Asia/Colombo]: " TZ_INPUT
TZ_INPUT=${TZ_INPUT:-Asia/Colombo}

read -rp "Enable HTTPS via Let's Encrypt? [y/N]: " ENABLE_SSL
ENABLE_SSL=${ENABLE_SSL:-N}

echo
echo "=== Telegram Bot Secrets ==="
read -rp "Telegram Bot Token (from BotFather): " TELEGRAM_BOT_TOKEN
if [[ -z "${TELEGRAM_BOT_TOKEN}" ]]; then
  echo "Telegram bot token is required."; exit 1
fi

read -rp "FREE_ADMINS CSV (e.g. 6191785700,7981133656,7348879007) [default]: " FREE_ADMIN_CSV
FREE_ADMIN_CSV=${FREE_ADMIN_CSV:-"6191785700,7981133656,7348879007"}

read -rp "VIP_ADMINS  CSV (e.g. 7981133656) [default]: " VIP_ADMIN_CSV
VIP_ADMIN_CSV=${VIP_ADMIN_CSV:-"7981133656"}

echo
echo "=== Firebase Admin Service Account ==="
echo "Paste your firebase-adminsdk.json as a SINGLE LINE BASE64 string."
echo "Tip: locally do  ->  base64 -w0 firebase-adminsdk.json"
read -rsp "FIREBASE_ADMIN_JSON_B64: " FIREBASE_ADMIN_JSON_B64
echo

echo
echo "=== (Optional) Code bundles ==="
echo "If you host your code as zips, the installer can pull them directly."
read -rp "BOT_ZIP_URL (empty to skip): " BOT_ZIP_URL
read -rp "SYS_ZIP_URL (empty to skip): " SYS_ZIP_URL

read -rp "Email for Let's Encrypt (used only if HTTPS=y): " LE_EMAIL
LE_EMAIL=${LE_EMAIL:-"admin@${APP_DOMAIN}"}

echo
echo "==> Summary:"
echo "  Domain:         ${APP_DOMAIN}"
echo "  Timezone:       ${TZ_INPUT}"
echo "  HTTPS:          ${ENABLE_SSL}"
echo "  FREE_ADMINS:    ${FREE_ADMIN_CSV}"
echo "  VIP_ADMINS:     ${VIP_ADMIN_CSV}"
echo "  BOT_ZIP_URL:    ${BOT_ZIP_URL:-<none>}"
echo "  SYS_ZIP_URL:    ${SYS_ZIP_URL:-<none>}"
echo

#--- System setup ---------------------------------------------------
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git unzip ufw nginx ca-certificates gnupg

timedatectl set-timezone "$TZ_INPUT" || true

# Node.js 20 (NodeSource)
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# PM2
npm i -g pm2@latest

# Firewall
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
yes | ufw enable || true

#--- Paths ----------------------------------------------------------
BOT_DIR=/opt/testslcatbot
SYS_DIR=/opt/system
SHARE_DIR=/opt/shared-secrets

mkdir -p "$BOT_DIR" "$SYS_DIR/public" "$SHARE_DIR"
chmod 750 "$SHARE_DIR"

#--- Write Firebase JSON next to bot.js -----------------------------
echo "$FIREBASE_ADMIN_JSON_B64" | base64 -d > "${BOT_DIR}/firebase-adminsdk.json"
chmod 640 "${BOT_DIR}/firebase-adminsdk.json"
chown root:root "${BOT_DIR}/firebase-adminsdk.json"

#--- .env files -----------------------------------------------------
cat >"${BOT_DIR}/.env" <<EOF
NODE_ENV=production
TZ=${TZ_INPUT}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
FREE_ADMINS_CSV=${FREE_ADMIN_CSV}
VIP_ADMINS_CSV=${VIP_ADMIN_CSV}
EOF

cat >"${SYS_DIR}/.env" <<EOF
NODE_ENV=production
TZ=${TZ_INPUT}
PORT=3000
SESSION_SECRET=$(openssl rand -hex 24)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=password123
EOF

chmod 640 "${BOT_DIR}/.env" "${SYS_DIR}/.env"

#--- Fetch or scaffold code -----------------------------------------
fetch_zip () {
  local url="$1" target="$2"
  tmpzip=$(mktemp /tmp/app.XXXX.zip)
  echo "Downloading $url ..."
  curl -fL "$url" -o "$tmpzip"
  echo "Unzipping into $target ..."
  # unzip preserving structure
  unzip -o "$tmpzip" -d "$target" >/dev/null
  rm -f "$tmpzip"
}

# (A) Telegram Bot
if [[ -n "${BOT_ZIP_URL}" ]]; then
  fetch_zip "${BOT_ZIP_URL}" "${BOT_DIR}"
else
  # Minimal skeleton + placeholder bot.js if zip not provided
  cat >"${BOT_DIR}/package.json" <<'EOF'
{
  "name": "slcat-telegram-bot",
  "version": "1.0.0",
  "main": "bot.js",
  "type": "commonjs",
  "license": "UNLICENSED",
  "dependencies": {
    "firebase-admin": "^12.7.0",
    "moment-timezone": "^0.5.45",
    "node-cron": "^3.0.3",
    "node-telegram-bot-api": "^0.65.1",
    "dotenv": "^16.4.5"
  }
}
EOF

  # NOTE: You can paste your full bot.js later; this is a compact loader that expects your logic file "bot.js".
  cat >"${BOT_DIR}/bot.js" <<'EOF'
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

const token = process.env.TELEGRAM_BOT_TOKEN || '';
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1);
}

const serviceKeyPath = path.join(__dirname, 'firebase-adminsdk.json');
if (!fs.existsSync(serviceKeyPath)) {
  console.error('firebase-adminsdk.json not found in bot dir'); process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(serviceKeyPath)) });
const db = admin.firestore();
const bot = new TelegramBot(token, { polling: true });

const FREE_ADMINS = (process.env.FREE_ADMINS_CSV || '').split(',').map(s => parseInt(s.trim(),10)).filter(Boolean);
const VIP_ADMINS  = (process.env.VIP_ADMINS_CSV  || '').split(',').map(s => parseInt(s.trim(),10)).filter(Boolean);
const ALL_ADMINS  = Array.from(new Set([...FREE_ADMINS, ...VIP_ADMINS]));

const userDeviceMap = {};

bot.onText(/\/start(?: (.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const deviceId = match ? match[1] : 'undefined';
  userDeviceMap[chatId] = deviceId;
  bot.sendMessage(chatId,
    `👋 <b>SL CAT Config Bot</b>\n\nYour Device ID: <code>${deviceId}</code>\nUse /addconfig, /listconfigs, /editconfig`,
    { parse_mode: 'HTML' }
  );
});

console.log('SL CAT Telegram bot started...');
EOF
fi

# (B) System Web Admin
if [[ -n "${SYS_ZIP_URL}" ]]; then
  fetch_zip "${SYS_ZIP_URL}" "${SYS_DIR}"
else
  # Minimal Express + Socket.IO scaffold (you can replace with your full code later)
  cat >"${SYS_DIR}/package.json" <<'EOF'
{
  "name": "slcat-system-admin",
  "version": "1.0.0",
  "main": "server.js",
  "type": "commonjs",
  "license": "UNLICENSED",
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-session": "^1.17.3",
    "http": "0.0.1-security",
    "socket.io": "^4.7.5",
    "path": "^0.12.7"
  }
}
EOF

  cat >"${SYS_DIR}/server.js" <<'EOF'
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
let activeUserCount = 0;
let users = [];

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: true
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', (req, res) => {
  const { username, password, confirmPassword } = req.body;
  if (password !== confirmPassword) return res.send('Passwords do not match!');
  if (users.find(u => u.username === username)) return res.send('Username already taken!');
  users.push({ username, password, role: 'user' });
  res.send('Registration successful! <a href="/login">Login here</a>');
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === adminUsername && password === adminPassword) {
    req.session.loggedIn = true; req.session.role = 'admin';
    return res.redirect('/admin');
  }
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.loggedIn = true; req.session.role = user.role;
    return res.redirect('/admin');
  }
  res.send('Invalid credentials');
});

app.get('/admin', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  if (req.session.role === 'admin') return res.sendFile(path.join(__dirname, 'public', 'admin_panel.html'));
  return res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'user_dashboard.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

io.on('connection', (socket) => {
  activeUserCount++;
  io.emit('user_count', activeUserCount);
  socket.on('send_system_info', (data) => console.log('System Info:', data));
  socket.on('disconnect', () => {
    activeUserCount--; io.emit('user_count', activeUserCount);
  });
});

server.listen(PORT, () => {
  console.log(`System admin running on http://localhost:${PORT}/login`);
});
EOF

  # Basic HTMLs
  mkdir -p "${SYS_DIR}/public"
  cat >"${SYS_DIR}/public/login.html" <<'EOF'
<!doctype html><html><body>
<h2>SL CAT Admin Login</h2>
<form method="post" action="/login">
  <input name="username" placeholder="username"><br>
  <input name="password" placeholder="password" type="password"><br>
  <button type="submit">Login</button>
</form>
<p><a href="/register">Register</a></p>
</body></html>
EOF

  cat >"${SYS_DIR}/public/register.html" <<'EOF'
<!doctype html><html><body>
<h2>Register</h2>
<form method="post" action="/register">
  <input name="username" placeholder="username"><br>
  <input name="password" placeholder="password" type="password"><br>
  <input name="confirmPassword" placeholder="confirm password" type="password"><br>
  <button type="submit">Register</button>
</form>
</body></html>
EOF

  cat >"${SYS_DIR}/public/admin_panel.html" <<'EOF'
<!doctype html><html><body>
<h2>Admin Panel</h2>
<div>Active users: <span id="count">0</span></div>
<a href="/logout">Logout</a>
<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
socket.on('user_count', c => document.getElementById('count').innerText = c);
</script>
</body></html>
EOF

  cat >"${SYS_DIR}/public/user_dashboard.html" <<'EOF'
<!doctype html><html><body>
<h2>User Dashboard</h2>
<p>Welcome!</p>
<a href="/logout">Logout</a>
</body></html>
EOF
fi

#--- Install dependencies -------------------------------------------
pushd "$BOT_DIR" >/dev/null
npm install --omit=dev
popd >/dev/null

pushd "$SYS_DIR" >/dev/null
npm install --omit=dev
popd >/dev/null

#--- PM2 ecosystem --------------------------------------------------
cat >/opt/ecosystem.config.cjs <<EOF
module.exports = {
  apps: [
    {
      name: "slcat-bot",
      cwd: "${BOT_DIR}",
      script: "bot.js",
      node_args: [],
      env: {
        NODE_ENV: "production",
        TZ: "${TZ_INPUT}",
        TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN}",
        FREE_ADMINS_CSV: "${FREE_ADMIN_CSV}",
        VIP_ADMINS_CSV: "${VIP_ADMIN_CSV}"
      },
      autorestart: true,
      max_restarts: 10
    },
    {
      name: "slcat-system",
      cwd: "${SYS_DIR}",
      script: "server.js",
      env: {
        NODE_ENV: "production",
        TZ: "${TZ_INPUT}",
        PORT: "3000"
      },
      autorestart: true,
      max_restarts: 10
    }
  ]
}
EOF

# Start & enable on boot
pm2 start /opt/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u $(whoami) --hp /root | bash || true

#--- NGINX reverse proxy --------------------------------------------
NGINX_SITE="/etc/nginx/sites-available/${APP_DOMAIN}.conf"

cat >"$NGINX_SITE" <<EOF
server {
  listen 80;
  server_name ${APP_DOMAIN};

  # Proxy to Node (system app on 3000)
  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade \$http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host \$host;
    proxy_set_header   X-Real-IP \$remote_addr;
    proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto \$scheme;
  }

  # Static cache hints
  location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico)$ {
    expires 7d;
    access_log off;
    add_header Cache-Control "public, max-age=604800";
    try_files \$uri @node;
  }

  location @node {
    proxy_pass http://127.0.0.1:3000;
  }
}
EOF

ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/${APP_DOMAIN}.conf"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

#--- HTTPS (optional) -----------------------------------------------
if [[ "${ENABLE_SSL^^}" == "Y" ]]; then
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "${APP_DOMAIN}" --agree-tos -m "${LE_EMAIL}" --redirect -n
  systemctl reload nginx
fi

#--- Final info -----------------------------------------------------
echo
echo "✅ Setup complete."
echo "Bot dir:     ${BOT_DIR}"
echo "System dir:  ${SYS_DIR}"
echo "Domain:      http://${APP_DOMAIN}/   (login page)"
if [[ "${ENABLE_SSL^^}" == "Y" ]]; then
  echo "HTTPS:       https://${APP_DOMAIN}/"
fi
echo
echo "PM2 status:"
pm2 status
echo
echo "Tips:"
echo "  • Update bot code:  cd ${BOT_DIR}  && nano bot.js && pm2 restart slcat-bot"
echo "  • Update system:    cd ${SYS_DIR}  && pm2 restart slcat-system"
echo "  • Logs:             pm2 logs slcat-bot  /  pm2 logs slcat-system"
