const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const moment = require('moment-timezone');

const admin = require('firebase-admin');
const serviceAccount = require('./firebase-adminsdk.json'); // Firebase service account key

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Telegram bot config
const TOKEN = '7794762772:AAFlGE0u1eiAK1YAO5vvwk7jSVch4UhbFmE';
const bot = new TelegramBot(TOKEN, { polling: true });

const ADMIN_ID = 7981133656;  // Change to your Telegram ID or admin group chat
const ADMIN_IDS = [7981133656]; // Add all admins here

// User states for multi-step processes
const userStates = new Map();

// Bank/payment info for inline buttons
const bankDetails = {
  boc: `🏦 *Bank of Ceylon (BOC)*\n\n🔢 Account No: 6692413\n👤 Name: I P U KARUNARATHNE\n🏦 Branch: Pothuhera`,
  combank: `🏦 *Commercial Bank*\n\n🔢 Account No: 8020534130\n👤 Name: I M A KARUNARATHNE\n🏦 Branch: Polgahawela`,
  peoples: `🏦 *People's Bank*\n\n🔢 Account No: 280200100053713\n👤 Name: I P U KARUNARATHNE\n🏦 Branch: Pothuhera`,
  ezcash: `📱 *EZCash*\n\n📞 Mobile: 076-3083618\n👤 Name: SL CAT TEAM`,
  reload: `📲 *Dialog Reload*\n\n📞 Number: 074-0373416\n👤 Name: SL CAT TEAM`
};

// Util functions
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}
function isValidURL(url) {
  return typeof url === 'string' && (url.startsWith('vless://') || url.startsWith('vmess://'));
}
function encodeBase64(str) {
  return Buffer.from(str, 'utf-8').toString('base64');
}
function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
}

const configsDocRef = db.collection('vpn_configs').doc('vip_servers');

// Load configs from Firestore (parse from JSON string)
async function loadConfigs() {
  const doc = await configsDocRef.get();
  if (!doc.exists) return [];
  const data = doc.data();

  try {
    const jsonStr = data.config_list;
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Invalid JSON in config_list:", e);
    return [];
  }
}

// Save (add or update) single config into JSON string field
async function saveConfig(newConfig) {
  const doc = await configsDocRef.get();
  let configArray = [];

  if (doc.exists) {
    const data = doc.data();
    try {
      configArray = JSON.parse(data.config_list);
    } catch (e) {
      console.error("Failed to parse config_list as JSON:", e);
      configArray = [];
    }
  }

  // Always push the new config (even if same device_id)
  configArray.push(newConfig);

  const jsonStr = JSON.stringify(configArray, null, 2);
  await configsDocRef.set({ config_list: jsonStr }, { merge: true });
}



// Delete config by device_id
async function deleteConfig(deviceId) {
  const docRef = db.collection('vpn_configs').doc('vip_servers');
  const doc = await docRef.get();

  if (!doc.exists) return;

  const data = doc.data();
  let configs = data.config_list || [];

  // Remove the config with matching device_id
  configs = configs.filter(c => c.device_id !== deviceId);

  await docRef.set({ config_list: configs }, { merge: true });
}


// Load subscriptions
async function loadSubscriptions() {
  const snapshot = await subsCol.get();
  const subs = [];
  snapshot.forEach(doc => {
    subs.push(doc.data());
  });
  return subs;
}

// Save subscription (add or update)
async function saveSubscription(sub) {
  await subsCol.doc(sub.deviceId).set(sub);
}

// Delete subscription
async function deleteSubscription(deviceId) {
  await subsCol.doc(deviceId).delete();
}

// User deviceId tracker
const userDeviceMap = {};

// Telegram Bot Handlers

// Start command with optional device_id param
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const deviceId = match ? match[1] : 'undefined';
  userDeviceMap[chatId] = deviceId;

  const welcomeMsg = `
👋 <b>Welcome to <u>SL CAT Config Bot</u>!</b>

🔧 <b>Available Commands:</b>
➕ <code>/addconfig</code> — Add a new VPN config (Admins only)
📄 <code>/listconfigs</code> — View saved configs
🗑️ <code>/deleteconfig &lt;device_id&gt;</code> — Remove a config by device ID (Admins only)
🚀 VIP Subscriptions & Payment proof upload supported
  `;

  bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'HTML' });

  const packageMsg = `
💎 *SL CAT VPN - VIP Packages* 💎

🔹 1 Week - Rs. 100
🔹 1 Month - Rs. 200
🔹 3 Months - Rs. 400
🔹 1 Year - Rs. 800

📤 *Send your Payment Screenshot now* with your Device ID.

🆔 *Your Device ID:* \`${deviceId}\`

👇 *Choose your payment method:*
`;

  bot.sendMessage(chatId, packageMsg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "🏦 BOC", callback_data: "boc" }, { text: "🏦 Commercial", callback_data: "combank" }],
        [{ text: "🏦 People's", callback_data: "peoples" }, { text: "📱 EZCash", callback_data: "ezcash" }, { text: "📲 Reload", callback_data: "reload" }]
      ]
    }
  });
});

// Payment method button replies
bot.on('callback_query', query => {
  const chatId = query.message.chat.id;
  const method = query.data;
  const details = bankDetails[method];
  if (details) {
    bot.sendMessage(chatId, details, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, "❌ Invalid payment method.");
  }
  bot.answerCallbackQuery(query.id);
});

// /addconfig (Admin Only)
bot.onText(/\/addconfig/, (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '❌ Access denied. Admins only.');
  }
  userStates.set(msg.from.id, { step: 'awaiting_device_id' });
  bot.sendMessage(msg.chat.id, '📲 Please enter the <code>device_id</code> for this config:', { parse_mode: 'HTML' });
});

// /listconfigs
bot.onText(/\/listconfigs/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const configs = await loadConfigs();
    if (!configs.length) return bot.sendMessage(chatId, 'ℹ️ No configs available.');

    let message = '📄 <b>Saved VPN Configs</b>\n\n';
    configs.forEach((cfg, i) => {
      const decodedConfig = decodeBase64(cfg.config);
      message += `🔢 <b>#${i + 1}</b>\n🆔 <b>Device ID:</b> <code>${cfg.device_id}</code>\n📛 <b>Name:</b> ${cfg.name}\n🔗 <code>${decodedConfig}</code>\n\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    bot.sendMessage(chatId, '❌ Error loading configs.');
  }
});

// /deleteconfig (Admin only)
bot.onText(/\/deleteconfig (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '❌ Access denied. Admins only.');
  }
  const deviceId = match[1].trim();
  try {
    await deleteConfig(deviceId);
    bot.sendMessage(msg.chat.id, `✅ Deleted config with device_id: ${deviceId}`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Error deleting config: ${err.message}`);
  }
});

// Handle multi-step addconfig flow
bot.on('message', async (msg) => {
  const state = userStates.get(msg.from.id);
  if (!state || msg.text?.startsWith('/')) return;

  const chatId = msg.chat.id;

  try {
    switch (state.step) {
      case 'awaiting_device_id':
        state.device_id = msg.text.trim();
        state.step = 'awaiting_name';
        bot.sendMessage(chatId, '📛 Please enter a name for the config:');
        break;

      case 'awaiting_name':
        state.name = msg.text.trim();
        state.step = 'awaiting_config';
        bot.sendMessage(chatId, '🔗 Please enter the VLESS or VMESS config URL (must start with `vless://` or `vmess://`):');
        break;

      case 'awaiting_config':
        const configURL = msg.text.trim();
        if (!isValidURL(configURL)) {
          return bot.sendMessage(chatId, '❌ Invalid config. Must start with `vless://` or `vmess://`.');
        }
        const configs = await loadConfigs();

// Allow saving even if same device_id exists, but block exact config duplicates
const isAlreadyAdded = configs.some(c => c.device_id === state.device_id && c.config === encodeBase64(configURL));

if (isAlreadyAdded) {
  bot.sendMessage(chatId, '⚠️ This config already exists for that device.');
  userStates.delete(msg.from.id);
  return;
}

// Save to Firebase
await saveConfig({
  device_id: state.device_id,
  name: state.name,
  config: encodeBase64(configURL)
});

bot.sendMessage(chatId, `✅ Config saved for device_id: ${state.device_id}`);
userStates.delete(msg.from.id);
        break;

      // Add more states here if needed
    }
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    userStates.delete(msg.from.id);
  }
});

// Subscriptions handling

// /subscribe <plan>
bot.onText(/\/subscribe (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const plan = match[1].toLowerCase();
  const deviceId = userDeviceMap[chatId];

  if (!deviceId) {
    return bot.sendMessage(chatId, "❌ Please start the bot with your device ID first. Example: /start your_device_id");
  }

  const validPlans = ['1week', '1month', '3months', '1year'];
  if (!validPlans.includes(plan)) {
    return bot.sendMessage(chatId, "❌ Invalid plan. Valid plans: 1week, 1month, 3months, 1year");
  }

  const today = new Date().toISOString().split('T')[0];
  try {
    await saveSubscription({ userId, username, deviceId, plan, startDate: today });
    bot.sendMessage(chatId, `✅ Subscription for *${plan}* added successfully! Your Device ID: \`${deviceId}\``, { parse_mode: 'Markdown' });
    const userLink = username ? `[@${username}](https://t.me/${username})` : `[User](tg://user?id=${userId})`;
    bot.sendMessage(ADMIN_ID, `
📥 *New Subscription Added*

👤 User: [${msg.from.first_name}](tg://user?id=${msg.from.id})
🆔 Device ID: \`${deviceId}\`
📅 Plan: ${plan}
`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error saving subscription: ${err.message}`);
  }
});

// Cron job to check subscription expiry daily at midnight Colombo time
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily subscription expiry check...');
  const today = new Date();
  try {
    const subs = await loadSubscriptions();
    for (const sub of subs) {
      const startDate = new Date(sub.startDate);
      let durationDays = 0;
      switch (sub.plan) {
        case '1week': durationDays = 7; break;
        case '1month': durationDays = 30; break;
        case '3months': durationDays = 90; break;
        case '1year': durationDays = 365; break;
      }
      const expiryDate = new Date(startDate);
      expiryDate.setDate(expiryDate.getDate() + durationDays);

      if (today >= expiryDate) {
        const userLink = sub.username ? `[@${sub.username}](https://t.me/${sub.username})` : `[User](tg://user?id=${sub.userId})`;
        const message = `
🔔 *VIP Subscription Expired*

👤 User: ${userLink}
🆔 Device ID: \`${sub.deviceId}\`
📅 Plan: ${sub.plan}
📆 Expired On: ${expiryDate.toDateString()}

⚠️ Please remove this device ID from your system.
        `;
        await bot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' });
        // Optionally delete expired subscription:
        await deleteSubscription(sub.deviceId);
      }
    }
  } catch (err) {
    console.error('Subscription expiry check error:', err);
  }
}, { timezone: 'Asia/Colombo' });

// Payment proof handling
const userReplyMap = new Map(); // adminMsgId => userId
const adminReplyMap = new Map(); // userMsgId => adminMsgId

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const deviceId = userDeviceMap[chatId] || "Unknown";
  const caption = msg.caption || "No caption";
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  const forwardMessage = `
📩 *New VIP Payment Received!*

👤 *From:* [${msg.from.first_name}](tg://user?id=${msg.from.id})
🆔 *Device ID:* \`${deviceId}\`
📝 *Caption:* _${caption}_
  `;

  const sentMsg = await bot.sendPhoto(ADMIN_ID, fileId, {
    caption: forwardMessage,
    parse_mode: "Markdown"
  });

  userReplyMap.set(sentMsg.message_id, msg.from.id);
  adminReplyMap.set(msg.message_id, sentMsg.message_id);

  bot.sendMessage(chatId, "✅ *Screenshot received!* Please wait while the admin verifies it.", { parse_mode: "Markdown" });
});

// Admin and User reply handler
bot.on('message', async (msg) => {
  if (!msg.reply_to_message) return;

  const replyToMsgId = msg.reply_to_message.message_id;

  // Admin replies to user
  if (msg.chat.id === ADMIN_ID && userReplyMap.has(replyToMsgId)) {
    const userId = userReplyMap.get(replyToMsgId);
    const replyText = msg.text || "(No text)";
    const forwardReply = `💬 *Admin Response:*\n\n${replyText}`;
    const sent = await bot.sendMessage(userId, forwardReply, { parse_mode: "Markdown" });
    userReplyMap.set(sent.message_id, userId);
    adminReplyMap.set(sent.message_id, msg.message_id);
  }

  // User replies to admin
  if (adminReplyMap.has(replyToMsgId) && userReplyMap.has(replyToMsgId)) {
    const originalAdminMsgId = adminReplyMap.get(replyToMsgId);
    const userText = msg.text || "(No text)";
    const user = msg.from;
    const response = `👤 *Reply from:* [${user.first_name}](tg://user?id=${user.id})\n💬 _${userText}_`;
    const sent = await bot.sendMessage(ADMIN_ID, response, { parse_mode: "Markdown" });
    userReplyMap.set(sent.message_id, user.id);
    adminReplyMap.set(msg.message_id, sent.message_id);
  }
});
