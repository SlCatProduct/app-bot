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

const FREE_ADMINS = [6191785700, 7981133656 ,7348879007];
const VIP_ADMINS = [7981133656];
const ALL_ADMINS = [7981133656, 1234567890]; // const ALL_ADMINS = [...new Set([...FREE_ADMINS, ...VIP_ADMINS])];

// User states for multi-step processes
const userStates = new Map();


// Bank/payment info for inline buttons
const bankDetails = {
  boc: `🏦 *Bank of Ceylon (BOC)*\n\n🔢 Account No: 6692413\n👤 Name: I P U KARUNARATHNE\n🏦 Branch: Pothuhera`,
  combank: `🏦 *Commercial Bank*\n\n🔢 Account No: 8020534130\n👤 Name: I M A KARUNARATHNE\n🏦 Branch: Polgahawela`,
  peoples: `🏦 *Commercial New Bank*\n\n🔢 Account No: 8027985799\n👤 Name: I P U KARUNARATHNE\n🏦 Branch: Polgahawela`,
  ezcash: `📱 *EZCash*\n\n📞 Mobile: 076-3083618\n👤 Name: SL CAT TEAM`,
  reload: `📲 *Dialog Reload*\n\n📞 Number: 074-0373416\n👤 Name: SL CAT TEAM`
};

const bankGifUrl = 'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExYWZiNTY1OTNicjJ1N2sxYmd0d3U4anQzeHlhNXIzbGpyYXlzNWY4biZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/afnsG6ooo0FwbUm5Tw/giphy.gif';

// === [ADD] Admin broadcast command ============================
async function sendInBatches(chatIds, makeText, batchSize = 25, delayMs = 120) {
  let sent = 0, failed = 0;
  for (let i = 0; i < chatIds.length; i += batchSize) {
    const batch = chatIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async (cid) => {
      try {
        await bot.sendMessage(cid, makeText(), { parse_mode: 'Markdown' });
        sent++;
      } catch (e) {
        failed++;
        console.error('broadcast send error ->', cid, e.message);
      }
    }));
    // small delay between batches to respect rate limits
    await new Promise(r => setTimeout(r, delayMs));
  }
  return { sent, failed };
}

// Usage: /admincast your message here
bot.onText(/\/admincast(?:\s+([\s\S]+))?/, async (msg, match) => {
  const fromId = msg.from.id;
  const chatId = msg.chat.id;

  // only admins allowed
  if (!isAllAdmin(fromId)) {
    return bot.sendMessage(chatId, '❌ Admin only.');
  }

  const text = (match && match[1]) ? match[1].trim() : '';
  if (!text) {
    return bot.sendMessage(chatId, 'Usage: `/admincast your message`', { parse_mode: 'Markdown' });
  }

  try {
    // load recipients from Firestore (exclude admins & bots)
    const snap = await usersCol.get();
    const all = [];
    snap.forEach(d => all.push(d.data()));
    const adminSet = new Set(ALL_ADMINS.map(String));
    const unique = new Map(); // dedupe by chatId
    all.forEach(u => {
      if (!u) return;
      if (u.is_bot) return;
      if (adminSet.has(String(u.chatId))) return;         // exclude admin chats
      if (adminSet.has(String(u.userId))) return;         // exclude admin users
      unique.set(String(u.chatId), u.chatId);
    });
    const recipients = Array.from(unique.values());

    if (!recipients.length) {
      return bot.sendMessage(chatId, 'ℹ️ No users to broadcast.');
    }

    await bot.sendMessage(chatId, `📢 Broadcasting to *${recipients.length}* users...`, { parse_mode: 'Markdown' });

    const header = `📢 *Admin Broadcast*\n\n`;
    const { sent, failed } = await sendInBatches(recipients, () => `${header}${text}`);

    await bot.sendMessage(chatId, `✅ Done.\nSent: *${sent}*\nFailed: *${failed}*`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('admincast error:', e);
    await bot.sendMessage(chatId, `❌ Broadcast error: ${e.message}`);
  }
});


// === [ADD] User registry (Firestore) ==========================
const usersCol = db.collection('bot_users');

async function upsertUserFromMsg(msg) {
  try {
    if (!msg || !msg.from || !msg.chat) return;
    const chatId = msg.chat.id;
    const from = msg.from;
    const deviceId = userDeviceMap[chatId] || null;

    // avoid saving admins if you want; here we save all and exclude on send
    const data = {
      userId: from.id,
      chatId: chatId,
      username: from.username || null,
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      is_bot: !!from.is_bot,
      deviceId: deviceId,
      lastSeen: new Date().toISOString()
    };
    await usersCol.doc(String(chatId)).set(data, { merge: true });
  } catch (e) {
    console.error('upsertUserFromMsg error:', e);
  }
}

// capture EVERY message/photo etc to keep registry fresh
bot.on('message', (msg) => { upsertUserFromMsg(msg); });
bot.on('photo',  (msg) => { upsertUserFromMsg(msg); });

// also when /start happens, we already update userDeviceMap; save right away too
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  try { await upsertUserFromMsg(msg); } catch (_) {}
});


async function sendBankDetails(chatId, bankKey) {
  const details = bankDetails[bankKey];
  if (!details) {
    await bot.sendMessage(chatId, '❌ Invalid bank/payment method.');
    return;
  }
  await bot.sendAnimation(chatId, bankGifUrl);
  await bot.sendMessage(chatId, details, { parse_mode: 'Markdown' });
}

// Util functions
function isValidURL(url) {
  return typeof url === 'string' && (url.startsWith('vless://') || url.startsWith('vmess://'));
}
function encodeBase64(str) {
  return Buffer.from(str, 'utf-8').toString('base64');
}
function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
}
function isVipAdmin(id) {
  return VIP_ADMINS.includes(id);
}
function isFreeAdmin(id) {
  return FREE_ADMINS.includes(id);
}
function isAllAdmin(id) {
  return ALL_ADMINS.includes(id);
}

// Firestore Refs
const freeConfigsDocRef = db.collection('vpn_configs').doc('free_servers');
const vipConfigsDocRef = db.collection('vpn_configs').doc('vip_servers');
const subsCol = db.collection('subscriptions');

// Load configs by doc ref
async function loadConfigs(ref) {
  const doc = await ref.get();
  if (!doc.exists) return [];
  try {
    const parsed = JSON.parse(doc.data().config_list);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Invalid JSON in config_list:", e);
    return [];
  }
}

// Save config by doc ref
async function saveConfig(ref, newConfig) {
  const existing = await loadConfigs(ref);
  const exists = existing.find(c => c.device_id === newConfig.device_id && newConfig.device_id);
  if (exists) return false;
  existing.push(newConfig);
  await ref.set({ config_list: JSON.stringify(existing, null, 2) }, { merge: true });
  return true;
}


// Delete config by device ID
async function deleteConfig(ref, deviceId) {
  const configs = await loadConfigs(ref);
  const filtered = configs.filter(c => c.device_id !== deviceId);
  await ref.set({ config_list: JSON.stringify(filtered, null, 2) }, { merge: true });
}

async function editConfig(ref, deviceId, newConfig) {
  const doc = await ref.get();
  if (!doc.exists) return false;
  let configs = [];
  try {
    configs = JSON.parse(doc.data().config_list);
  } catch (e) {
    console.error("Parse error:", e);
    return false;
  }
  const index = configs.findIndex(c => c.device_id === deviceId);
  if (index === -1) return false;
  configs[index] = newConfig;
  await ref.set({ config_list: JSON.stringify(configs, null, 2) }, { merge: true });
  return true;
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

async function sendConfigPage(chatId, type, page=0, pageSize=10){
  const ref = type==='vip' ? vipConfigsDocRef : freeConfigsDocRef;
  const list = await loadConfigs(ref);
  const start = page*pageSize;
  const slice = list.slice(start, start+pageSize);
  if (!slice.length) return bot.sendMessage(chatId, 'No more items.');

  let txt = `📄 ${type.toUpperCase()} Configs (page ${page+1})\n\n`;
  slice.forEach((c,i)=>{
    const line = type==='vip' ? decodeBase64(c.config) : c.config;
    txt += `#${start+i+1}\n${c.device_id?`🆔 ${c.device_id}\n`:''}📛 ${c.name}\n🔗 ${line}\n\n`;
  });
  const totalPages = Math.ceil(list.length/pageSize);
  const kb = [];
  if (page>0) kb.push({ text:'⬅️ Prev', callback_data:`pg_${type}_${page-1}` });
  if (page<totalPages-1) kb.push({ text:'Next ➡️', callback_data:`pg_${type}_${page+1}` });
  return bot.sendMessage(chatId, txt, { parse_mode:'HTML', reply_markup:{ inline_keyboard:[kb] }});
}

handlers['list_vip'] = async (q)=>{ await sendConfigPage(q.message.chat.id, 'vip', 0); await bot.answerCallbackQuery(q.id); };
handlers['list_free']= async (q)=>{ await sendConfigPage(q.message.chat.id, 'free',0); await bot.answerCallbackQuery(q.id); };
handlers['pg_vip_0']=handlers['pg_free_0']=()=>{};

bot.on('callback_query', async (q) => {
  try {
    // plan chooser
    if (q.data && q.data.startsWith('plan:')) {
      const [, deviceId, plan] = q.data.split(':'); // plan:njbjgh:1month
      const chatId   = q.message.chat.id;
      const userId   = q.from.id;
      const username = q.from.username || '';
      const today    = new Date().toISOString().slice(0,10);

      if (!['1week','1month','3months','1year'].includes(plan)) {
        await bot.answerCallbackQuery(q.id, { text: 'Invalid plan', show_alert: true });
        return;
      }

      await saveSubscription({ userId, username, deviceId, plan, startDate: today });

      await bot.answerCallbackQuery(q.id, { text: '✅ VIP activated' });
      await bot.sendMessage(
        chatId,
        `🎉 VIP *${plan}* activated for \`${deviceId}\`.\n`+
        `📅 Starts: *${today}*`,
        { parse_mode: 'Markdown' }
      );

      // (optional) notify admins
      for (const adminId of VIP_ADMINS) {
        await bot.sendMessage(
          adminId,
          `🆕 VIP Activated\n👤 User: ${username ? '@'+username : `tg://user?id=${userId}`}\n🆔 ${deviceId}\n📦 ${plan}\n📅 ${today}`,
          { disable_web_page_preview: true }
        );
      }
      return; // 🔚 stop here so other handlers don’t consume
    }

    // ...existing callback routing (list_vip, list_free, bank buttons, etc.)

  } catch (e) {
    console.error('plan callback error', e);
    try {
      await bot.answerCallbackQuery(q.id, { text: 'Error', show_alert: true });
    } catch (_) {}
  }
});


bot.on('callback_query', async (q)=>{ /* router above */ });
handlers.__pg = async (q)=>{
  const [,type,pageStr] = q.data.split('_'); 
  await sendConfigPage(q.message.chat.id, type, Number(pageStr));
  await bot.answerCallbackQuery(q.id);
};
// register pattern in router:
handlers['pg_vip_1']=handlers['pg_vip_2']=handlers['pg_free_1']=handlers['pg_free_2']=handlers.__pg;

// --- Helpers for plans & reminders ---------------------------------
function daysForPlan(plan){
  return ({ '1week':7, '1month':30, '3months':90, '1year':365 })[plan] || 0;
}
function isoYMD(d){ return d.toISOString().slice(0,10); }

// --- Reminder cron: DM users before expiry --------------------------
async function scheduleExpiryReminders(){
  try {
    const subs = await loadSubscriptions();
    const today = new Date();                   // server time
    const todayYMD = today.toISOString().slice(0,10);

    for (const s of subs){
      // basic validation
      if (!s.startDate || !s.plan || !s.userId || !s.deviceId) continue;

      const start = new Date(s.startDate);
      const exp = new Date(start);
      exp.setDate(exp.getDate() + daysForPlan(s.plan));

      // difference in whole days (ceil so partial day counts forward)
      const diffDays = Math.ceil((exp - today)/86400000);

      // We only care about 3,1,0 days remaining (0 = expires today)
      if (![3,1,0].includes(diffDays)) continue;

      // avoid duplicate notifications: store flags on the sub doc
      const already = (s.reminders && s.reminders[String(diffDays)]) || false;
      if (already) continue;

      const msg = diffDays === 0
        ? `⏰ *Final Notice*: Your VIP plan *(${s.plan})* expires *today*.\n🆔 Device: \`${s.deviceId}\`\n\nPlease renew to avoid interruption.`
        : `⏰ Reminder: Your VIP plan *(${s.plan})* expires in *${diffDays} day(s)*.\n🆔 Device: \`${s.deviceId}\`\n\nRenew now to stay connected.`;

      try {
        await bot.sendMessage(s.userId, msg, { parse_mode: 'Markdown' });
        // mark this reminder as sent
        await subsCol.doc(s.deviceId).set({
          reminders: { ...(s.reminders||{}), [String(diffDays)]: true },
          lastReminderAt: todayYMD
        }, { merge: true });
      } catch (e) {
        console.error('reminder DM failed', s.userId, e.message);
      }
    }
  } catch (e) {
    console.error('scheduleExpiryReminders error', e);
  }
}

// run daily at 09:15 Colombo time
cron.schedule('15 9 * * *', scheduleExpiryReminders, { timezone: 'Asia/Colombo' });
// --- Expiry sweep: notify admins + delete expired late night --------
cron.schedule('55 23 * * *', async () => {
  console.log('Running nightly subscription expiry sweep...');
  const today = new Date();
  try {
    const subs = await loadSubscriptions();
    for (const sub of subs) {
      if (!sub.startDate || !sub.plan) continue;
      const startDate = new Date(sub.startDate);
      const expiryDate = new Date(startDate);
      expiryDate.setDate(expiryDate.getDate() + daysForPlan(sub.plan));

      if (today >= expiryDate) {
        const userLink = sub.username
          ? `[@${sub.username}](https://t.me/${sub.username})`
          : `[User](tg://user?id=${sub.userId})`;
        const message = `
🔔 *VIP Subscription Expired*

👤 User: ${userLink}
🆔 Device ID: \`${sub.deviceId}\`
📅 Plan: ${sub.plan}
📆 Expired On: ${expiryDate.toDateString()}

⚠️ Please remove this device ID from your system.
        `;
        // NOTE: Telegram API doesn't accept arrays for chatId; loop if needed
        try {
          // If ALL_ADMINS is an array, send to each admin:
          if (Array.isArray(ALL_ADMINS)) {
            for (const adminId of ALL_ADMINS) {
              await bot.sendMessage(adminId, message, { parse_mode: 'Markdown' });
            }
          } else {
            await bot.sendMessage(ALL_ADMINS, message, { parse_mode: 'Markdown' });
          }
        } catch (e) { console.error('admin notify failed', e.message); }

        // delete the expired subscription
        await deleteSubscription(sub.deviceId);
      }
    }
  } catch (err) {
    console.error('Subscription expiry sweep error:', err);
  }
}, { timezone: 'Asia/Colombo' });


// Save subscription (add or update)
async function saveSubscription(sub) {
  const start = sub.startDate ? new Date(sub.startDate) : new Date();
  const days  = daysForPlan(sub.plan);
  const exp   = new Date(start); exp.setDate(exp.getDate()+days);

  await subsCol.doc(sub.deviceId).set({
    userId: sub.userId,
    username: sub.username || '',
    deviceId: sub.deviceId,
    plan: sub.plan,
    startDate: isoYMD(start),
    expiresAt: isoYMD(exp),
    status: 'active'
  }, { merge: true });
}


// nightly expiry sweep: status flip (keep your admin notices)
cron.schedule('55 23 * * *', async () => {
  const todayYMD = isoYMD(new Date());
  const subs = await loadSubscriptions();
  for (const s of subs){
    if (!s.expiresAt) continue;
    if (todayYMD >= s.expiresAt && s.status !== 'expired') {
      await subsCol.doc(s.deviceId).set({ status: 'expired' }, { merge: true });

      // (optional) remove VIP config for that device ID
      // await deleteConfig(vipConfigsDocRef, s.deviceId);
    }
  }
}, { timezone: 'Asia/Colombo' });
// Delete subscription
async function deleteSubscription(deviceId) {
  await subsCol.doc(deviceId).delete();
}

// User deviceId tracker
const userDeviceMap = {};

// Telegram Bot Handlers
bot.onText(/\/whenexpire/, async (msg)=>{
  const chatId = msg.chat.id;
  const deviceId = userDeviceMap[chatId];
  if (!deviceId) return bot.sendMessage(chatId, '❌ Device ID not set. Use `/start <device_id>`');
  const d = await subsCol.doc(deviceId).get();
  if (!d.exists) return bot.sendMessage(chatId, 'ℹ️ No active subscription found.');

  const s = d.data();
  const start = new Date(s.startDate);
  const exp = new Date(start); exp.setDate(exp.getDate() + daysForPlan(s.plan));
  const left = Math.max(0, Math.ceil((exp - new Date())/86400000));
  return bot.sendMessage(chatId,
    `🧾 Plan: *${s.plan}*\n🗓️ Start: *${s.startDate}*\n⏳ Days left: *${left}*\n📆 Expires: *${exp.toDateString()}*`,
    { parse_mode: 'Markdown' });
});

// Start command with optional device_id param
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const deviceId = match ? match[1] : 'undefined';
  userDeviceMap[chatId] = deviceId;
  

  const welcomeMsg = `
👋 <b>Welcome to <u>SL CAT Config Bot</u>!</b>

🔧 <b>Available Commands:</b>
➕ <code>/addconfig</code> — Add a new VPN config (choose VIP or Free)
📄 <code>/listconfigs</code> — List VPN configs (choose VIP or Free)
🗑️ <code>/deleteconfig &lt;vip|free&gt; &lt;device_id|name&gt;</code> — Delete config by type and identifier (Admins only)
✏️ <code>/editconfig</code> — Edit VPN config (choose VIP or Free, then enter device ID or name)

🚀 VIP subscriptions & payment proof upload supported.
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
        [{ text: "🏦 Commercial New", callback_data: "peoples" }, { text: "📱 EZCash", callback_data: "ezcash" }, { text: "📲 Reload", callback_data: "reload" }]
      ]
    }
  });
});

bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const method = query.data;

    console.log(`User ${query.from.id} selected payment method: ${method}`);

    if (!bankDetails.hasOwnProperty(method)) {
      await bot.sendMessage(chatId, "❌ Invalid payment method selected.");
      return await bot.answerCallbackQuery(query.id, { text: 'Invalid payment method', show_alert: true });
    }

    // Send animation first
    await bot.sendAnimation(chatId, bankGifUrl);

    // Then send payment details message
    await bot.sendMessage(chatId, bankDetails[method], { parse_mode: 'Markdown' });

    await bot.answerCallbackQuery(query.id);

  } catch (error) {
    console.error('Error handling payment method callback:', error);
    try {
      await bot.sendMessage(query.message.chat.id, '⚠️ Sorry, something went wrong. Please try again later.');
      await bot.answerCallbackQuery(query.id, { text: 'Error occurred', show_alert: true });
    } catch (_) {}
  }
});


bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === 'reload') {
    const msg = `
💡 *🔔 Reload Payment Notice 🔔*

─────────────────────────────

⚠️ *Reload Payment Method* භාවිතයෙනුත් VIP subscription මිලට වඩා  
*Rs. 100* ක *අමතර ගාස්තුවක්* අය කෙරේ.

🔹 SL CAT VPN - VIP Packages මිලට වඩා  
  _Rs. 100_ ගාස්තුවක් ලබා දිය යුතුයි.

➤ කරුණාකර ඔබගේ *Payment Screenshot* සහ *Device ID*  
  _නිවැරදිව_ අප වෙත එවන්න.

─────────────────────────────

📞 ගෙවීම් සම්බන්ධයෙන් වැඩි විස්තර අවශ්‍ය නම්  
අප හා සම්බන්ධ වන්න.

─────────────────────────────

🎉✨🛡️ *Thank you for supporting SL CAT VPN!*
`;

    // Send the formatted message
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

    // Send an animated sticker (replace with your own sticker file_id)
    const stickerFileId = 'CAACAgIAAxkBAAEBR4VhD0_4IUorwMjEY-3zRynWqPtNdAACVQIAAk5i9AtQKszdB92AxCME';
    await bot.sendSticker(chatId, stickerFileId);

    return bot.answerCallbackQuery(query.id);
  }

  // ... other callback handlers
});





// /addconfig command with button selection
bot.onText(/\/addconfig/, (msg) => {
  const userId = msg.from.id;
  if (!isFreeAdmin(userId) && !isVipAdmin(userId)) return bot.sendMessage(msg.chat.id, '❌ You are not allowed to add configs.');

  const chatId = msg.chat.id;
  userStates.set(msg.from.id, { step: 'await_type' });
  bot.sendMessage(chatId, '📦 Choose config type to add:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💎 VIP Config', callback_data: 'add_vip' }],
        [{ text: '🌐 Free Config', callback_data: 'add_free' }]
      ]
    }
  });
});

bot.on('callback_query', (query) => {
  const userId = query.from.id;
  const data = query.data;
  const state = userStates.get(userId) || {};

  // ✅ Permission checks
  if (data === 'add_vip' && !isVipAdmin(userId)) {
    return bot.answerCallbackQuery(query.id, { text: '❌ VIP config access denied.', show_alert: true });
  }
  if (data === 'add_free' && !isFreeAdmin(userId)) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Free config access denied.', show_alert: true });
  }

  if (data === 'add_vip' || data === 'add_free') {
    state.type = data === 'add_vip' ? 'vip' : 'free';
    state.step = 'await_device_id';
    userStates.set(userId, state);
    bot.sendMessage(query.message.chat.id, '📲 Enter device ID:');
    return bot.answerCallbackQuery(query.id);
  }
});



bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith('/')) return;

  const state = userStates.get(userId);
  if (!state) return;

  if (state.step === 'await_device_id') {
    state.device_id = msg.text.trim();
    state.step = 'await_name';
    bot.sendMessage(chatId, '📛 Enter config name:');
    return;
  }

  if (state.step === 'await_name') {
    state.name = msg.text.trim();
    state.step = 'await_config';
    bot.sendMessage(chatId, '🔗 Send config URL (must start with vless:// or vmess://):');
    return;
  }

  if (state.step === 'await_config') {
    const url = msg.text.trim();
    if (!isValidURL(url)) {
      bot.sendMessage(chatId, '❌ Invalid config URL. Must start with vless:// or vmess://');
      return;
    }

     const ref = state.type === 'vip' ? vipConfigsDocRef : freeConfigsDocRef;
  const configs = await loadConfigs(ref);
  const configEncoded = state.type === 'vip' ? encodeBase64(url) : url;

  const isAlreadyAdded = configs.some(c => c.device_id === state.device_id && c.config === configEncoded);
  if (isAlreadyAdded) {
    bot.sendMessage(chatId, '⚠️ This config already exists for that device.');
    userStates.delete(userId);
    return;
  }

    // ✅ Push new config
     configs.push({ device_id: state.device_id, name: state.name, config: configEncoded });
  await ref.set({ config_list: JSON.stringify(configs, null, 2) }, { merge: true });

 // ✅ HERE: if VIP, immediately show plan selector
  if (state.type === 'vip') {
    await bot.sendMessage(chatId,
      `✅ VIP config saved for \`${state.device_id}\`.\n\n🧾 Now choose the package:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: "1 Week",   callback_data: `plan:${state.device_id}:1week`  },
              { text: "1 Month",  callback_data: `plan:${state.device_id}:1month` }
            ],
            [
              { text: "3 Months", callback_data: `plan:${state.device_id}:3months`},
              { text: "1 Year",   callback_data: `plan:${state.device_id}:1year`  }
            ]
          ]
        }
      }
    );
  } else {
    await bot.sendMessage(chatId, '✅ Free config saved.');
  }

    
    userStates.delete(userId);
    return;
  }
});


// /listconfigs command
bot.onText(/\/listconfigs/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAllAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Admin access only');
  }

  bot.sendMessage(chatId, '📂 Choose config type to list:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💎 VIP', callback_data: 'list_vip' }],
        [{ text: '🌐 Free', callback_data: 'list_free' }]
      ]
    }
  });
});

// callback_query handler with permission checks
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const data = query.data;

  // VIP List permission check
  if (data === 'list_vip' && !isVipAdmin(userId)) {
    return bot.answerCallbackQuery(query.id, {
      text: '❌ You are not allowed to view VIP configs.',
      show_alert: true
    });
  }

  // Free List permission check
  if (data === 'list_free' && !isFreeAdmin(userId)) {
    return bot.answerCallbackQuery(query.id, {
      text: '❌ You are not allowed to view Free configs.',
      show_alert: true
    });
  }

  // Continue only if starts with 'list_'
  if (data.startsWith('list_')) {
    const ref = data === 'list_vip' ? vipConfigsDocRef : freeConfigsDocRef;
    const configs = await loadConfigs(ref);
    if (!configs.length) {
      await bot.sendMessage(chatId, 'ℹ️ No configs found.');
      return bot.answerCallbackQuery(query.id);
    }

    let msgList = `📄 ${data === 'list_vip' ? 'VIP' : 'Free'} Configs\n\n`;
    configs.forEach((c, i) => {
      msgList += `🔢 #${i + 1}\n`;
      msgList += c.device_id ? `🆔 Device ID: <code>${c.device_id}</code>\n` : '';
      msgList += `📛 Name: ${c.name}\n`;
      msgList += `🔗 ${data === 'list_vip' ? decodeBase64(c.config) : c.config}\n\n`;
    });

    await bot.sendMessage(chatId, msgList, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }
});


// Start edit flow: ask to choose vip or free
bot.onText(/\/editconfig/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(msg.from.id, { step: 'edit_await_type' });
  bot.sendMessage(chatId, '✏️ Choose config type to edit:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💎 VIP Config', callback_data: 'edit_vip' }],
        [{ text: '🌐 Free Config', callback_data: 'edit_free' }]
      ]
    }
  });
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates.get(userId) || {};

  if (data === 'edit_vip') {
    if (!isVipAdmin(userId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '❌ VIP config edit access denied.',
        show_alert: true
      });
    }

    state.type = 'vip';
    state.step = 'edit_await_device_id';
    userStates.set(userId, state);
    await bot.sendMessage(chatId, '📲 Enter the Device ID of the config to edit:');
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'edit_free') {
    if (!isFreeAdmin(userId)) {
      return bot.answerCallbackQuery(query.id, {
        text: '❌ Free config edit access denied.',
        show_alert: true
      });
    }

    state.type = 'free';
    state.step = 'edit_await_name';
    userStates.set(userId, state);
    await bot.sendMessage(chatId, '📛 Enter the Name of the config to edit:');
    return bot.answerCallbackQuery(query.id);
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (!msg.text || msg.text.startsWith('/')) return;
  const state = userStates.get(userId);
  if (!state) return;

  const ref = state.type === 'vip' ? vipConfigsDocRef : freeConfigsDocRef;
  const configs = await loadConfigs(ref);

  if (state.step === 'edit_await_device_id' || state.step === 'edit_await_name') {
    const key = msg.text.trim();
    const cfg = state.type === 'vip' 
      ? configs.find(c => c.device_id === key) 
      : configs.find(c => c.name === key);

    if (!cfg) {
      bot.sendMessage(chatId, '❌ Config not found. Please enter a valid identifier:');
      return;
    }
    state.old_config = cfg.config;
    state.name = cfg.name;
    state.device_id = cfg.device_id || '';
    state.step = 'edit_await_new_name';
    userStates.set(userId, state);

    let idText = state.type === 'vip' ? `Device ID: ${state.device_id}` : `Name: ${state.name}`;
    bot.sendMessage(chatId, `✏️ Editing config (${idText})\nCurrent Config: ${decodeBase64(cfg.config)}\n\nEnter new name (or send same to keep):`);
    return;
  }

  if (state.step === 'edit_await_new_name') {
    state.name = msg.text.trim();
    state.step = 'edit_await_new_config';
    userStates.set(userId, state);
    bot.sendMessage(chatId, '🔗 Enter new config URL (must start with vless:// or vmess://):');
    return;
  }

  if (state.step === 'edit_await_new_config') {
    const url = msg.text.trim();
    if (!isValidURL(url)) {
      bot.sendMessage(chatId, '❌ Invalid config URL. Must start with vless:// or vmess://');
      return;
    }

    // Update config array
    const idx = state.type === 'vip'
      ? configs.findIndex(c => c.device_id === state.device_id)
      : configs.findIndex(c => c.name === state.name);

    if (idx === -1) {
      bot.sendMessage(chatId, '❌ Config to update not found.');
      userStates.delete(userId);
      return;
    }

    configs[idx] = {
      device_id: state.type === 'vip' ? state.device_id : '',
      name: state.name,
      config: encodeBase64(url)
    };

    const success = await saveAllConfigs(ref, configs);
    if (success) bot.sendMessage(chatId, `✅ Config updated for ${state.type === 'vip' ? 'device ID' : 'name'}: ${state.type === 'vip' ? state.device_id : state.name}`);
    else bot.sendMessage(chatId, '❌ Failed to update config.');

    userStates.delete(userId);
  }
});

bot.onText(/\/deleteconfig (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const key = match[1].trim();

  // Try delete from VIP first
  let configs = await loadConfigs(vipConfigsDocRef);
  let idx = configs.findIndex(c => c.device_id === key);

  if (idx !== -1) {
    if (!isVipAdmin(userId)) {
      return bot.sendMessage(chatId, '❌ You are not allowed to delete VIP configs.');
    }
    configs.splice(idx, 1);
    await saveAllConfigs(vipConfigsDocRef, configs);
    return bot.sendMessage(chatId, `✅ VIP Config with device ID "${key}" deleted.`);
  }

  // Try delete from Free by name
  configs = await loadConfigs(freeConfigsDocRef);
  idx = configs.findIndex(c => c.name === key);

  if (idx !== -1) {
    if (!isFreeAdmin(userId)) {
      return bot.sendMessage(chatId, '❌ You are not allowed to delete Free configs.');
    }
    configs.splice(idx, 1);
    await saveAllConfigs(freeConfigsDocRef, configs);
    return bot.sendMessage(chatId, `✅ Free Config with name "${key}" deleted.`);
  }

  return bot.sendMessage(chatId, '❌ Config not found.');
});



// Save to Firebase




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
    bot.sendMessage(ALL_ADMINS, `
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
        await bot.sendMessage(ALL_ADMINS, message, { parse_mode: 'Markdown' });
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

  for (const adminId of VIP_ADMINS) {
    const sentMsg = await bot.sendPhoto(adminId, fileId, {
      caption: forwardMessage,
      parse_mode: "Markdown"
    });

    userReplyMap.set(sentMsg.message_id, msg.from.id);
    adminReplyMap.set(msg.message_id, sentMsg.message_id);
  }

  await bot.sendMessage(chatId, "✅ *Screenshot received!* Please wait while the admin verifies it.", { parse_mode: "Markdown" });
});


bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const replyToMsgId = msg.reply_to_message?.message_id;

  // Ignore system/bot messages or stickers/photos etc (unless handled elsewhere)
  if (!msg.text) return;

  // (1) Admin replies to user (only if it's a reply)
  if (VIP_ADMINS.includes(chatId) && replyToMsgId && userReplyMap.has(replyToMsgId)) {
    const userId = userReplyMap.get(replyToMsgId);
    const replyText = msg.text || "(No text)";
    const forwardReply = `💬 *Admin Response:*\n\n${replyText}`;

    const sent = await bot.sendMessage(userId, forwardReply, { parse_mode: "Markdown" });

    // Maintain reply map
    userReplyMap.set(sent.message_id, userId);
    adminReplyMap.set(msg.message_id, sent.message_id);
    return;
  }

  // (2) Any user (non-admin) sends a new message (not a reply) → forward to admins
  if (!VIP_ADMINS.includes(chatId) && !msg.reply_to_message) {
    const user = msg.from;
    const messageText = msg.text || "(No text)";
    const forwardMsg = `📩 *New Message from User:*\n👤 [${user.first_name}](tg://user?id=${user.id})\n\n💬 ${messageText}`;

    for (const adminId of VIP_ADMINS) {
      const sent = await bot.sendMessage(adminId, forwardMsg, { parse_mode: "Markdown" });

      // Save reply mapping for threading
      userReplyMap.set(sent.message_id, user.id);
      adminReplyMap.set(msg.message_id, sent.message_id);
    }
  }
});


