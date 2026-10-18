/**
 * Queen MD Bot v3 — Entry Point
 *
 * Starts:
 *   1. Telegram pairing bot (for /pair <number> interface)
 *   2. Restores any previously saved WhatsApp sessions
 *   3. Auto-cleanup of temp files every 30 minutes
 *
 * NO terminal interaction — everything is managed via the Telegram bot.
 * Sessions persist across restarts via sessions.json
 */

import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  createSession,
  cleanTempFiles,
  AUTH_BASE,
  MAX_SESSIONS,
  BOT_NAME,
} from './whatsapp.js';
import { startTelegramBot, sendTelegramMessage } from './telegramBot.js';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = join(__dirname, '../sessions.json');

// ── Startup Banner ─────────────────────────────────────────────────────────────

const PREFIX = process.env.PREFIX || '!';
const DEBUG  = process.env.DEBUG === 'true';

console.log('\n╔══════════════════════════════════════════════╗');
console.log(`║  👑  ${BOT_NAME}`.padEnd(46) + '║');
console.log(`║  Max sessions: ${MAX_SESSIONS}  |  Prefix: ${PREFIX}  |  Debug: ${DEBUG?'ON':'OFF'}`.padEnd(46) + '║');
console.log(`║  Control via Telegram bot (/pair <number>)`.padEnd(46) + '║');
console.log('╚══════════════════════════════════════════════╝\n');

// ── Session Persistence ────────────────────────────────────────────────────────

function loadSavedSessions() {
  if (!existsSync(SESSIONS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

export function saveSession(phone, chatId = null) {
  const saved = loadSavedSessions();
  const existing = saved.find(s => s.phone === phone);
  if (!existing) {
    saved.push({ phone, addedAt: Date.now(), chatId });
    writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: saved }, null, 2));
  } else if (chatId && !existing.chatId) {
    // Store chat ID so the restore path can send Telegram notifications
    existing.chatId = chatId;
    writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: saved }, null, 2));
  }
}

export function removeSession(phone) {
  const saved = loadSavedSessions().filter(s => s.phone !== phone);
  writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: saved }, null, 2));
}

// ── Session Restore ────────────────────────────────────────────────────────────

async function restoreSessions() {
  const saved = loadSavedSessions();

  // Also scan auth_info/ directory — restore any session whose creds.json exists
  // even if it was never written to sessions.json (e.g. after a server reset)
  if (existsSync(AUTH_BASE)) {
    try {
      for (const dir of readdirSync(AUTH_BASE)) {
        const credsFile = join(AUTH_BASE, dir, 'creds.json');
        if (existsSync(credsFile) && !saved.find(s => s.phone === dir)) {
          console.log(`🔍 Found existing auth for ${dir} — adding to restore list`);
          saved.push({ phone: dir });
          saveSession(dir);   // persist it so next restart picks it up automatically
        }
      }
    } catch {}
  }

  if (saved.length === 0) {
    console.log('ℹ️  No saved sessions. Use the Telegram bot to /pair a number.\n');
    return;
  }

  console.log(`♻️  Restoring ${saved.length} saved session(s)...`);

  for (const { phone, chatId } of saved) {
    // Check auth directory exists
    const authDir = join(AUTH_BASE, phone);
    if (!existsSync(authDir)) {
      console.warn(`⚠️  [${phone}] Auth directory missing — skipping restore.`);
      removeSession(phone);
      continue;
    }

    // Helper: send to the stored Telegram chat (if known) so the user gets
    // pairing codes / error messages even after a server restart.
    const tgNotify = (text) => {
      if (chatId) sendTelegramMessage(chatId, text);
    };

    try {
      await createSession(phone, {
        onPairingCode: (code) => {
          const formatted = code.match(/.{1,4}/g)?.join('-') ?? code;
          console.log(`🔑 [${phone}] Re-pairing needed. Code: ${formatted}`);
          console.log(`   → Enter in WhatsApp: Settings → Linked Devices → Link with phone number`);
          tgNotify(
            `🔑 *Pairing code for +${phone}*\n\n` +
            `\`\`\`\n${formatted}\n\`\`\`\n\n` +
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
          console.log(`✅ [${phone}] Restored → ${jid}`);
          saveSession(phone, chatId);
        },
        onDisconnected: (p, reason) => {
          if (reason === 'logged_out') {
            console.log(`🔴 [${p}] Logged out — removing from saved sessions.`);
            removeSession(p);
          } else if (reason === 'forbidden') {
            console.log(`🔴 [${p}] WhatsApp rejected the saved session — removing it from saved sessions.`);
            removeSession(p);
            tgNotify(
              `🔴 *Session rejected for +${p} (403)*\n\n` +
              `The saved WhatsApp linked-device session is no longer accepted. ` +
              `The reconnect loop has been stopped and its auth files were removed.\n\n` +
              `Run \`/pair ${p}\` to create a fresh session.`
            );
          } else if (reason === 'session_recovered') {
            console.log(`🔧 [${p}] Auto-recovery — Signal keys reset, reconnecting without re-pair.`);
            tgNotify(
              `🔧 *Auto-recovery for +${p}*\n\n` +
              `Signal keys were reset automatically. Reconnecting now — no re-pairing needed.`
            );
          } else if (reason === 'incomplete_auth') {
            console.warn(`🔄 [${p}] Incomplete auth — clearing and requesting fresh pair.`);
            tgNotify(
              `🔄 *Re-pairing needed for +${p}*\n\n` +
              `The saved session was incomplete — only creds.json was found without the required Signal encryption keys.\n\n` +
              `*A fresh pairing code will arrive shortly.* Enter it in WhatsApp when it appears.\n\n` +
              `To restore a session on a new server, copy the entire auth_info folder — not just creds.json.`
            );
          }
        },
        onError: (err) => {
          console.error(`❌ [${phone}] Restore error: ${err.message}`);
          tgNotify(`❌ *Session error for +${phone}:*\n\`${err.message}\``);
        },
      });

      // Small delay between restores to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error(`❌ [${phone}] Failed to restore: ${err.message}`);
    }
  }
}

// ── Auto Cleanup ───────────────────────────────────────────────────────────────

// Run cleanup once on startup (after 10s) and every 30 minutes thereafter
setTimeout(cleanTempFiles, 10_000);
setInterval(cleanTempFiles, 30 * 60 * 1000);

// ── Memory Watchdog ────────────────────────────────────────────────────────────
// On a 1.48 GiB server, Node OOM-kills around 1.2–1.3 GiB RSS.
// Log a warning at 800 MB and try to nudge the GC before we hit the wall.

const MEM_WARN_BYTES = 800 * 1024 * 1024;  // 800 MB
const MEM_CRIT_BYTES = 1050 * 1024 * 1024; // ~1.0 GB — last chance before OOM kill

setInterval(() => {
  const rss = process.memoryUsage().rss;
  const mb  = Math.round(rss / 1024 / 1024);

  if (rss >= MEM_CRIT_BYTES) {
    console.warn(`🔴 [MEM] RSS ${mb} MB — CRITICAL. Forcing GC.`);
    if (typeof global.gc === 'function') global.gc();
  } else if (rss >= MEM_WARN_BYTES) {
    console.warn(`🟡 [MEM] RSS ${mb} MB — high. Nudging GC.`);
    if (typeof global.gc === 'function') global.gc();
  }
}, 5 * 60 * 1000); // every 5 minutes

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Start Telegram pairing bot
  startTelegramBot({ onRemoveSession: removeSession, onSaveSession: saveSession });

  // 2. Restore previously paired sessions
  await restoreSessions();

  if (loadSavedSessions().length === 0) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  📱 Open your Telegram bot and send:');
    console.log('     /pair <your_whatsapp_number>');
    console.log('  Example: /pair 2348012345678');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }
}

// ── Global Crash Guards ────────────────────────────────────────────────────────

process.on('uncaughtException', err => {
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('bad mac') || msg.includes('badmac')) {
    console.warn('⚡ Uncaught Bad MAC — will auto-reconnect per session.');
  } else {
    console.error('⚡ Uncaught exception:', err.message);
    if (DEBUG) console.error(err.stack);
  }
});

process.on('unhandledRejection', reason => {
  const msg = String(reason?.message || reason || '').toLowerCase();
  if (!msg.includes('bad mac') && !msg.includes('badmac')) {
    console.error('⚡ Unhandled rejection:', reason);
  }
});

main().catch(err => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
