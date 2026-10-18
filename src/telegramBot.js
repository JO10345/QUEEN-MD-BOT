/**
 * Telegram Pairing Bot
 *
 * Anyone can /pair when bot is PUBLIC.
 * When PRIVATE, pairing is blocked for everyone.
 * Only the owner (TELEGRAM_ADMIN_IDS) can toggle /public and /private.
 *
 * Commands:
 *   /start              — welcome message
 *   /help               — show all commands
 *   /pair <number>      — pair a WhatsApp number (blocked when private)
 *   /unpair <number>    — disconnect & remove a session
 *   /sessions           — list all active sessions
 *   /status             — show bot status & slot usage
 *   /public             — [OWNER ONLY] make bot public
 *   /private            — [OWNER ONLY] make bot private
 *   /cleanup            — manually trigger temp file cleanup
 */

import TelegramBot from 'node-telegram-bot-api';
import { execSync }                    from 'child_process';
import { existsSync, unlinkSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join }                        from 'path';
import {
  createSession,
  stopSession,
  reconnectSession,
  deleteSession,
  getSessions,
  getSessionCount,
  isSessionActive,
  cleanTempFiles,
  MAX_SESSIONS,
  BOT_NAME,
  PREFIX,
  BOT_PUBLIC,
  setBotPublic,
  AUTH_BASE,
  hasSnapshot,
  restoreFromSnapshot,
} from './whatsapp.js';
import {
  isChatbotPmEnabled,
  isChatbotGroupEnabled,
  setChatbotPm,
  setChatbotGroup,
} from './features/chatbot.js';

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN || '';

// Throttle "Connected!" Telegram notifications — at most once per 30 min per phone
const _lastConnNotify  = new Map();
const CONN_NOTIFY_MS   = 30 * 60 * 1000;  // 30 minutes

// Owner IDs — only these can toggle /public and /private
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

let bot = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOwner(userId) {
  if (ADMIN_IDS.length === 0) return true; // if no admins set, allow all
  return ADMIN_IDS.includes(String(userId));
}

function normalizePhone(raw) {
  return (raw || '').replace(/[^0-9]/g, '');
}

function sessionList() {
  const list = getSessions();
  if (list.length === 0) return '📭 No active sessions.';
  return list.map((s, i) => {
    const age  = Math.floor((Date.now() - s.createdAt) / 60000);
    const icon = { connected:'🟢', connecting:'🟡', waiting_code:'🔵', disconnected:'🔴' }[s.status] || '⚪';
    return `${i + 1}. ${icon} *+${s.phone}*\n   Status: ${s.status}\n   JID: \`${s.jid}\`\n   Up: ${age}m`;
  }).join('\n\n');
}

function send(chatId, text, extra = {}) {
  if (!bot) return Promise.resolve();
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra }).catch(err => {
    console.error('[TG] send error:', err.message);
  });
}

// ── Bot startup ───────────────────────────────────────────────────────────────

export function startTelegramBot({ onRemoveSession = () => {}, onSaveSession = () => {} } = {}) {
  if (!TOKEN) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN not set — Telegram pairing bot disabled.');
    console.warn('   Set TELEGRAM_BOT_TOKEN in your .env file to enable pairing.\n');
    return null;
  }

  bot = new TelegramBot(TOKEN, { polling: true });

  bot.on('polling_error', err => {
    console.error('[TG] Polling error:', err.message);
  });

  // ── /start ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/start$/, (msg) => {
    const chatId = msg.chat.id;
    send(chatId,
      `👑 *${BOT_NAME} — Telegram Control Bot*\n\n` +
      `🔐 *Mode:* ${BOT_PUBLIC ? '🌍 Public — pairing is open' : '🔒 Private — pairing is closed'}\n` +
      `🔌 *Slots:* ${getSessionCount()}/${MAX_SESSIONS}\n\n` +
      `📋 *Commands:*\n` +
      `• /pair \`<number>\` — pair a WhatsApp number\n` +
      `• /unpair \`<number>\` — remove a session\n` +
      `• /backup \`<number>\` — download session backup file\n` +
      `• /reconnect \`<number>\` — force reconnect (fixes no-response)\n` +
      `• /restorebackup \`<number>\` — roll back to last known-good session\n` +
      `• /chatbot \`[on|off]\` — control AI auto-reply for PMs/groups\n` +
      `• /sessions — list active sessions\n` +
      `• /status — show slot usage & uptime\n` +
      `• /cleanup — clean old temp files\n` +
      `• /help — show this menu\n\n` +
      `🔒 *Owner only:*\n` +
      `• /public — open pairing to everyone\n` +
      `• /private — close pairing & commands`
    );
  });

  // ── /help ───────────────────────────────────────────────────────────────────
  bot.onText(/^\/help$/, (msg) => {
    send(msg.chat.id,
      `👑 *${BOT_NAME} — Help*\n\n` +
      `*Pairing:*\n` +
      `\`/pair 2348012345678\`\n` +
      `→ Generates a pairing code.\n` +
      `→ Enter it in WhatsApp:\n` +
      `   _Settings → Linked Devices → Link with number_\n\n` +
      `⚠️ Pairing is only available when the bot is *Public*.\n\n` +
      `*Session management:*\n` +
      `\`/unpair 2348012345678\` — disconnect & remove\n` +
      `\`/backup 2348012345678\` — download auth backup as .tar.gz\n` +
      `\`/reconnect 2348012345678\` — force reconnect (use if bot stops responding)\n` +
      `\`/restorebackup 2348012345678\` — roll session back to the bot's own auto-saved last known-good state (use if /reconnect alone doesn't help)\n` +
      `\`/chatbot\` — check/enable AI auto-reply (replies to anyone messaging you, even while you're offline)\n` +
      `\`/sessions\` — see all active sessions\n` +
      `\`/status\` — see slot usage (max ${MAX_SESSIONS})\n` +
      `\`/cleanup\` — delete old temp files\n\n` +
      `*Owner-only mode control:*\n` +
      `\`/public\` — allow pairing & open all commands 🌍\n` +
      `\`/private\` — block pairing & restrict commands 🔒\n\n` +
      `*Number format:* Country code + number, no + or spaces\n` +
      `Example: \`2348012345678\` (NG)  \`447911123456\` (UK)`
    );
  });

  // ── /pair <number> — blocked when private ──────────────────────────────────
  bot.onText(/^\/pair(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    // Block pairing when bot is private
    if (!BOT_PUBLIC) {
      return send(chatId,
        `🔒 *Bot is currently PRIVATE.*\n\n` +
        `Pairing is closed. The owner must set the bot to public first.\n\n` +
        `_Contact the owner to request access._`
      );
    }

    const phone = normalizePhone((match[1] || '').trim());

    if (!phone || phone.length < 7 || phone.length > 15) {
      return send(chatId,
        `❌ *Invalid number.*\n\n` +
        `Usage: \`/pair <number>\`\n` +
        `Example: \`/pair 2348012345678\`\n\n` +
        `Include the country code, digits only (no + or spaces).`
      );
    }

    if (isSessionActive(phone)) {
      return send(chatId,
        `⚠️ *Already active* for +${phone}.\n\n` +
        `To re-pair, remove it first:\n\`/unpair ${phone}\``
      );
    }

    if (getSessionCount() >= MAX_SESSIONS) {
      return send(chatId,
        `🚫 *Slot limit reached* (${MAX_SESSIONS}/${MAX_SESSIONS}).\n\n` +
        `Remove a session first:\n\`/unpair <number>\``
      );
    }

    send(chatId,
      `⏳ *Connecting to WhatsApp...*\n📱 Number: \`+${phone}\`\n\n_Please wait..._`
    );

    try {
      await createSession(phone, {
        onPairingCode: (code) => {
          send(chatId,
            `🔑 *Pairing Code for +${phone}*\n\n` +
            `\`\`\`\n${code}\n\`\`\`\n\n` +
            `📲 *How to link:*\n` +
            `1. Open WhatsApp on your phone\n` +
            `2. Go to *Settings → Linked Devices*\n` +
            `3. Tap *Link a Device*\n` +
            `4. Tap *"Link with phone number instead"*\n` +
            `5. Enter the code above ✅\n\n` +
            `_Code expires in a few minutes — enter it quickly!_`
          );
        },
        onConnected: (jid) => {
          const _now  = Date.now();
          const _last = _lastConnNotify.get(phone) || 0;
          if (_now - _last > CONN_NOTIFY_MS) {
            _lastConnNotify.set(phone, _now);
            send(chatId,
              `✅ *Connected!* +${phone} is now live.\n` +
              `JID: \`${jid}\`\n\n` +
              `A welcome message has been sent to the number.\n` +
              `Send \`${PREFIX}help\` in WhatsApp to see all commands.`
            );
          }
          // Save the chat ID so reconnect/restore notifications reach Telegram
          onSaveSession(phone, chatId);
        },
        onDisconnected: (p, reason) => {
          if (reason === 'logged_out') {
            send(chatId,
              `🔴 *Logged out:* +${p}\n` +
              `Session removed. Run \`/pair ${p}\` to reconnect.`
            );
          } else if (reason === 'session_recovered') {
            send(chatId,
              `🔧 *Auto-recovery for +${p}*\n\n` +
              `Signal keys were reset and the bot is reconnecting — *no re-pairing needed.*\n\n` +
              `Fresh pre-keys will be uploaded to WhatsApp on reconnect. The bot will be back online in a few seconds.`
            );
          } else if (reason === 'incomplete_auth') {
            send(chatId,
              `🔄 *Re-pairing needed for +${p}*\n\n` +
              `The saved session was incomplete — only creds.json was found without the required Signal encryption keys.\n\n` +
              `*A fresh pairing code is on its way.* Enter it in WhatsApp:\n` +
              `1. Open WhatsApp → *Settings → Linked Devices*\n` +
              `2. Tap *Link a Device*\n` +
              `3. Tap *"Link with phone number instead"*\n` +
              `4. Enter the new code\n\n` +
              `To restore a session on a new server, copy the entire auth_info folder — not just creds.json.`
            );
          } else if (reason === 'pairing_failed') {
            send(chatId,
              `❌ *Pairing failed for +${p}*\n\n` +
              `WhatsApp rejected the device handshake. This is usually temporary and is not caused by your chat.\n\n` +
              `*Try again:* \`/pair ${p}\`\n\n` +
              `_Tips if it keeps failing:_\n` +
              `• Wait 1–2 minutes before trying again\n` +
              `• Enter the code quickly — it expires in ~60 seconds\n` +
              `• Make sure you tap "Link a Device" → "Link with phone number"\n` +
              `• Try again after 1–2 minutes`
            );
          } else if (reason === 'replaced') {
            send(chatId,
              `🔄 *+${p} replaced* — another device connected with this number.`
            );
          } else if (reason === 'forbidden') {
            send(chatId,
              `🔴 *Session rejected for +${p} (403)*\n\n` +
              `The saved WhatsApp linked-device session is no longer accepted. ` +
              `The reconnect loop has been stopped and its auth files were removed.\n\n` +
              `Run \`/pair ${p}\` to create a fresh session.`
            );
          } else {
            send(chatId,
              `⚠️ *+${p} disconnected* (code: ${reason}) — retrying automatically...`
            );
          }
        },
        onError: (err) => {
          send(chatId, `❌ *Error pairing +${phone}:*\n\`${err.message}\``);
        },
      });
    } catch (err) {
      send(chatId, `❌ *Failed to start session:*\n\`${err.message}\``);
    }
  });

  // ── /unpair <number> ────────────────────────────────────────────────────────
  bot.onText(/^\/unpair(?:\s+(.+))?$/, (msg, match) => {
    const chatId = msg.chat.id;
    const phone  = normalizePhone((match[1] || '').trim());
    if (!phone) return send(chatId, `❌ Usage: \`/unpair <number>\`\nExample: \`/unpair 2348012345678\``);

    // deleteSession: ends socket + removes auth folder so it won't auto-restore
    deleteSession(phone);
    // Also remove from sessions.json so it won't be re-paired on restart
    onRemoveSession(phone);
    send(chatId, `✅ *Session removed:* +${phone}\nThe bot is fully disconnected and unpaired.\nAuth folder deleted — run /pair to reconnect.`);
  });

  // ── /sessions ───────────────────────────────────────────────────────────────
  bot.onText(/^\/sessions$/, (msg) => {
    send(msg.chat.id,
      `📋 *Active Sessions* (${getSessionCount()}/${MAX_SESSIONS})\n\n` + sessionList()
    );
  });

  // ── /status ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/status$/, (msg) => {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    send(msg.chat.id,
      `📊 *${BOT_NAME} Status*\n\n` +
      `🔐 Mode: ${BOT_PUBLIC ? '🌍 Public' : '🔒 Private'}\n` +
      `🔌 Sessions: ${getSessionCount()}/${MAX_SESSIONS}\n` +
      `⏱️ Uptime: ${h}h ${m}m\n` +
      `🧠 Memory: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB\n` +
      `🤖 Node: ${process.version}\n\n` +
      (getSessionCount() > 0 ? sessionList() : '_No active sessions._')
    );
  });

  // ── /public — OWNER ONLY ────────────────────────────────────────────────────
  bot.onText(/^\/public$/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(msg.from?.id)) {
      return send(chatId,
        `🚫 *Owner only.*\n\nOnly the bot owner can change the public/private mode.`
      );
    }
    setBotPublic(true);
    send(chatId,
      `✅ *Bot is now PUBLIC* 🌍\n\n` +
      `• Anyone can pair their WhatsApp number\n` +
      `• All commands are open to everyone\n\n` +
      `To close: /private`
    );
  });

  // ── /private — OWNER ONLY ───────────────────────────────────────────────────
  bot.onText(/^\/private$/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(msg.from?.id)) {
      return send(chatId,
        `🚫 *Owner only.*\n\nOnly the bot owner can change the public/private mode.`
      );
    }
    setBotPublic(false);
    send(chatId,
      `✅ *Bot is now PRIVATE* 🔒\n\n` +
      `• Pairing new numbers is blocked\n` +
      `• WhatsApp commands are restricted\n\n` +
      `To open: /public`
    );
  });

  // ── /backup <number> ────────────────────────────────────────────────────────
  bot.onText(/^\/backup(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const phone  = normalizePhone((match[1] || '').trim());

    if (!phone) {
      const list = getSessions();
      const hint = list.length
        ? `Active sessions:\n` + list.map(s => `• \`/backup ${s.phone}\``).join('\n')
        : '_No active sessions._';
      return send(chatId,
        `📦 *Backup — Usage:*\n\n\`/backup <number>\`\n\nDownloads the full auth folder for that number as a .tar.gz file. Keep it safe — it contains your session keys.\n\n` + hint
      );
    }

    const authDir = join(AUTH_BASE, phone);
    if (!existsSync(authDir)) {
      return send(chatId, `❌ No auth folder found for +${phone}. Is the number paired?`);
    }

    const tmpFile = `/tmp/auth_${phone}_${Date.now()}.tar.gz`;
    try {
      await send(chatId, `📦 Creating backup for +${phone}...`);
      execSync(`tar -czf ${tmpFile} -C ${AUTH_BASE} ${phone}`, { stdio: 'pipe' });
      await bot.sendDocument(chatId, tmpFile, {
        caption: `✅ Auth backup for +${phone}\n\nTo restore: extract this archive into your \`auth_info/\` folder on the new server, then restart the bot.`,
      }, {
        filename: `auth_${phone}.tar.gz`,
        contentType: 'application/gzip',
      });
    } catch (err) {
      send(chatId, `❌ Backup failed: ${err.message}`);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });

  // ── /reconnect <number> — graceful reconnect without re-pairing ────────────
  bot.onText(/^\/reconnect(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const phone  = normalizePhone((match[1] || '').trim());

    if (!phone) {
      const list = getSessions();
      const hint = list.length
        ? `Active sessions:\n` + list.map(s => `• \`/reconnect ${s.phone}\``).join('\n')
        : '_No active sessions._';
      return send(chatId,
        `🔄 *Reconnect — Usage:*\n\n\`/reconnect <number>\`\n\nForces a graceful reconnect. Use this if the bot is connected but not responding.\n\n` + hint
      );
    }

    const authDir   = join(AUTH_BASE, phone);
    const credsPath = join(authDir, 'creds.json');

    if (!existsSync(authDir)) {
      return send(chatId, `❌ No session found for +${phone}. Use /pair to create one.`);
    }

    // Prefer restoring the bot's own internal last-known-good snapshot — it's
    // a FULL, self-consistent auth state captured while the session was
    // actually connected & responding, so it recovers far more reliably than
    // clearing Signal files in place and hoping renegotiation succeeds.
    const usedSnapshot = hasSnapshot(phone) && restoreFromSnapshot(phone);

    if (usedSnapshot) {
      send(chatId, `🔄 Reconnecting +${phone}...\n\n_Restoring last known-good session state and restarting. Takes ~5 seconds._`);
    } else {
      send(chatId, `🔄 Reconnecting +${phone}...\n\n_No internal snapshot yet — clearing Signal sessions and restarting. Takes ~5 seconds._`);
      // Patch creds.json to force a pre-key refresh on reconnect (fixes "no response" silently)
      if (existsSync(credsPath)) {
        try {
          const raw = JSON.parse(readFileSync(credsPath, 'utf8'));
          raw.serverHasPreKeys = false;
          writeFileSync(credsPath, JSON.stringify(raw));
          // Clear Signal session files so they're rebuilt fresh on reconnect
          let cleared = 0;
          for (const f of readdirSync(authDir)) {
            if (/^(pre-key-\d+|session-.+|sender-key-.+|app-state-sync-key-.+)\.json$/.test(f)) {
              try { unlinkSync(join(authDir, f)); cleared++; } catch {}
            }
          }
          if (cleared) console.log(`[reconnect] Cleared ${cleared} Signal file(s) for ${phone}`);
        } catch (e) {
          console.warn(`[reconnect] Could not patch creds for ${phone}: ${e.message}`);
        }
      }
    }

    // Build callbacks so Telegram is notified of the new session's events
    const cbs = {
      onPairingCode: (code) => send(chatId,
        `🔑 *Pairing code for +${phone}*\n\n\`${code}\`\n\n` +
        `Enter this in WhatsApp → Settings → Linked Devices → Link with phone number.`
      ),
      onConnected: (jid) => send(chatId,
        `✅ *+${phone} reconnected!*\n\nSession active as ${jid}`
      ),
      onDisconnected: (p, reason) => {
        if (reason === 'logged_out')
          send(chatId, `🔴 +${p} was logged out — please run /pair again.`);
      },
      onError: (err) => send(chatId, `❌ Reconnect error for +${phone}: ${err.message}`),
    };

    try {
      await reconnectSession(phone, cbs);
    } catch (err) {
      send(chatId, `❌ Failed to reconnect +${phone}: ${err.message}`);
    }
  });

  // ── /restorebackup <number> — roll back to the bot's own internal snapshot ──
  // Different from /reconnect: this ALWAYS force-restores the last-known-good
  // auth snapshot (if one exists) even if /reconnect's lighter cleanup already
  // ran. Use when the bot is connected but silently not responding and a
  // plain /reconnect didn't fix it.
  bot.onText(/^\/restorebackup(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const phone  = normalizePhone((match[1] || '').trim());

    if (!phone) {
      return send(chatId,
        `♻️ *Restore Backup — Usage:*\n\n\`/restorebackup <number>\`\n\n` +
        `Rolls the session back to the bot's own auto-saved last known-good state ` +
        `(captured automatically ~3 minutes after every successful connect, refreshed every 6h). ` +
        `Use this if the bot is connected but not responding and /reconnect alone didn't help.`
      );
    }

    const authDir = join(AUTH_BASE, phone);
    if (!existsSync(authDir)) {
      return send(chatId, `❌ No session found for +${phone}. Use /pair to create one.`);
    }

    if (!hasSnapshot(phone)) {
      return send(chatId,
        `❌ No internal snapshot exists yet for +${phone}.\n\n` +
        `Snapshots are auto-saved ~3 minutes after the bot first connects successfully. ` +
        `If this session hasn't been stable that long yet, none exists to restore from.`
      );
    }

    send(chatId, `♻️ Restoring +${phone} to last known-good state and reconnecting...`);

    const restored = restoreFromSnapshot(phone);
    if (!restored) {
      return send(chatId, `❌ Failed to restore snapshot for +${phone}. Check server logs.`);
    }

    const cbs = {
      onPairingCode: (code) => send(chatId,
        `🔑 *Pairing code for +${phone}*\n\n\`${code}\`\n\nEnter this in WhatsApp → Settings → Linked Devices → Link with phone number.`
      ),
      onConnected: (jid) => send(chatId, `✅ *+${phone} restored and reconnected!*\n\nSession active as ${jid}`),
      onDisconnected: (p, reason) => {
        if (reason === 'logged_out')
          send(chatId, `🔴 +${p} was logged out — please run /pair again.`);
      },
      onError: (err) => send(chatId, `❌ Restore error for +${phone}: ${err.message}`),
    };

    try {
      await reconnectSession(phone, cbs);
    } catch (err) {
      send(chatId, `❌ Failed to reconnect +${phone} after restore: ${err.message}`);
    }
  });

  // ── /chatbot [on|off|pm on|pm off|group on|group off] ───────────────────────
  // Remote control for the AI auto-reply feature — lets the owner enable it
  // from Telegram even if WhatsApp commands aren't getting through (the exact
  // situation where auto-reply matters most: bot is quiet, owner is offline).
  bot.onText(/^\/chatbot(?:\s+(.+))?$/, (msg, match) => {
    const chatId = msg.chat.id;
    const args   = (match[1] || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    const [a, b] = args;

    const status = () =>
      `🤖 *Chatbot auto-reply status*\n\n` +
      `Private messages: ${isChatbotPmEnabled()    ? '🟢 ON' : '🔴 OFF'}\n` +
      `Groups (@mention/reply only): ${isChatbotGroupEnabled() ? '🟢 ON' : '🔴 OFF'}\n\n` +
      `When PM is ON, the bot auto-replies with AI to *any* message someone sends ` +
      `to your number in a private chat — whether you're online or not.\n\n` +
      `Usage: \`/chatbot on\` · \`/chatbot off\` · \`/chatbot pm on\` · \`/chatbot group on\``;

    if (!args.length) return send(chatId, status());

    if (a === 'on')                    { setChatbotPm(true);  setChatbotGroup(true); }
    else if (a === 'off')              { setChatbotPm(false); setChatbotGroup(false); }
    else if (a === 'pm' && b === 'on')    setChatbotPm(true);
    else if (a === 'pm' && b === 'off')   setChatbotPm(false);
    else if (a === 'group' && b === 'on') setChatbotGroup(true);
    else if (a === 'group' && b === 'off')setChatbotGroup(false);
    else return send(chatId, `❌ Unknown option.\n\n` + status());

    send(chatId, `✅ Updated.\n\n` + status());
  });

  // ── /cleanup ────────────────────────────────────────────────────────────────
  bot.onText(/^\/cleanup$/, (msg) => {
    try {
      const deleted = cleanTempFiles();
      send(msg.chat.id, `🧹 *Cleanup done!* Deleted ${deleted} old temp file(s).`);
    } catch (err) {
      send(msg.chat.id, `❌ *Cleanup error:* ${err.message}`);
    }
  });

  const ownerNote = ADMIN_IDS.length > 0
    ? `Owner IDs: ${ADMIN_IDS.join(', ')}`
    : `No TELEGRAM_ADMIN_IDS set — all users can toggle mode`;
  console.log(`✅ Telegram pairing bot started. ${ownerNote}\n`);
  return bot;
}

export function sendTelegramMessage(chatId, text) {
  if (!bot || !chatId) return;
  return send(chatId, text);
}
