/**
 * WhatsApp Session Factory
 *
 * Creates and manages individual Baileys sessions.
 * Each phone number gets its own auth_info/<phone>/ directory.
 * Up to MAX_SESSIONS can be active simultaneously.
 *
 * Exported:
 *   createSession(phone, callbacks)   — start a new session
 *   stopSession(phone)                — disconnect & remove session
 *   getSessions()                     — return all active sessions info
 *   getSessionCount()                 — return count
 *   isSessionActive(phone)            — check if phone has an active session
 *   cleanTempFiles()                  — delete old temp files (auto + manual)
 *   BOT_PUBLIC / setBotPublic(val)    — public/private mode
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  isJidStatusBroadcast,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import {
  existsSync,
  mkdirSync,
  cpSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

import { handleMusic }              from './features/music.js';
import {
  handleSpotify, handleSoundCloudSearch, handleFlux, handleAnimate, handleTts, handleChannelReact, handleTikBoost,
} from './features/newFeatures.js';
import { handleMovie }              from './features/movies.js';
import { handleMediafire }          from './features/mediafire.js';
import { handleTelesticker }        from './features/telesticker.js';
import { handleYouTube, handleYtDl, handleYtSearch } from './features/youtube.js';
import { handleWeather }            from './features/weather.js';
import { handleAI, clearAIHistory } from './features/ai.js';
import { handleGemini }             from './features/gemini.js';
import { findAutoreply }            from './features/autoreplies.js';
import {
  applyBotCustomization,
  setBotImage,
  setBotImageFromMessage,
  getBotInfoCard,
} from './features/customize.js';
import {
  handleAutoReact,
  isAutoReactPmEnabled,
  isAutoReactGroupEnabled,
  getAutoReactEmojis,
  setAutoReactPm,
  setAutoReactGroup,
  setAutoReactEmojis,
  setAutoReact,
} from './features/autoreact.js';
import {
  handleChatbot,
  isChatbotPmEnabled,
  isChatbotGroupEnabled,
  setChatbotPm,
  setChatbotGroup,
  clearChatbotHistory,
} from './features/chatbot.js';
import { handleUpdate } from './features/update.js';
import {
  handleAutoTyping,
  isAutoTypingPmEnabled,
  isAutoTypingGroupEnabled,
  setAutoTypingPm,
  setAutoTypingGroup,
  setAutoTyping,
} from './features/autotyping.js';
import { handleImage }  from './features/image.js';
import {
  handleAntilink,
  handleAntilinkCommand,
  handleWarnCommand,
  handleWarnCount,
  handleResetWarn,
} from './features/antilink.js';
import {
  handleAntichannel,
  handleAntichannelCommand,
  isAntichannelOn,
} from './features/antichannel.js';
import {
  handleShip, handleFact, handleCompliment,
  handleTruth, handleDare, handleDice, handleCoin,
  handle8ball, handleHug,
} from './features/cute.js';
import { handleSticker }      from './features/sticker.js';
import { handleTranslate }    from './features/translate.js';
import { handleGroup }        from './features/group.js';
import {
  deleteWatchedMessage,
  isWatchedGroupMessage,
  restoreTimedGroupMutes,
} from './features/groupModeration.js';
import { handleGroupWelcome, isWelcomeEnabled, setWelcome } from './features/welcome.js';
import { handleReminder }     from './features/reminder.js';
import { handleImagine }      from './features/imagine.js';
import { handleCalculator }   from './features/calculator.js';
import { handleCurrency }     from './features/currency.js';
import { handleNews }         from './features/news.js';
import { handleQuote, handleJoke } from './features/fun.js';
import {
  handlePoll,
  handleVote,
  handlePollResults,
  handleEndPoll,
} from './features/poll.js';
import {
  handleAutoStatus,
  handleAutoStatusCommand,
  isAutoStatusViewEnabled,
  isAutoStatusReplyEnabled,
  isAutoStatusReactionEnabled,
} from './features/autostatus.js';
import {
  handleQuiz,
  handleAnswer,
  handleQuizStats,
  handleQuizTop,
  handleEndQuiz,
} from './features/quiz.js';
import { handleFbDl }                                from './features/facebook.js';
import { handleAllInOne }                          from './features/allin.js';
import { handleAdultDl, handleXvSearch,
         handleXnxxSearch, handleXnxxDl }             from './features/adult.js';
import { handleTiktok }                            from './features/tiktok.js';
import { handleApkSearch, handleApkDownload }      from './features/apk.js';
import { handleTextImg }                           from './features/textimg.js';
import { handleLyrics }                            from './features/lyrics.js';
import {
  isViewOnceEnabled, setViewOnce, handleViewOnce, handleVvCommand,
} from './features/viewonce.js';
import {
  isAntiDeleteEnabled, setAntiDelete,
  cacheIncomingMessage, handleAntiDelete,
} from './features/antidelete.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PREFIX       = process.env.PREFIX       || '!';
export const BOT_NAME     = process.env.BOT_NAME     || 'Queen MD Bot';
export const OWNER_NUMBER = process.env.OWNER_NUMBER || '';
export const OWNER_NAME   = process.env.OWNER_NAME   || 'fizu';
export const CREATED_BY   = process.env.CREATED_BY   || 'TECH';
export const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '15');

// Per-session public/private mode — keyed by phone so each paired number
// controls its own mode independently without affecting other sessions.
let _defaultPublic = process.env.BOT_PUBLIC !== 'false';
const _sessionPublic = new Map(); // phone → boolean

// Global BOT_PUBLIC flag — exported for telegramBot.js compatibility.
// Reflects the current default; updated by setBotPublic(val).
export let BOT_PUBLIC = _defaultPublic;

export function isBotPublic(phone) {
  return _sessionPublic.has(phone) ? _sessionPublic.get(phone) : _defaultPublic;
}

/**
 * setBotPublic can be called two ways:
 *   setBotPublic(val)        — global toggle (used by telegramBot.js)
 *   setBotPublic(phone, val) — per-session toggle (used internally)
 */
export function setBotPublic(phoneOrVal, val) {
  if (val === undefined) {
    // Global toggle — update default and exported flag
    BOT_PUBLIC = Boolean(phoneOrVal);
    _defaultPublic = BOT_PUBLIC;
    _sessionPublic.clear(); // reset per-session overrides so global takes effect
  } else {
    // Per-session toggle
    _sessionPublic.set(phoneOrVal, Boolean(val));
  }
}

const DEBUG = process.env.DEBUG === 'true';

const FEATURES = {
  music:     process.env.MUSIC_ENABLED     !== 'false',
  youtube:   process.env.YOUTUBE_ENABLED   !== 'false',
  weather:   process.env.WEATHER_ENABLED   !== 'false',
  ai:        process.env.AI_ENABLED        !== 'false',
  sticker:   process.env.STICKER_ENABLED   !== 'false',
  translate: process.env.TRANSLATE_ENABLED !== 'false',
  group:     process.env.GROUP_ENABLED     !== 'false',
  reminder:  process.env.REMINDER_ENABLED  !== 'false',
  imagine:   process.env.IMAGINE_ENABLED   !== 'false',
  calc:      process.env.CALC_ENABLED      !== 'false',
  currency:  process.env.CURRENCY_ENABLED  !== 'false',
  news:      process.env.NEWS_ENABLED      !== 'false',
  fun:       process.env.FUN_ENABLED       !== 'false',
  poll:      process.env.POLL_ENABLED      !== 'false',
  quiz:      process.env.QUIZ_ENABLED      !== 'false',
  image:     process.env.IMAGE_ENABLED     !== 'false',
  cute:      process.env.CUTE_ENABLED      !== 'false',
  fbdl:      process.env.FBDL_ENABLED      !== 'false',
  allin:     process.env.ALLIN_ENABLED     !== 'false',
  adult:     process.env.ADULT_ENABLED     !== 'false',
  movie:     process.env.MOVIE_ENABLED     !== 'false',
  mediafire: process.env.MEDIAFIRE_ENABLED !== 'false',
  telesticker: process.env.TELESTICKER_ENABLED !== 'false',
};

// Paths — one level up from src/ to project root
// (Global crash guards are registered in index.js — not duplicated here.)

export const AUTH_BASE   = join(__dirname, '../auth_info');
export const TEMP_DIR    = join(__dirname, '../temp');
// Internal "last-known-good" auth snapshots — auto-saved while the bot is
// actually connected & responding, so they can self-heal a dead session
// without needing a manual /backup taken by the user (which can go stale).
export const BACKUP_BASE = join(__dirname, '../auth_backups');

if (!existsSync(AUTH_BASE))   mkdirSync(AUTH_BASE,   { recursive: true });
if (!existsSync(TEMP_DIR))    mkdirSync(TEMP_DIR,    { recursive: true });
if (!existsSync(BACKUP_BASE)) mkdirSync(BACKUP_BASE, { recursive: true });

const logger = pino({ level: 'silent' });

// ── Baileys WA-Web version ─────────────────────────────────────────────────────
// Fetch WhatsApp's current Web version once per process. Set WA_WEB_VERSION to
// override it if WhatsApp's version endpoint is temporarily unavailable.
let _baileysVersionCache = null;
async function getBaileysVersion() {
  if (_baileysVersionCache) return _baileysVersionCache;
  const configured = (process.env.WA_WEB_VERSION || '').split(',')
    .map(v => Number(v.trim()));
  if (configured.length === 3 && configured.every(v => Number.isInteger(v) && v > 0)) {
    _baileysVersionCache = configured;
    console.log(`📡 [Baileys] Using configured WhatsApp Web v${configured.join('.')}`);
    return _baileysVersionCache;
  }

  try {
    const latest = await fetchLatestBaileysVersion();
    const version = latest?.version;
    if (!Array.isArray(version) || version.length !== 3 ||
        !version.every(v => Number.isInteger(v) && v > 0)) {
      throw new Error('Baileys returned an invalid WhatsApp Web version');
    }
    if (latest.error) {
      console.warn(`⚠️  [Baileys] Version lookup failed; using the version bundled with Baileys v${version.join('.')}: ${latest.error?.message || latest.error}`);
    } else {
      console.log(`📡 [Baileys] Using current WhatsApp Web v${version.join('.')}`);
    }
    _baileysVersionCache = [...version];
    return _baileysVersionCache;
  } catch (err) {
    const fallback = [2, 3000, 1040735178];
    console.warn(`⚠️  [Baileys] Could not fetch the current WhatsApp Web version (${err?.message}); using fallback v${fallback.join('.')}. Set WA_WEB_VERSION to override it.`);
    _baileysVersionCache = fallback;
    return _baileysVersionCache;
  }
}

// ── Temp File Cleanup ──────────────────────────────────────────────────────────

const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export function cleanTempFiles() {
  if (!existsSync(TEMP_DIR)) return 0;
  const now = Date.now();
  let deleted = 0;
  try {
    for (const name of readdirSync(TEMP_DIR)) {
      const fp = join(TEMP_DIR, name);
      try {
        const st = statSync(fp);
        if (st.isFile() && (now - st.mtimeMs) > TEMP_MAX_AGE_MS) {
          unlinkSync(fp);
          deleted++;
        }
      } catch {}
    }
  } catch {}
  if (deleted > 0) console.log(`🧹 Cleaned ${deleted} old temp file(s).`);
  return deleted;
}

// ── Signal-session repair (fixes Bad MAC corruption) ──────────────────────────

function clearSignalSessions(authDir) {
  try {
    const cleared = readdirSync(authDir)
      .filter(f => f.startsWith('session-') && f.endsWith('.json'))
      .map(f => { try { unlinkSync(join(authDir, f)); return 1; } catch { return 0; } })
      .reduce((a, b) => a + b, 0);
    if (cleared) console.log(`🔑 [signal-repair] Cleared ${cleared} corrupted session file(s) in ${authDir}`);
    return cleared;
  } catch { return 0; }
}

// ── Self-contained auth snapshots (last-known-good state) ─────────────────────
// A manually-taken /backup can go stale: WhatsApp's Signal ratchet keeps
// advancing while the bot runs, so an old backup often can't decrypt current
// messages even though creds.json "looks" valid (bot connects, but every
// incoming message fails Signal decryption → silently dropped → no response).
//
// Instead, we keep our OWN snapshot of the auth folder, refreshed automatically
// while the bot is confirmed connected & healthy. Restoring THIS snapshot (not
// an old manual one) gives the best chance of resuming a working session
// without a fresh re-pair.

function snapshotDir(phone) { return join(BACKUP_BASE, phone); }

/** Copy the live auth folder into the internal "last-known-good" snapshot. */
function snapshotAuthDir(phone) {
  try {
    const src = join(AUTH_BASE, phone);
    const dst = snapshotDir(phone);
    if (!existsSync(src)) return false;
    // cpSync (Node 16.7+) handles recursive copy + overwrite in one call
    cpSync(src, dst, { recursive: true, force: true });
    writeFileSync(join(dst, '.snapshot-meta.json'), JSON.stringify({ savedAt: Date.now() }));
    return true;
  } catch (e) {
    console.warn(`⚠️  [${phone}] snapshotAuthDir failed: ${e.message}`);
    return false;
  }
}

/** Does a usable internal snapshot exist for this phone? */
export function hasSnapshot(phone) {
  const dir = snapshotDir(phone);
  return existsSync(dir) && existsSync(join(dir, 'creds.json'));
}

/**
 * Overwrite the live auth folder with the internal snapshot.
 * Used for self-healing when the live session is connected but dead, or when
 * the user explicitly asks to roll back to the last known-good state.
 */
export function restoreFromSnapshot(phone) {
  try {
    const src = snapshotDir(phone);
    const dst = join(AUTH_BASE, phone);
    if (!existsSync(src) || !existsSync(join(src, 'creds.json'))) return false;
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true, force: true });
    try { unlinkSync(join(dst, '.snapshot-meta.json')); } catch {}
    console.log(`♻️  [${phone}] Restored auth folder from internal last-known-good snapshot`);
    return true;
  } catch (e) {
    console.warn(`⚠️  [${phone}] restoreFromSnapshot failed: ${e.message}`);
    return false;
  }
}

// Clean up accumulated pre-key files.
// Baileys generates pre-key-N.json files continuously but never prunes them.
// Hundreds of files make useMultiFileAuthState extremely slow on startup (2-3 min).
// We keep the latest 30 (one full batch) and delete the rest — the older ones
// have already been consumed by the Signal protocol and are no longer needed.
const PRE_KEY_KEEP = 30;
function cleanOldPreKeys(authDir) {
  try {
    const preKeys = readdirSync(authDir)
      .filter(f => /^pre-key-\d+\.json$/.test(f))
      .map(f => ({ f, id: parseInt(f.replace('pre-key-', '').replace('.json', ''), 10) }))
      .sort((a, b) => a.id - b.id);

    if (preKeys.length <= PRE_KEY_KEEP) return 0;

    const toDelete = preKeys.slice(0, preKeys.length - PRE_KEY_KEEP);
    let deleted = 0;
    for (const { f } of toDelete) {
      try { unlinkSync(join(authDir, f)); deleted++; } catch {}
    }
    if (deleted) {
      const phone = authDir.split('/').pop();
      console.log(`🧹 [${phone}] Pruned ${deleted} old pre-key file(s) — kept latest ${PRE_KEY_KEEP}`);
    }
    return deleted;
  } catch { return 0; }
}

// Count Bad MAC errors per phone in a rolling 30-second window
const badMacCount       = new Map();
const BAD_MAC_THRESHOLD = 8;
const BAD_MAC_WINDOW_MS = 30_000;

function trackBadMac(phone) {
  const now  = Date.now();
  const prev = badMacCount.get(phone) || { n: 0, since: now };
  if (now - prev.since > BAD_MAC_WINDOW_MS) { prev.n = 0; prev.since = now; }
  prev.n++;
  badMacCount.set(phone, prev);
  return prev.n;
}

// ── Session Registry ───────────────────────────────────────────────────────────

const sessions      = new Map();
const retryCount    = new Map();   // phone → retry attempts (survives session recreation)
const reconnecting  = new Set();   // phones currently in reconnect delay (prevents duplicates)
const reconnectTimers = new Map(); // phone → delayed reconnect timer
const connectTimes  = new Map();   // phone → timestamp of last successful open (rapid-disconnect detection)
const welcomedPhones = new Set();  // phones that already received welcome (skip on reconnect)

// ── Process-level uptime & disconnect history ──────────────────────────────────
const BOT_START_TIME = Date.now(); // when this Node process started

// phone → array of { ts, code, reason } — last 20 disconnects per session
const _disconnectLog = new Map();
function logDisconnect(phone, code, reason) {
  if (!_disconnectLog.has(phone)) _disconnectLog.set(phone, []);
  const log = _disconnectLog.get(phone);
  log.push({ ts: Date.now(), code: code ?? '?', reason: reason ?? 'unknown' });
  if (log.length > 20) log.shift(); // keep last 20 only
}
function getDisconnectLog(phone) {
  return _disconnectLog.get(phone) || [];
}

// ── Persistent seen-message IDs (survives reconnects within same process) ──────
// When the bot reconnects, WhatsApp re-delivers messages that weren't ACK'd.
// Without this cross-reconnect set, every old command fires again.
// Keyed by phone → Set<msgId>. IDs older than 24h are pruned on each trim.
const _seenByPhone = new Map(); // phone → Map<msgId, timestamp>
const SEEN_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

// ── Contact name cache (persists across reconnects) ───────────────────────────
// Keyed by phone (bot session) → Map<normalised-JID, display-name>.
// Survives reconnects so names learned in session N are still available in N+1.
// Capped at 2 000 entries per phone to bound memory with many active contacts.
const contactNameCache = new Map(); // phone → Map<jid, name>
const CONTACT_CACHE_MAX = 2_000;

function getOrCreateContactMap(phone) {
  if (!contactNameCache.has(phone)) contactNameCache.set(phone, new Map());
  return contactNameCache.get(phone);
}

/** Store a display name, evicting the oldest entry when over the cap. */
function storeContactName(phone, jid, name) {
  if (!name || !jid) return;
  const map = getOrCreateContactMap(phone);
  map.set(jid, name);
  if (map.size > CONTACT_CACHE_MAX) {
    // Delete the oldest entry (Map preserves insertion order)
    map.delete(map.keys().next().value);
  }
}

function getSeenSet(phone) {
  if (!_seenByPhone.has(phone)) _seenByPhone.set(phone, new Map());
  return _seenByPhone.get(phone);
}

function pruneSeenSet(seenMap) {
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const [id, ts] of seenMap) {
    if (ts < cutoff) seenMap.delete(id);
  }
}

export function getSessions() {
  return Array.from(sessions.values()).map(s => ({
    phone:     s.phone,
    status:    s.status,
    jid:       s.jid || '—',
    createdAt: s.createdAt,
    retries:   s.retries,
  }));
}

export function getSessionCount() { return sessions.size; }

export function isSessionActive(phone) {
  const s = sessions.get(phone);
  return !!(s && (s.status === 'connected' || s.status === 'connecting' || s.status === 'waiting_code'));
}

// Phones being intentionally stopped — prevents connection.update('close')
// from scheduling a reconnect after explicit unpair / stopSession calls.
const intentionalStop = new Set();
const sessionGeneration = new Map(); // phone → invalidates stale reconnect callbacks

function clearSessionRuntime(phone) {
  // Invalidate callbacks that were already queued and cannot be removed
  // synchronously by clearTimeout.
  sessionGeneration.set(phone, (sessionGeneration.get(phone) || 0) + 1);
  const timer = reconnectTimers.get(phone);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(phone);
  reconnecting.delete(phone);
  retryCount.delete(phone);
  connectTimes.delete(phone);
  badMacCount.delete(phone);
  intentionalStop.delete(phone);
}

function _teardownSocket(phone) {
  const s = sessions.get(phone);
  // Invalidate delayed reconnect callbacks even if the socket was already
  // removed from the session map.
  sessionGeneration.set(phone, (sessionGeneration.get(phone) || 0) + 1);
  const timer = reconnectTimers.get(phone);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(phone);
  reconnecting.delete(phone);
  retryCount.delete(phone);
  connectTimes.delete(phone);
  badMacCount.delete(phone);
  if (!s) {
    intentionalStop.delete(phone);
    return false;
  }
  intentionalStop.add(phone);
  try { s.sock?.ev?.removeAllListeners(); } catch {}
  try { s.sock?.end(new Error('stopped'));  } catch {}
  sessions.delete(phone);
  if (s._watchdog)          clearInterval(s._watchdog);
  if (s._proactiveRefresh)  clearTimeout(s._proactiveRefresh);
  if (s._snapshotInterval)  clearInterval(s._snapshotInterval);
  return true;
}

/** Disconnect socket only — auth folder kept (can reconnect later) */
export function stopSession(phone) {
  return _teardownSocket(phone);
}

/**
 * Stop the current session (if any) and immediately restart it using
 * the callbacks stored in the session entry.  Pass fallbackCallbacks for
 * cases where no session is currently active (e.g. bot was already dead).
 * Auth files are preserved — only the socket is recycled.
 */
export async function reconnectSession(phone, fallbackCallbacks = {}) {
  const s   = sessions.get(phone);
  const cbs = (s?.callbacks && Object.keys(s.callbacks).length)
    ? s.callbacks
    : fallbackCallbacks;

  // Tear down existing socket if one is active
  if (s) _teardownSocket(phone);

  // Let the WS close event settle before opening a new socket
  await new Promise(r => setTimeout(r, 1500));

  // Clear any stale reconnect guard left over from a previous disconnect
  reconnecting.delete(phone);

  return createSession(phone, {
    onPairingCode:  cbs.onPairingCode  ?? (() => {}),
    onConnected:    cbs.onConnected    ?? (() => {}),
    onDisconnected: cbs.onDisconnected ?? (() => {}),
    onError:        cbs.onError        ?? (() => {}),
  });
}

/** Full unpair — disconnect socket AND delete auth folder (cannot reconnect without re-pairing) */
export function deleteSession(phone) {
  _teardownSocket(phone);
  clearSessionRuntime(phone);
  welcomedPhones.delete(phone);
  const authDir = join(AUTH_BASE, phone);
  try {
    if (existsSync(authDir)) {
      rmSync(authDir, { recursive: true, force: true });
      console.log(`🗑️  [${phone}] Auth folder deleted — fully unpaired.`);
    }
  } catch (e) {
    console.warn(`⚠️  Could not delete auth folder for ${phone}: ${e.message}`);
  }
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getBody(msg) {
  const m = msg?.message;
  if (!m) return '';

  // Unwrap common message wrappers (ephemeral, view-once, edited, etc.)
  // Also handle the messageContextInfo wrapper used by WhatsApp Business.
  const inner =
    m.ephemeralMessage?.message            ||
    m.viewOnceMessage?.message             ||
    m.viewOnceMessageV2?.message           ||
    m.viewOnceMessageV2Extension?.message  ||
    // Edited messages: WA wraps the new text inside editedMessage
    m.editedMessage?.message               ||
    // Document-with-caption from WA Business
    m.documentWithCaptionMessage?.message  ||
    m;

  return (
    inner.conversation                                           ||
    inner.extendedTextMessage?.text                             ||
    inner.imageMessage?.caption                                 ||
    inner.videoMessage?.caption                                 ||
    inner.documentMessage?.caption                              ||
    inner.audioMessage?.caption                                 ||
    inner.stickerMessage?.caption                               ||
    // WhatsApp Business interactive replies
    inner.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    inner.interactiveResponseMessage?.body?.text                ||
    inner.buttonsResponseMessage?.selectedButtonId              ||
    inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
    inner.templateButtonReplyMessage?.selectedId                ||
    // WA Business product / catalog messages — extract text fallback
    inner.productMessage?.productId                             ||
    ''
  ).trim();
}

// ── Session-owner / admin detection ──────────────────────────────────────────
// Owner = any of:
//   1. fromMe=true   — message sent by the bot's own device
//   2. sender digits match the connected session's phone (sock.user.id)
//   3. sender digits match OWNER_NUMBER env var
// This triple-check survives different Baileys JID formats and lets the
// person who paired the bot use owner commands from groups too.

function phoneDigits(raw) {
  // In v7, the primary JID can be an @lid identifier, not a phone number.
  // Only treat PN JIDs (or a plain OWNER_NUMBER value) as phone digits.
  if (typeof raw !== 'string' || !raw) return '';
  const at = raw.lastIndexOf('@');
  if (at >= 0 && !['s.whatsapp.net', 'c.us'].includes(raw.slice(at + 1).toLowerCase())) {
    return '';
  }
  return (at >= 0 ? raw.slice(0, at) : raw).split(':')[0].replace(/[^0-9]/g, '');
}

function normalizedJid(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const at = raw.lastIndexOf('@');
  return at >= 0
    ? `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`
    : raw.split(':')[0];
}

function isConnectedUser(sock, sender, fromMe) {
  if (fromMe) return true;

  const senderValues = (Array.isArray(sender) ? sender : [sender]).filter(Boolean);
  const ownValues = [
    sock.user?.id,
    sock.user?.lid,
    sock.user?.phoneNumber,
  ].filter(Boolean);
  const ownJids = new Set(ownValues.map(normalizedJid));
  if (senderValues.some(id => ownJids.has(normalizedJid(id)))) return true;

  const senderIds = senderValues
    .map(phoneDigits).filter(digits => digits.length >= 9);
  if (!senderIds.length) return false;

  const sessionIds = ownValues.map(phoneDigits).filter(digits => digits.length >= 9);
  const ownerDigits = phoneDigits(OWNER_NUMBER);
  const trustedIds = [...sessionIds, ...(ownerDigits.length >= 9 ? [ownerDigits] : [])];

  // Compare the last nine digits to tolerate country-code formatting, but only
  // after the sender was identified as a phone-number JID (never an @lid).
  for (const senderDigits of senderIds) {
    for (const trustedDigits of trustedIds) {
      if (senderDigits.slice(-9) === trustedDigits.slice(-9)) return true;
    }
  }
  return false;
}

const SMALL_CAPS = {
  a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',
  n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'ꜱ',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ',
};
function smallCaps(str) {
  return [...String(str)].map(ch => SMALL_CAPS[ch.toLowerCase()] || ch).join('');
}

// ── Help Menu (category-based) ─────────────────────────────────────────────────

function buildHelpText(category, botIsPublic = true, sessionId = '') {
  const P    = PREFIX;
  const cat  = (category || '').toLowerCase().trim();
  // Pakistan Standard Time (UTC+5) — configurable via TIMEZONE env var
  const tz   = process.env.TIMEZONE || 'Asia/Karachi';
  const time = new Date().toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', timeZone: tz });

  const header = [
    `╭━━━━━ ❀ ━━━━━╮`,
    `   👑 *${BOT_NAME}* 👑`,
    `╰━━━━━ ❀ ━━━━━╯`,
    ``,
    `  🌸 *${time}*  ·  🔐 ${botIsPublic ? '🌍 Public' : '🔒 Private'}`,
    `  🛠️ _${CREATED_BY}_  ·  👤 *${smallCaps(OWNER_NAME)}*`,
  ].join('\n');

  // ── Category list (shown when no sub-command given) ──────────────────────
  if (!cat || cat === 'all') {
    const arPm = isAutoReactPmEnabled()     ? '🟢' : '🔴';
    const arGr = isAutoReactGroupEnabled()  ? '🟢' : '🔴';
    const cbPm = isChatbotPmEnabled()       ? '🟢' : '🔴';
    const cbGr = isChatbotGroupEnabled()    ? '🟢' : '🔴';
    const atPm = isAutoTypingPmEnabled()    ? '🟢' : '🔴';
    const atGr = isAutoTypingGroupEnabled() ? '🟢' : '🔴';
    const asV  = isAutoStatusViewEnabled()  ? '🟢' : '🔴';
    const asR  = isAutoStatusReplyEnabled() ? '🟢' : '🔴';
    const asReact = isAutoStatusReactionEnabled() ? '🟢' : '🔴';
    const voOn = isViewOnceEnabled()        ? '🟢' : '🔴';
    const adOn = isAntiDeleteEnabled(sessionId) ? '🟢' : '🔴';

    const lines = [header, ``];

    // ── 📥 Downloads ─────────────────────────────────────────────────────────
    lines.push(`╭─── 📥 *Downloads* ───╮`);
    lines.push(`  › ${P}tiktok <link>  ·  ${P}tt <link>`);
    if (FEATURES.youtube) lines.push(
      `  › ${P}yt <link/query>  — pick format\n` +
      `  › ${P}ytdl 1  — MP4 up to 720p  ·  ${P}ytdl 2  — MP3\n` +
      `  › ${P}yts <query>  — search`
    );
    if (FEATURES.fbdl)  lines.push(`  › ${P}fbdl <link>  then  ${P}fbdl 1/2`);
    if (FEATURES.mediafire) lines.push(`  › ${P}mediafire <link>`);
    if (FEATURES.telesticker) lines.push(`  › ${P}telesticker <t.me pack link>`);
    if (FEATURES.allin) lines.push(`  › ${P}dl <link>  — TikTok, IG, Twitter & more`);
    lines.push(``);

    // ── 🎵 Music & Lyrics ────────────────────────────────────────────────────
    lines.push(`╭─── 🎵 *Music & Movies* ───╮`);
    if (FEATURES.music) lines.push(`  › ${P}music <song>  ·  ${P}mp3 <song>  ·  ${P}song <song>`);
    lines.push(`  › ${P}sp <song/artist>  — search, then download with ${P}sp 1`);
    if (FEATURES.music) lines.push(`  › ${P}soundcloud <query>  — search, then download with ${P}soundcloud 1`);
    if (FEATURES.movie) lines.push(`  › ${P}mov <movie name>  — search + download`);
    lines.push(`  › ${P}lyrics <title>  ·  ${P}lyric <title>`);
    lines.push(``);

    // ── 🤖 AI & Tools ───────────────────────────────────────────────────────
    lines.push(`╭─── 🤖 *AI & Tools* ───╮`);
    if (FEATURES.ai)        lines.push(`  › ${P}ai <q>  ·  ${P}ask  ·  ${P}chat  ·  ${P}gemini <q>  ·  ${P}clear`);
    if (FEATURES.imagine)   lines.push(`  › ${P}imagine <desc>  ·  ${P}imgine <desc>  ·  ${P}gen <desc>`);
    lines.push(`  › ${P}gemini image <desc>  ·  ${P}gemini edit <instruction> (reply to photo)`);
    if (FEATURES.weather)   lines.push(`  › ${P}weather <city>`);
    if (FEATURES.translate) lines.push(`  › ${P}translate <lang> <text>`);
    if (FEATURES.calc)      lines.push(`  › ${P}calc <expr>`);
    if (FEATURES.currency)  lines.push(`  › ${P}convert <amt> <from> <to>`);
    if (FEATURES.news)      lines.push(`  › ${P}news [topic]`);
    if (FEATURES.sticker)   lines.push(`  › ${P}sticker  — reply to image`);
    lines.push(`  › ${P}rsticker  — random sticker`);
    lines.push(`  › ${P}font <text>  — stylish text fonts`);
    lines.push(`  › ${P}dp @user  — view profile picture`);
    if (FEATURES.image)     lines.push(`  › ${P}img <q>  ·  ${P}gimg <q>`);
    if (FEATURES.reminder)  lines.push(`  › ${P}remind <time> <text>`);
    lines.push(`  › ${P}apk <app name>  — APK search`);
    lines.push(`  › ${P}apkdl <num>  — download APK from results`);
    lines.push(`  › ${P}tximg sky/water <text>  — text image`);
    lines.push(`  › ${P}flux <prompt>  ·  ${P}tts <text>`);
    lines.push(`  › ${P}channelreact <link>  ·  ${P}tikbost <TikTok link>`);
    lines.push(``);

    // ── 😄 Fun & Games ──────────────────────────────────────────────────────
    lines.push(`╭─── 😄 *Fun & Games* ───╮`);
    if (FEATURES.fun)  lines.push(`  › ${P}quote  ·  ${P}joke`);
    if (FEATURES.cute) lines.push(
      `  › ${P}ship <a> <b>  ·  ${P}fact  ·  ${P}compliment\n` +
      `  › ${P}truth  ·  ${P}dare  ·  ${P}8ball <q>\n` +
      `  › ${P}dice [sides]  ·  ${P}coin  ·  ${P}hug [name]`
    );
    if (FEATURES.poll) lines.push(
      `  › ${P}poll Q | Opt1 | Opt2\n` +
      `  › ${P}vote <n>  ·  ${P}pollresults  ·  ${P}endpoll`
    );
    if (FEATURES.quiz) lines.push(
      `  › ${P}quiz [topic]  ·  ${P}answer A/B/C/D\n` +
      `  › ${P}quizstats  ·  ${P}quiztop  ·  ${P}endquiz`
    );
    lines.push(``);

    // ── 👥 Group Tools ──────────────────────────────────────────────────────
    lines.push(`╭─── 👥 *Group Tools* ───╮`);
    if (FEATURES.group) lines.push(
      `  › ${P}kick  ·  ${P}add  ·  ${P}promote  ·  ${P}demote\n` +
      `  › ${P}tagall  ·  ${P}gcstatus  ·  ${P}mute [minutes]  ·  ${P}unmute  ·  ${P}groupinfo\n` +
      `  › ${P}ban @user/reply  ·  ${P}unban @user/reply  ·  ${P}banlist`
    );
    lines.push(`  › ${P}antilink on/kick/off/list  — delete-only or warn→kick`);
    lines.push(`  › ${P}antichannel on/off/list  — block channel posts`);
    lines.push(`  › ${P}warn @user  ·  ${P}warncount  ·  ${P}resetwarn @user`);
    lines.push(``);

    // ── 🔞 Adult (18+) ──────────────────────────────────────────────────────
    if (FEATURES.adult) {
      lines.push(`╭─── 🔞 *Adult (18+)* ───╮`);
      lines.push(`  › ${P}xvsearch <query>  ·  ${P}xvs <query>`);
      lines.push(`  › ${P}xvdl <xvideos link>`);
      lines.push(`  › ${P}xns <query>  — XNXX search`);
      lines.push(``);
    }

    // ── ⚙️ Owner Settings ────────────────────────────────────────────────────
    lines.push(`╭─── ⚙️ *Owner Settings* ───╮`);
    lines.push(`🔐 Mode: ${botIsPublic ? '🌍 Public' : '🔒 Private'}  › ${P}public / ${P}private`);
    lines.push(`⌨️ Auto-Typing   PM:${atPm} Group:${atGr}  › ${P}autotyping on/off`);
    lines.push(`💬 Auto-React    PM:${arPm} Group:${arGr}  › ${P}autoreact on/off · emoji <3 emoji>`);
    lines.push(`🤖 Chatbot       PM:${cbPm} Group:${cbGr}  › ${P}chatbot on/off`);
    lines.push(`👁️ Auto-Status   View:${asV} Reply:${asR} React:${asReact}  › ${P}autostatus on/off  ·  react <3 emoji>`);
    lines.push(`👀 View-Once     ${voOn}  › ${P}viewonce on/off  ·  ${P}vv (reply to reveal)`);
    lines.push(`🗑️ Anti-Delete   ${adOn}  › ${P}antidelete on/off`);
    lines.push(`🎨 Customise  › ${P}setppbot · ${P}setbio · ${P}update`);
    lines.push(``);
    lines.push(`╰─────── ❀ ───────╯`);
    lines.push(`_♡ Powered by ${BOT_NAME} ♡_`);

    return lines.join('\n');
  }

  // ── Subcategory pages ────────────────────────────────────────────────────
  if (cat === 'dl' || cat === 'download' || cat === 'downloads') {
    const lines = [header, ``, `╭─── 📥 *Downloads* ───╮`];
    lines.push(`\n📱 *TikTok*\n  › ${P}tiktok <link>  ·  ${P}tt <link>`);
    if (FEATURES.youtube) lines.push(
      `\n📹 *YouTube*\n` +
      `  › ${P}yt <link or query>  — pick format\n` +
      `  › ${P}ytdl 1             — MP4 video\n` +
      `  › ${P}ytdl 2             — MP3 audio\n` +
      `  › ${P}yts <query>        — search`
    );
    if (FEATURES.fbdl)  lines.push(`\n📘 *Facebook*\n  › ${P}fbdl <link>  then  ${P}fbdl 1/2`);
    if (FEATURES.mediafire) lines.push(`\n📁 *MediaFire*\n  › ${P}mediafire <link>`);
    if (FEATURES.telesticker) lines.push(`\n🧩 *Telegram stickers*\n  › ${P}telesticker <t.me pack link>`);
    if (FEATURES.allin) lines.push(`\n📲 *All-in-One*\n  › ${P}dl <link>  — TikTok, IG, Twitter & more`);
    lines.push(`\n╰─────── ❀ ───────╯`);
    return lines.join('\n');
  }

  if (cat === 'music' || cat === 'lyrics') {
    const lines = [header, ``, `╭─── 🎵 *Music & Movies* ───╮`];
    if (FEATURES.music) lines.push(`\n🎵 *Music*\n  › ${P}music <song>  ·  ${P}mp3 <song>  ·  ${P}song <song>\n  › ${P}sp <song/artist> then ${P}sp 1  ·  ${P}soundcloud <query> then ${P}soundcloud 1`);
    if (FEATURES.movie) lines.push(`\n🎬 *Movies*\n  › ${P}mov <movie name>  — search + download`);
    lines.push(`\n📝 *Lyrics*\n  › ${P}lyrics <song title>  ·  ${P}lyric <title>`);
    lines.push(`\n╰─────── ❀ ───────╯`);
    return lines.join('\n');
  }

  if (cat === 'ai' || cat === 'tools') {
    const lines = [header, ``, `╭─── 🤖 *AI & Tools* ───╮`];
    if (FEATURES.ai)        lines.push(`\n🤖 *AI Chat*\n  › ${P}ai <q>  ·  ${P}ask  ·  ${P}chat  ·  ${P}gemini <q>\n  › ${P}clear — reset memory`);
    if (FEATURES.imagine)   lines.push(`\n🎨 *AI Image*\n  › ${P}imagine <desc>  ·  ${P}imgine <desc>  ·  ${P}gen <desc>`);
    lines.push(`  › ${P}gemini image <desc>  ·  ${P}gemini edit <instruction> (reply to photo)`);
    if (FEATURES.weather)   lines.push(`\n🌤️ *Weather*\n  › ${P}weather <city>`);
    if (FEATURES.translate) lines.push(`\n🌐 *Translate*\n  › ${P}translate <lang> <text>`);
    if (FEATURES.calc)      lines.push(`\n🧮 *Calculator*\n  › ${P}calc <expr>`);
    if (FEATURES.currency)  lines.push(`\n💱 *Currency*\n  › ${P}convert <amt> <from> <to>`);
    if (FEATURES.news)      lines.push(`\n📰 *News*\n  › ${P}news [topic]`);
    if (FEATURES.sticker)   lines.push(`\n🌟 *Sticker*\n  › ${P}sticker — reply to image`);
    lines.push(`\n🎲 *Random Sticker*\n  › ${P}rsticker  ·  ${P}rs`);
    lines.push(`\n✍️ *Stylish Fonts*\n  › ${P}font <text>  ·  ${P}style <text>`);
    lines.push(`\n📸 *Profile Picture*\n  › ${P}dp @user  ·  ${P}pp @user  ·  ${P}dp <number>`);
    if (FEATURES.image)     lines.push(`\n🖼️ *Image Search*\n  › ${P}img <q>  ·  ${P}gimg <q>`);
    if (FEATURES.reminder)  lines.push(`\n⏰ *Reminder*\n  › ${P}remind <time> <text>`);
    lines.push(`\n✨ *New Tools*\n  › ${P}flux <prompt>  ·  ${P}animate <prompt>  ·  ${P}tts <text>\n  › ${P}channelreact <link>  ·  ${P}tikbost <TikTok link>`);
    lines.push(`\n╰─────── ❀ ───────╯`);
    return lines.join('\n');
  }

  if (cat === 'fun' || cat === 'games') {
    const lines = [header, ``, `╭─── 😄 *Fun & Games* ───╮`];
    if (FEATURES.fun)  lines.push(`\n😄 *Fun*\n  › ${P}quote  ·  ${P}joke`);
    if (FEATURES.cute) lines.push(
      `\n💕 *Cute & Games*\n` +
      `  › ${P}ship <a> <b>  ·  ${P}fact  ·  ${P}compliment\n` +
      `  › ${P}truth  ·  ${P}dare  ·  ${P}8ball <q?>\n` +
      `  › ${P}dice [sides]  ·  ${P}coin  ·  ${P}hug [name]`
    );
    if (FEATURES.poll) lines.push(`\n📊 *Poll*\n  › ${P}poll Q | Opt1 | Opt2\n  › ${P}vote <n>  ·  ${P}pollresults  ·  ${P}endpoll`);
    if (FEATURES.quiz) lines.push(
      `\n🧠 *Quiz*\n` +
      `  › ${P}quiz [topic]  ·  ${P}answer A/B/C/D\n` +
      `  › ${P}quizstats  ·  ${P}quiztop  ·  ${P}endquiz`
    );
    lines.push(`\n╰─────── ❀ ───────╯`);
    return lines.join('\n');
  }

  if (cat === 'group') {
    const lines = [header, ``, `╭─── 👥 *Group Tools* ───╮`];
    if (FEATURES.group) lines.push(
      `\n👥 *Admin Actions*\n` +
      `  › ${P}kick  ·  ${P}add  ·  ${P}promote  ·  ${P}demote\n` +
      `  › ${P}tagall  ·  ${P}gcstatus  ·  ${P}mute [minutes]  ·  ${P}unmute  ·  ${P}groupinfo\n` +
      `  › ${P}ban @user/reply  ·  ${P}unban @user/reply  ·  ${P}banlist`
    );
    lines.push(`\n🚫 *Antilink*\n  › ${P}antilink on/kick/off/list`);
    lines.push(`\n📢 *Group Status*\n  › ${P}gcstatus  — mention all group members`);
    lines.push(`\n📢 *Antichannel*\n  › ${P}antichannel on/off/list  — block WA channel links & forwards`);
    lines.push(`\n⚠️ *Warn system (3 warns = kick)*\n  › ${P}warn @user  ·  ${P}warncount  ·  ${P}resetwarn @user`);
    lines.push(`\n╰─────── ❀ ───────╯`);
    return lines.join('\n');
  }

  if (cat === 'adult' || cat === '18+') {
    if (!FEATURES.adult) return `❌ Adult features are disabled.`;
    return [
      header,
      ``,
      `╭─── 🔞 *Adult (18+)* ───╮`,
      ``,
      `🔍 *Search*`,
      `  › ${P}xvsearch <query>  ·  ${P}xvs <query>`,
      ``,
      `📥 *Download*`,
      `  › ${P}xvdl <xvideos link>`,
      `  › ${P}xvdl <xvideos link>  — direct download`,
      ``,
      `╰─────── ❀ ───────╯`,
    ].join('\n');
  }

  // Unknown category — fall back to overview
  return buildHelpText('', botIsPublic, sessionId);
}

// ── Command Handler ────────────────────────────────────────────────────────────

async function handleCommand(sock, msg, jid, sender, fromMe, cmd, args, hasImg, sessionPhoneOverride = '') {
  // Determine if this is the session owner (connected/paired user)
  const admin = isConnectedUser(sock, [
    sender,
    msg.key?.participantAlt,
    msg.key?.remoteJidAlt,
  ], fromMe);

  // Derive the phone number for this session so mode is per-session isolated
  const sessionPhone = sessionPhoneOverride ||
    sock.user?.phoneNumber?.split(':')[0].split('@')[0] ||
    sock.user?.id?.split(':')[0].split('@')[0] ||
    sock.user?.lid?.split(':')[0].split('@')[0] ||
    '';
  const botIsPublic  = isBotPublic(sessionPhone);

  // ── Public/Private gate ────────────────────────────────────────────────────
  // These commands always work regardless of mode.
  const alwaysOpen = ['help','commands','menu','ping','botinfo','info',
                      'public','private','botpublic','botmode','status'];
  // Private mode: owner/admin can ALWAYS use commands — only others are restricted.
  if (!botIsPublic && !admin && !alwaysOpen.includes(cmd)) {
    await sock.sendMessage(jid, {
      text: `🔒 *This bot is currently private.*\nCommands are restricted.`,
    }, { quoted: msg });
    return;
  }

  // ── Admin-only gate (connected/paired user) ────────────────────────────────
  // These commands are only for the person who paired this number.
  const adminOnly = ['public','private','botpublic','botmode',
                     'autoreact','chatbot','autotyping','autostatus',
                     'antilink','nolink','setppbot','setbio','update','upgrade',
                     'viewonce','antidelete','warn','resetwarn','antichannel','welcome'];
  if (adminOnly.includes(cmd) && !admin) {
    await sock.sendMessage(jid, {
      text: `🚫 *This command is for the bot owner only.*`,
    }, { quoted: msg });
    return;
  }

  // ── Mode toggle ─────────────────────────────────────────────────────────────
  if (cmd === 'public') {
    setBotPublic(sessionPhone, true);
    return sock.sendMessage(jid, {
      text: `✅ *Bot is now PUBLIC* 🌍\nAnyone can use all commands.\n\nTo restrict: *${PREFIX}private*`,
    }, { quoted: msg });
  }

  if (cmd === 'private') {
    setBotPublic(sessionPhone, false);
    return sock.sendMessage(jid, {
      text: `✅ *Bot is now PRIVATE* 🔒\nOnly you can use commands.\n\nTo open again: *${PREFIX}public*`,
    }, { quoted: msg });
  }

  if (cmd === 'botpublic' || cmd === 'botmode') {
    const val = (args || '').trim().toLowerCase();
    if (val === 'on' || val === 'true' || val === 'public') {
      setBotPublic(sessionPhone, true);
      return sock.sendMessage(jid, { text: `✅ Bot is now *PUBLIC* 🌍` }, { quoted: msg });
    }
    if (val === 'off' || val === 'false' || val === 'private') {
      setBotPublic(sessionPhone, false);
      return sock.sendMessage(jid, { text: `✅ Bot is now *PRIVATE* 🔒` }, { quoted: msg });
    }
    return sock.sendMessage(jid, {
      text:
        `🔐 *Bot Mode:* ${botIsPublic ? '🌍 Public (all commands open)' : '🔒 Private (restricted)'}\n\n` +
        `  *${PREFIX}public*  — open to everyone\n` +
        `  *${PREFIX}private* — restrict commands`,
    }, { quoted: msg });
  }

  // ── General ────────────────────────────────────────────────────────────────
  if (cmd === 'help' || cmd === 'commands' || cmd === 'menu') {
    // args = category (e.g. "dl", "music", "ai", "fun", "group", "adult")
    const helpText    = buildHelpText(args, botIsPublic, sessionPhone);
    const botImageUrl = process.env.BOT_IMAGE_URL || '';
    if (botImageUrl) {
      try {
        const res = await axios.get(botImageUrl, { responseType: 'arraybuffer', timeout: 10_000 });
        return sock.sendMessage(jid, { image: Buffer.from(res.data), caption: helpText }, { quoted: msg });
      } catch {}
    }
    return sock.sendMessage(jid, { text: helpText }, { quoted: msg });
  }

  if (cmd === 'ping') {
    const _t0      = Date.now();
    const _pingMsg = await sock.sendMessage(jid, { text: '⏳ *Pinging...*' }, { quoted: msg });
    const _ms      = Date.now() - _t0;
    const _speed   = _ms < 150 ? '🟢 Excellent' : _ms < 400 ? '🟡 Good' : _ms < 900 ? '🟠 Moderate' : '🔴 Slow';
    await sock.sendMessage(jid, {
      text:
        `🏓 *${BOT_NAME}* is alive!\n\n` +
        `⚡ Response: *${_ms} ms*\n` +
        `📶 Speed: ${_speed}\n` +
        `🔗 Status: *Connected*`,
      edit: _pingMsg.key,
    });
    return;
  }

  if (cmd === 'owner') {
    return sock.sendMessage(jid, {
      text: `Queen is my owner ❤️ I love her bhot ziyda She only my love`,
    }, { quoted: msg });
  }

  if (cmd === 'pair') {
    return sock.sendMessage(jid, {
      text:
        `╔══════════════════════════════╗\n` +
        `║   👑  *QUEEN-MD-BOT PAIRING*  ║\n` +
        `╚══════════════════════════════╝\n\n` +
        `To pair *Queen MD Bot* with your WhatsApp number, open our *Telegram Bot* below:\n\n` +
        `🤖 *Telegram Bot:*\n` +
        `👉 https://t.me/techali707_bot\n\n` +
        `📋 *Steps:*\n` +
        `1️⃣ Open the Telegram bot link above\n` +
        `2️⃣ Send: */pair <your_number>*\n` +
        `   Example: /pair 923001234567\n` +
        `3️⃣ Enter the pairing code in WhatsApp:\n` +
        `   *Settings → Linked Devices → Link a Device*\n` +
        `   → _Link with phone number instead_\n\n` +
        `⚠️ _Use full number with country code, no + sign_`,
    }, { quoted: msg });
  }

  if (cmd === 'botinfo' || cmd === 'info') {
    return sock.sendMessage(jid, { text: getBotInfoCard() }, { quoted: msg });
  }

  if (cmd === 'status') {
    // ── Bot health report ──────────────────────────────────────────────────
    const uptimeMs  = Date.now() - BOT_START_TIME;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const days    = Math.floor(uptimeSec / 86400);
    const hours   = Math.floor((uptimeSec % 86400) / 3600);
    const mins    = Math.floor((uptimeSec % 3600)  / 60);
    const secs    = uptimeSec % 60;
    const uptimeStr = days
      ? `${days}d ${hours}h ${mins}m`
      : hours
        ? `${hours}h ${mins}m ${secs}s`
        : `${mins}m ${secs}s`;

    const sesPhone    = sessionPhone;
    const dcLog       = getDisconnectLog(sesPhone);
    const totalDc     = dcLog.length;
    const lastDc      = dcLog[dcLog.length - 1];
    const lastDcStr   = lastDc
      ? `Code *${lastDc.code}* — ${lastDc.reason.slice(0, 60)}`
      : 'None';

    // Build last-5 disconnect table
    const last5 = dcLog.slice(-5).reverse().map((d, i) => {
      const ago = Math.round((Date.now() - d.ts) / 1000);
      const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago/60)}m ago` : `${Math.round(ago/3600)}h ago`;
      return `  ${i + 1}. [${d.code}] ${d.reason.slice(0, 40)} — ${agoStr}`;
    }).join('\n');

    const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const sessionEntry = sessions.get(sesPhone);
    const connStatus   = sessionEntry?.status === 'connected' ? '🟢 Connected' : '🔴 Disconnected';

    const text =
      `📊 *Queen MD Bot — Status Report*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔗 *Connection:* ${connStatus}\n` +
      `⏱️  *Uptime:* ${uptimeStr}\n` +
      `🔁 *Disconnects (this session):* ${totalDc}\n` +
      `⚠️  *Last disconnect:* ${lastDcStr}\n` +
      `💾 *Memory (RSS):* ${memMb} MB\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      (last5
        ? `📋 *Last ${Math.min(5, totalDc)} disconnects:*\n${last5}\n`
        : `✅ *No disconnects recorded yet*\n`) +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Send_ *${PREFIX}status* _any time to refresh._`;

    return sock.sendMessage(jid, { text }, { quoted: msg });
  }

  if (cmd === 'clear' || cmd === 'reset') {
    clearAIHistory(sender);
    return sock.sendMessage(jid, { text: '✅ AI memory cleared.' }, { quoted: msg });
  }

  // ── Music ──────────────────────────────────────────────────────────────────
  if (cmd === 'music' || cmd === 'mp3') {
    if (!FEATURES.music) return sock.sendMessage(jid, { text: '❌ Music disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}music <song>*` });
    return handleMusic(sock, msg, args, cmd);
  }
  if (cmd === 'song') {
    if (!FEATURES.music) return sock.sendMessage(jid, { text: '❌ Music disabled.' });
    return handleMusic(sock, msg, args, 'song');
  }
  if (cmd === 'soundcloud' || cmd === 'sc') {
    if (!FEATURES.music) return sock.sendMessage(jid, { text: '❌ Music features disabled.' });
    return handleSoundCloudSearch(sock, msg, args);
  }
  if (cmd === 'spotify' || cmd === 'sp') return handleSpotify(sock, msg, args);
  if (cmd === 'mov' || cmd === 'movie') {
    if (!FEATURES.movie) return sock.sendMessage(jid, { text: '❌ Movie downloads disabled.' });
    return handleMovie(sock, msg, args);
  }
  if (cmd === 'flux') return handleFlux(sock, msg, args);
  if (cmd === 'animate') return handleAnimate(sock, msg, args);
  if (cmd === 'tts') return handleTts(sock, msg, args);
  if (cmd === 'channelreact') return handleChannelReact(sock, msg, args);
  if (cmd === 'tikbost' || cmd === 'tikboost') return handleTikBoost(sock, msg, args);

  // ── YouTube ────────────────────────────────────────────────────────────────
  if (cmd === 'yt' || cmd === 'youtube') {
    if (!FEATURES.youtube) return sock.sendMessage(jid, { text: '❌ YouTube disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}yt <URL or query>*` });
    return handleYouTube(sock, msg, args);
  }
  if (cmd === 'ytdl' || cmd === 'ytdownload') {
    if (!FEATURES.youtube) return sock.sendMessage(jid, { text: '❌ YouTube disabled.' });
    return handleYtDl(sock, msg, args);
  }
  if (cmd === 'yts' || cmd === 'ytsearch') {
    if (!FEATURES.youtube) return sock.sendMessage(jid, { text: '❌ YouTube disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}yts <query>*` });
    return handleYtSearch(sock, msg, args);
  }

  // ── Facebook ───────────────────────────────────────────────────────────────
  if (cmd === 'fbdl' || cmd === 'fb' || cmd === 'facebook') {
    if (!FEATURES.fbdl) return sock.sendMessage(jid, { text: '❌ Facebook downloader disabled.' });
    return handleFbDl(sock, msg, args);
  }
  if (cmd === 'mediafire' || cmd === 'mfire') {
    if (!FEATURES.mediafire) return sock.sendMessage(jid, { text: '❌ MediaFire downloads disabled.' });
    return handleMediafire(sock, msg, args);
  }
  if (cmd === 'telesticker' || cmd === 'tstickers') {
    if (!FEATURES.telesticker) return sock.sendMessage(jid, { text: '❌ Telegram sticker downloads disabled.' });
    return handleTelesticker(sock, msg, args);
  }

  // ── All-in-One ─────────────────────────────────────────────────────────────
  if (cmd === 'dl' || cmd === 'download' || cmd === 'vid') {
    if (!FEATURES.allin) return sock.sendMessage(jid, { text: '❌ All-in-one downloader disabled.' });
    return handleAllInOne(sock, msg, args);
  }

  // ── TikTok ─────────────────────────────────────────────────────────────────
  if (cmd === 'tiktok' || cmd === 'tt') {
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}tiktok <tiktok link>*` });
    return handleTiktok(sock, msg, args);
  }

  // ── Lyrics ─────────────────────────────────────────────────────────────────
  if (cmd === 'lyrics' || cmd === 'lyric') {
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}lyrics <song title>*` });
    return handleLyrics(sock, msg, args);
  }

  // ── Adult (18+) ────────────────────────────────────────────────────────────
  if (cmd === 'xvdl' || cmd === 'xv') {
    if (!FEATURES.adult) return sock.sendMessage(jid, { text: '❌ Adult downloader disabled.' });
    return handleAdultDl(sock, msg, args, sender);
  }

  if (cmd === 'xvsearch' || cmd === 'xvs') {
    if (!FEATURES.adult) return sock.sendMessage(jid, { text: '❌ Adult search disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}xvsearch <query>*` });
    return handleXvSearch(sock, msg, args);
  }

  // ── Weather ────────────────────────────────────────────────────────────────
  if (cmd === 'weather' || cmd === 'w') {
    if (!FEATURES.weather) return sock.sendMessage(jid, { text: '❌ Weather disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}weather <city>*` });
    return handleWeather(sock, msg, args);
  }

  // ── AI Chat ────────────────────────────────────────────────────────────────
  if (cmd === 'gemini' || cmd === 'gimini') {
    if (!FEATURES.ai) return sock.sendMessage(jid, { text: '❌ AI disabled.' });
    if (!args) return sock.sendMessage(jid, {
      text: `Usage: *${PREFIX}gemini <question>*\n` +
        `Image: reply to a photo with *${PREFIX}gemini edit <instruction>*`,
    });
    return handleGemini(sock, msg, args);
  }

  if (cmd === 'ai' || cmd === 'ask' || cmd === 'chat') {
    if (!FEATURES.ai) return sock.sendMessage(jid, { text: '❌ AI disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}ai <question>*` });
    return handleAI(sock, msg, args);
  }

  // ── Sticker ────────────────────────────────────────────────────────────────
  if (cmd === 'sticker' || cmd === 's') {
    if (!FEATURES.sticker) return sock.sendMessage(jid, { text: '❌ Sticker disabled.' });
    return handleSticker(sock, msg);
  }

  // ── Random Sticker ─────────────────────────────────────────────────────────
  if (cmd === 'rsticker' || cmd === 'rs' || cmd === 'randomsticker') {
    try {
      await sock.sendMessage(jid, { text: '🎲 Fetching random sticker...' }, { quoted: msg });
      const stickerRes = await axios.get(
        'https://api.botcahx.eu.org/api/sticker/random?apikey=GMauog6R',
        { responseType: 'arraybuffer', timeout: 15_000 },
      );
      const stickerBuf = Buffer.from(stickerRes.data);
      return sock.sendMessage(jid, { sticker: stickerBuf }, { quoted: msg });
    } catch (err) {
      return sock.sendMessage(jid, { text: `❌ Could not fetch sticker: ${err.message}` }, { quoted: msg });
    }
  }

  // ── Stylish Font / Text Styles ─────────────────────────────────────────────
  if (cmd === 'font' || cmd === 'style' || cmd === 'fonts') {
    const text = args.trim();
    if (!text) {
      return sock.sendMessage(jid, {
        text: `✍️ *Usage:* *${PREFIX}font <your text>*\n\nExample: *${PREFIX}font Queen MD*\n\nSends your text in multiple stylish WhatsApp fonts.`,
      }, { quoted: msg });
    }
    try {
      const fontRes  = await axios.get(
        `https://eliteprotech-apis.zone.id/font?text=${encodeURIComponent(text)}`,
        { timeout: 10_000 },
      );
      const results  = fontRes.data?.results;
      if (!Array.isArray(results) || !results.length) {
        return sock.sendMessage(jid, { text: '❌ No font styles returned.' }, { quoted: msg });
      }
      const lines = [`✨ *Stylish Text for:* _"${text}"_\n`];
      for (const { name, text: styled } of results) {
        if (styled && styled.trim()) lines.push(`${styled}`);
      }
      return sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
    } catch (err) {
      return sock.sendMessage(jid, { text: `❌ Font API error: ${err.message}` }, { quoted: msg });
    }
  }

  // ── Profile Picture (DP) ───────────────────────────────────────────────────
  if (cmd === 'dp' || cmd === 'pp' || cmd === 'pfp') {
    try {
      // Resolve target JID: tagged mention, quoted message sender, or args number
      let targetJid = null;
      const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (mentions.length) {
        targetJid = mentions[0];
      } else if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant || '';
        if (quotedParticipant) targetJid = quotedParticipant;
      } else if (args.trim()) {
        const num = args.trim().replace(/[^0-9]/g, '');
        if (num) targetJid = `${num}@s.whatsapp.net`;
      }

      if (!targetJid) {
        // Show the bot's own DP if no target given
        targetJid = sock.user?.id || sock.user?.lid || sock.user?.phoneNumber || null;
      }
      if (!targetJid) {
        return sock.sendMessage(jid, {
          text: `ℹ️ *Usage:* *${PREFIX}dp @user* or *${PREFIX}dp <number>*\n\nOr reply to a message with *${PREFIX}dp*`,
        }, { quoted: msg });
      }

      let ppUrl = null;
      try {
        ppUrl = await sock.profilePictureUrl(targetJid, 'image');
      } catch {
        // No profile picture or not in contacts
      }

      if (!ppUrl) {
        return sock.sendMessage(jid, { text: '❌ No profile picture found (private or not set).' }, { quoted: msg });
      }

      const imgRes = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 15_000 });
      const imgBuf = Buffer.from(imgRes.data);
      const numStr = targetJid.split('@')[0];
      return sock.sendMessage(jid, {
        image:   imgBuf,
        caption: `📸 *Profile Picture*\n+${numStr}`,
      }, { quoted: msg });
    } catch (err) {
      return sock.sendMessage(jid, { text: `❌ Could not fetch DP: ${err.message}` }, { quoted: msg });
    }
  }

  // ── Translate ──────────────────────────────────────────────────────────────
  if (cmd === 'translate' || cmd === 'tr') {
    if (!FEATURES.translate) return sock.sendMessage(jid, { text: '❌ Translate disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}translate <lang> <text>*` });
    return handleTranslate(sock, msg, args);
  }

  // ── Group Management ───────────────────────────────────────────────────────
  if (['kick','add','promote','demote','tagall','gcstatus','groupinfo','mute','unmute',
       'ban','unban','banlist'].includes(cmd)) {
    if (!FEATURES.group) return sock.sendMessage(jid, { text: '❌ Group features disabled.' });
    return handleGroup(sock, msg, cmd, args, OWNER_NUMBER);
  }

  // ── Reminder ───────────────────────────────────────────────────────────────
  if (cmd === 'remind' || cmd === 'reminder') {
    if (!FEATURES.reminder) return sock.sendMessage(jid, { text: '❌ Reminder disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}remind <time> <text>*` });
    return handleReminder(sock, msg, args);
  }

  // ── AI Image ───────────────────────────────────────────────────────────────
  if (cmd === 'imagine' || cmd === 'imgine' || cmd === 'image' || cmd === 'gen') {
    if (!FEATURES.imagine) return sock.sendMessage(jid, { text: '❌ Image generation disabled.' });
    return handleImagine(sock, msg, args, cmd === 'imgine' ? 'pollinations' : '');
  }

  // ── Calculator ─────────────────────────────────────────────────────────────
  if (cmd === 'calc' || cmd === 'calculate' || cmd === 'math') {
    if (!FEATURES.calc) return sock.sendMessage(jid, { text: '❌ Calculator disabled.' });
    return handleCalculator(sock, msg, args);
  }

  // ── Currency ───────────────────────────────────────────────────────────────
  if (cmd === 'convert' || cmd === 'currency' || cmd === 'fx') {
    if (!FEATURES.currency) return sock.sendMessage(jid, { text: '❌ Currency converter disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}convert 100 USD NGN*` });
    return handleCurrency(sock, msg, args);
  }

  // ── News ───────────────────────────────────────────────────────────────────
  if (cmd === 'news' || cmd === 'headlines') {
    if (!FEATURES.news) return sock.sendMessage(jid, { text: '❌ News disabled.' });
    return handleNews(sock, msg, args);
  }

  // ── Fun ────────────────────────────────────────────────────────────────────
  if (cmd === 'quote' || cmd === 'q') {
    if (!FEATURES.fun) return sock.sendMessage(jid, { text: '❌ Fun disabled.' });
    return handleQuote(sock, msg);
  }
  if (cmd === 'joke' || cmd === 'j') {
    if (!FEATURES.fun) return sock.sendMessage(jid, { text: '❌ Fun disabled.' });
    return handleJoke(sock, msg);
  }

  // ── Image Search ───────────────────────────────────────────────────────────
  if (['img','gimg','gimage','imgsearch'].includes(cmd)) {
    if (!FEATURES.image) return sock.sendMessage(jid, { text: '❌ Image search disabled.' });
    return handleImage(sock, msg, args);
  }

  // ── Cute & Games ───────────────────────────────────────────────────────────
  if (FEATURES.cute) {
    if (cmd==='ship'||cmd==='love')            { return handleShip(sock,msg,args); }
    if (cmd==='fact'||cmd==='didyouknow')      { return handleFact(sock,msg); }
    if (cmd==='compliment'||cmd==='comp')      { return handleCompliment(sock,msg); }
    if (cmd==='truth')                         { return handleTruth(sock,msg); }
    if (cmd==='dare')                          { return handleDare(sock,msg); }
    if (cmd==='dice'||cmd==='roll')            { return handleDice(sock,msg,args); }
    if (cmd==='coin'||cmd==='flip')            { return handleCoin(sock,msg); }
    if (cmd==='8ball'||cmd==='eightball')      { return handle8ball(sock,msg,args); }
    if (cmd==='hug')                           { return handleHug(sock,msg,args); }
  }

  // ── Poll ───────────────────────────────────────────────────────────────────
  if (cmd === 'poll') {
    if (!FEATURES.poll) return sock.sendMessage(jid, { text: '❌ Poll disabled.' });
    return handlePoll(sock, msg, args);
  }
  if (cmd==='vote')                            { if (!FEATURES.poll) return; return handleVote(sock,msg,args); }
  if (cmd==='pollresults'||cmd==='results')   { if (!FEATURES.poll) return; return handlePollResults(sock,msg); }
  if (cmd==='endpoll')                         { if (!FEATURES.poll) return; return handleEndPoll(sock,msg); }

  // ── Quiz ───────────────────────────────────────────────────────────────────
  if (cmd==='quiz')                            { if (!FEATURES.quiz) return sock.sendMessage(jid,{text:'❌ Quiz disabled.'}); return handleQuiz(sock,msg,args); }
  if (cmd==='answer'||cmd==='ans')             { if (!FEATURES.quiz) return; return handleAnswer(sock,msg,args); }
  if (cmd==='quizstats'||cmd==='score')       { if (!FEATURES.quiz) return; return handleQuizStats(sock,msg); }
  if (cmd==='quiztop'||cmd==='leaderboard')   { if (!FEATURES.quiz) return; return handleQuizTop(sock,msg); }
  if (cmd==='endquiz')                         { if (!FEATURES.quiz) return; return handleEndQuiz(sock,msg); }

  // ── Auto-React ─────────────────────────────────────────────────────────────
  if (cmd === 'autoreact') {
    const rawArgs = (args || '').trim();
    const [first, second] = rawArgs.split(/\s+/, 2);
    const action = (first || '').toLowerCase();
    const value = (second || '').toLowerCase();
    const status = () =>
      `💬 Auto-React: PM ${isAutoReactPmEnabled()?'🟢':'🔴'}  Group ${isAutoReactGroupEnabled()?'🟢':'🔴'}\n` +
      `🎲 Emoji pool: ${getAutoReactEmojis().join(' ')}`;

    if (action === 'emoji' || action === 'emojis') {
      const emojiText = rawArgs.slice(first.length).trim();
      const emojis = emojiText.split(/[,\s]+/).filter(Boolean);
      const isEmoji = token =>
        /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]|[#*0-9]\uFE0F?\u20E3)+$/u.test(token);
      if (emojis.length !== 3 || emojis.some(token => !isEmoji(token))) {
        return sock.sendMessage(jid, {
          text: `Use *${PREFIX}autoreact emoji ❤️ 🔥 😍* with exactly three emoji.`,
        }, { quoted: msg });
      }
      setAutoReactEmojis(emojis);
      setAutoReact(true);
      return sock.sendMessage(jid, {
        text: `✅ Auto-React is ON with your three custom emoji: ${emojis.join(' ')}\n${status()}`,
      }, { quoted: msg });
    }

    if (action==='on')                setAutoReact(true);
    else if (action==='off')          setAutoReact(false);
    else if (action==='pm'&&value==='on')    setAutoReactPm(true);
    else if (action==='pm'&&value==='off')   setAutoReactPm(false);
    else if (action==='group'&&value==='on') setAutoReactGroup(true);
    else if (action==='group'&&value==='off')setAutoReactGroup(false);
    else return sock.sendMessage(jid, {
      text: `${status()}\n\nUse *${PREFIX}autoreact emoji ❤️ 🔥 😍* to set three custom emoji.`,
    }, { quoted: msg });
    return sock.sendMessage(jid, { text: '✅ Updated. ' + status() }, { quoted: msg });
  }

  // ── Chatbot ────────────────────────────────────────────────────────────────
  if (cmd === 'chatbot') {
    const [a, b] = (args || '').toLowerCase().trim().split(/\s+/);
    const status = () => `🤖 Chatbot: PM ${isChatbotPmEnabled()?'🟢':'🔴'}  Group ${isChatbotGroupEnabled()?'🟢':'🔴'}`;
    if (a==='on')                  { setChatbotPm(true);  setChatbotGroup(true); }
    else if (a==='off')            { setChatbotPm(false); setChatbotGroup(false); }
    else if (a==='pm'&&b==='on')    setChatbotPm(true);
    else if (a==='pm'&&b==='off')   setChatbotPm(false);
    else if (a==='group'&&b==='on') setChatbotGroup(true);
    else if (a==='group'&&b==='off')setChatbotGroup(false);
    else if (a==='reset'||a==='clear') {
      clearChatbotHistory();
      return sock.sendMessage(jid, { text: '✅ Chatbot memory cleared.' }, { quoted: msg });
    }
    else return sock.sendMessage(jid, { text: status() }, { quoted: msg });
    return sock.sendMessage(jid, { text: '✅ Updated. ' + status() }, { quoted: msg });
  }

  // ── Auto-Typing ────────────────────────────────────────────────────────────
  if (cmd === 'autotyping' || cmd === 'autotype') {
    const [a, b] = (args || '').toLowerCase().trim().split(/\s+/);
    const status = () => `⌨️ Auto-Typing: PM ${isAutoTypingPmEnabled()?'🟢':'🔴'}  Group ${isAutoTypingGroupEnabled()?'🟢':'🔴'}`;
    if (a==='on')               setAutoTyping(true);
    else if (a==='off')         setAutoTyping(false);
    else if (a==='pm'&&b==='on')    setAutoTypingPm(true);
    else if (a==='pm'&&b==='off')   setAutoTypingPm(false);
    else if (a==='group'&&b==='on') setAutoTypingGroup(true);
    else if (a==='group'&&b==='off')setAutoTypingGroup(false);
    else return sock.sendMessage(jid, { text: status() }, { quoted: msg });
    return sock.sendMessage(jid, { text: '✅ Updated. ' + status() }, { quoted: msg });
  }

  // ── Antilink ───────────────────────────────────────────────────────────────
  if (cmd === 'antilink' || cmd === 'nolink') {
    return handleAntilinkCommand(sock, msg, args, OWNER_NUMBER);
  }

  // ── Anti-Channel ──────────────────────────────────────────────────────────
  if (cmd === 'antichannel') {
    return handleAntichannelCommand(sock, msg, args, OWNER_NUMBER);
  }

  // ── Auto Status ────────────────────────────────────────────────────────────
  if (cmd === 'autostatus') {
    return handleAutoStatusCommand(sock, msg, args);
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  if (cmd === 'update' || cmd === 'upgrade') {
    return handleUpdate(sock, msg);
  }

  // ── Profile picture ────────────────────────────────────────────────────────
  if (cmd === 'setppbot') {
    let ok = false;
    if (hasImg) {
      await sock.sendMessage(jid, { text: '⏳ Updating...' });
      ok = await setBotImageFromMessage(sock, msg);
    } else if (args) {
      await sock.sendMessage(jid, { text: '⏳ Fetching image...' });
      ok = await setBotImage(sock, args.trim());
    } else {
      return sock.sendMessage(jid, { text: `Send *${PREFIX}setppbot* with an image or URL.` });
    }
    return sock.sendMessage(jid, {
      text: ok ? '✅ Profile picture updated!' : '❌ Failed. Try a different image.',
    }, { quoted: msg });
  }

  // ── View Once reveal command ──────────────────────────────────────────────
  if (cmd === 'vv' || cmd === 'viewonce' && args === 'reveal') {
    return handleVvCommand(sock, msg);
  }

  // ── APK Download ───────────────────────────────────────────────────────────
  if (cmd === 'apkdl') {
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}apkdl <number>*\n\nSearch first with *${PREFIX}apk <query>*` }, { quoted: msg });
    return handleApkDownload(sock, msg, args);
  }

  // ── Manual Warn commands ───────────────────────────────────────────────────
  if (cmd === 'warn') {
    return handleWarnCommand(sock, msg, OWNER_NUMBER, admin);
  }
  if (cmd === 'warncount' || cmd === 'warns') {
    return handleWarnCount(sock, msg);
  }
  if (cmd === 'resetwarn' || cmd === 'clearwarn') {
    return handleResetWarn(sock, msg, OWNER_NUMBER);
  }

  // ── APK Search ────────────────────────────────────────────────────────────
  if (cmd === 'apk') {
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}apk <app name>*` }, { quoted: msg });
    return handleApkSearch(sock, msg, args);
  }

  // ── Text to Image ──────────────────────────────────────────────────────────
  if (cmd === 'tximg') {
    return handleTextImg(sock, msg, args);
  }

  // ── XNXX Search ────────────────────────────────────────────────────────────
  if (cmd === 'xns' || cmd === 'xnxx') {
    if (!FEATURES.adult) return sock.sendMessage(jid, { text: '❌ Adult features disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}xns <query>*` }, { quoted: msg });
    return handleXnxxSearch(sock, msg, args);
  }

  // ── XNXX Download from search ─────────────────────────────────────────────
  if (cmd === 'xnsdl' || cmd === 'xnxxdl') {
    if (!FEATURES.adult) return sock.sendMessage(jid, { text: '❌ Adult features disabled.' });
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}xnsdl <number>*\n\nSearch first: *${PREFIX}xns <term>*` }, { quoted: msg });
    return handleXnxxDl(sock, msg, args);
  }

  // ── Bio ────────────────────────────────────────────────────────────────────
  if (cmd === 'setbio') {
    if (!args) return sock.sendMessage(jid, { text: `Usage: *${PREFIX}setbio <text>*` });
    try {
      await sock.updateProfileStatus(args);
      return sock.sendMessage(jid, { text: `✅ Bio set to:\n"${args}"` }, { quoted: msg });
    } catch (e) {
      return sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` });
    }
  }

  // ── View Once bypass ───────────────────────────────────────────────────────
  if (cmd === 'viewonce' || cmd === 'vo') {
    const val = (args || '').trim().toLowerCase();
    if (val === 'on')  { setViewOnce(true);  return sock.sendMessage(jid, { text: `👀 *View Once bypass:* 🟢 ON\n\nAll view-once photos/videos will be re-sent.` }, { quoted: msg }); }
    if (val === 'off') { setViewOnce(false); return sock.sendMessage(jid, { text: `👀 *View Once bypass:* 🔴 OFF` }, { quoted: msg }); }
    return sock.sendMessage(jid, {
      text: `👀 *View Once bypass:* ${isViewOnceEnabled() ? '🟢 ON' : '🔴 OFF'}\n\n  *${PREFIX}viewonce on*  — re-send all view-once media\n  *${PREFIX}viewonce off* — disable`,
    }, { quoted: msg });
  }

  // ── Anti-Delete ────────────────────────────────────────────────────────────
  if (cmd === 'antidelete' || cmd === 'ad') {
    const val = (args || '').trim().toLowerCase();
    const antiDeleteSession = sessionPhone || sock.user?.phoneNumber || sock.user?.id || sock.user?.lid || '';
    if (val === 'on')  { setAntiDelete(true, antiDeleteSession);  return sock.sendMessage(jid, { text: `🗑️ *Anti-Delete:* 🟢 ON\n\nDeleted messages will be recovered to this paired WhatsApp account.` }, { quoted: msg }); }
    if (val === 'off') { setAntiDelete(false, antiDeleteSession); return sock.sendMessage(jid, { text: `🗑️ *Anti-Delete:* 🔴 OFF` }, { quoted: msg }); }
    return sock.sendMessage(jid, {
      text: `🗑️ *Anti-Delete:* ${isAntiDeleteEnabled(antiDeleteSession) ? '🟢 ON' : '🔴 OFF'}\n\n  *${PREFIX}antidelete on*  — recover deleted messages to this paired account\n  *${PREFIX}antidelete off* — disable`,
    }, { quoted: msg });
  }

  // ── Welcome / Farewell ─────────────────────────────────────────────────────
  if (cmd === 'welcome') {
    const val = (args || '').trim().toLowerCase();
    if (!jid?.endsWith('@g.us')) {
      return sock.sendMessage(jid, {
        text: `❌ Use *${PREFIX}welcome on/off* inside the group where you want it enabled.`,
      }, { quoted: msg });
    }
    if (val === 'on')  {
      setWelcome(jid, true);
      return sock.sendMessage(jid, {
        text: `👋 *Group Welcome/Farewell:* 🟢 ON\n\nThis group will receive join and leave greetings.\nOther groups are unchanged.`,
      }, { quoted: msg });
    }
    if (val === 'off') {
      setWelcome(jid, false);
      return sock.sendMessage(jid, { text: `👋 *Group Welcome/Farewell:* 🔴 OFF for this group.` }, { quoted: msg });
    }
    return sock.sendMessage(jid, {
      text: `👋 *Group Welcome/Farewell:* ${isWelcomeEnabled(jid) ? '🟢 ON' : '🔴 OFF'} for this group\n\n  *${PREFIX}welcome on*  — enable in this group\n  *${PREFIX}welcome off* — disable in this group`,
    }, { quoted: msg });
  }
}

// ── Message Event Handler (per session) ───────────────────────────────────────

// ── Human-like response delay ─────────────────────────────────────────────────
// Human-like reply timing.
// Real people don't read+reply in under a second — they take 1-4 s for short
// messages and longer for anything requiring thought. We model this in three
// tiers so the bot's response cadence is indistinguishable from a real user:
//   · Short (default, for commands)  : 1.2 – 2.8 s
//   · Medium (chatbot quick reply)   : 2.0 – 4.5 s
//   · Long  (chatbot thoughtful)     : 3.5 – 6.0 s
// The typing indicator shown via startTyping() in chatbot.js covers this gap
// so the other party sees "typing…" — exactly what a real person would show.
function humanDelay(tier = 'short') {
  const ranges = {
    short:  [1200, 1600],   // 1.2 – 2.8 s  (commands)
    medium: [2000, 2500],   // 2.0 – 4.5 s  (chatbot)
    long:   [3500, 2500],   // 3.5 – 6.0 s  (chatbot, long reply)
  };
  const [base, spread] = ranges[tier] || ranges.short;
  return new Promise(r => setTimeout(r, base + Math.floor(Math.random() * spread)));
}

// ── Per-chat rate limiter ─────────────────────────────────────────────────────
// Hard-cap bot responses: max BOT_RPM messages per chat per minute.
// Prevents WhatsApp flood-detection from flagging rapid automated replies.
const BOT_RPM = 12;
function makeRateLimiter() {
  const counts = new Map(); // jid → { count, resetAt }
  return function isAllowed(jid) {
    const now  = Date.now();
    const slot = counts.get(jid);
    if (!slot || now > slot.resetAt) {
      counts.set(jid, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (slot.count >= BOT_RPM) return false;
    slot.count++;
    return true;
  };
}

function attachMessageHandler(
  sock,
  onActivity = () => {},
  connectTime = { value: Date.now() },
  phone = '',
  authDir = '',
) {
  // Use the module-level persistent seen map so message IDs survive reconnects.
  // This prevents old commands from firing again after a reconnect without
  // blocking genuine new messages that arrived while the bot was offline.
  const seenMap  = getSeenSet(phone);
  const rateOk   = makeRateLimiter();
  const decryptFailure = {
    count: 0,
    firstAt: 0,
    recoveryInFlight: false,
  };

  // A connected socket can still receive encrypted message envelopes that
  // Baileys cannot decrypt. Previously those messages hit `if (!m) continue`
  // with no diagnostic, leaving the bot looking active but completely silent.
  // Detect a short burst and recycle the socket once instead of letting the
  // session remain deaf indefinitely.
  const DECRYPT_FAILURE_WINDOW_MS = 2 * 60 * 1000;
  const DECRYPT_FAILURE_THRESHOLD = 5;

  async function recoverFromSilentDecryption(reason) {
    if (decryptFailure.recoveryInFlight) return;
    decryptFailure.recoveryInFlight = true;

    const current = sessions.get(phone);
    if (!current || current.sock !== sock || current.status !== 'connected') {
      decryptFailure.recoveryInFlight = false;
      return;
    }

    const callbacks = current.callbacks || {};
    console.warn(`🔐 [${phone}] ${reason} — recycling the WhatsApp socket`);

    try {
      // Remove the old socket before touching auth files. This prevents its
      // close event from scheduling a second reconnect in parallel.
      _teardownSocket(phone);
      await new Promise(resolve => setTimeout(resolve, 1500));

      // A self-saved snapshot is internally consistent and is safer than
      // deleting keys blindly. If none exists, clear only Signal session
      // files so the identity remains paired and can renegotiate keys.
      if (hasSnapshot(phone)) {
        restoreFromSnapshot(phone);
      } else if (authDir) {
        clearSignalSessions(authDir);
      }

      reconnecting.delete(phone);
      await createSession(phone, {
        onPairingCode:  callbacks.onPairingCode  ?? (() => {}),
        onConnected:    callbacks.onConnected    ?? (() => {}),
        onDisconnected: callbacks.onDisconnected ?? (() => {}),
        onError:        callbacks.onError        ?? (() => {}),
      });
    } catch (err) {
      console.error(`❌ [${phone}] Silent-session recovery failed: ${err?.message}`);
      console.error(err?.stack || err);
    }
  }

  function noteUndecryptedMessage(jid, msg) {
    // Receipt/system upserts can have no message body by design. Only count
    // notify events addressed to a real PM/group, which are the messages that
    // should be decryptable and reach the command/chatbot dispatcher.
    const userMessageJid = jid?.endsWith('@g.us') ||
      jid?.endsWith('@s.whatsapp.net') ||
      jid?.endsWith('@c.us') ||
      jid?.endsWith('@lid');
    if (!userMessageJid || !msg?.key?.id) return;

    const now = Date.now();
    if (!decryptFailure.firstAt || now - decryptFailure.firstAt > DECRYPT_FAILURE_WINDOW_MS) {
      decryptFailure.count = 0;
      decryptFailure.firstAt = now;
    }
    decryptFailure.count++;
    console.warn(
      `⚠️  [${phone}] Incoming message has no decrypted payload ` +
      `(#${decryptFailure.count}/${DECRYPT_FAILURE_THRESHOLD}, jid=${jid})`,
    );

    if (decryptFailure.count >= DECRYPT_FAILURE_THRESHOLD) {
      recoverFromSilentDecryption(
        `${decryptFailure.count} undecryptable messages in ${Math.round(DECRYPT_FAILURE_WINDOW_MS / 60000)} minutes`,
      );
    }
  }

  // ── Contact name cache — module-level, persists across reconnects ────────
  // contactNameCache (declared at module scope) is keyed by phone → Map<jid, name>.
  // This means names learned in session N survive the reconnect into session N+1.
  // On each new socket, we register contact-event listeners that top up the cache.

  const cacheContactList = (list) => {
    for (const c of list) {
      if (!c?.id) continue;
      const name = c.name || c.notify || c.verifiedName || c.pushName;
      if (name) {
        for (const id of [c.id, c.phoneNumber, c.lid].filter(Boolean)) {
          storeContactName(phone, id, name);
        }
      }
    }
  };

  sock.ev.on('contacts.upsert', cacheContactList);
  sock.ev.on('contacts.update', cacheContactList);

  // Baileys has emitted remote deletes through more than one event path over
  // time: messages.delete, a protocolMessage(REVOKE) in messages.upsert, and a
  // REVOKE message stub in messages.update/upsert. Keep one recovery callback
  // so each shape uses the same paired-account setting and destination.
  const antiDeleteSession = phone || sock.user?.phoneNumber || sock.user?.id || sock.user?.lid || '';
  const recoverDeleted = (rawKeys) => {
    try {
      const keys = Array.isArray(rawKeys) ? rawKeys : [];
      if (keys.length) handleAntiDelete(sock, keys, antiDeleteSession).catch(error => {
        console.error('[ANTIDELETE] recovery handler error:', error.message);
      });
    } catch (error) {
      console.error('[ANTIDELETE] could not process delete event:', error.message);
    }
  };
  const isRevokeProtocol = (protocol) =>
    protocol?.type === 0 ||
    (typeof protocol?.type === 'string' && protocol.type.toLowerCase() === 'revoke');
  const isRevokeStub = (stubType) =>
    stubType === 1 ||
    (typeof stubType === 'string' && stubType.toUpperCase().includes('REVOKE'));

  /**
   * Return the display name for a JID.
   * Falls back to a formatted phone number (e.g. "+923448127229") rather than
   * the raw JID string, so WA renders something readable even for unknown contacts.
   */
  const getContactName = (jid) => {
    const map  = getOrCreateContactMap(phone);
    const rawIds = typeof jid === 'string'
      ? [jid]
      : [jid?.id, jid?.phoneNumber, jid?.lid, jid?.jid].filter(Boolean);
    for (const raw of rawIds) {
      // Remove only a device suffix; keep the original @lid/@s.whatsapp.net
      // domain so a v7 LID is never accidentally rewritten as a phone JID.
      const at = raw.lastIndexOf('@');
      const normalized = at >= 0
        ? `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`
        : raw.split(':')[0];
      if (map.has(raw)) return map.get(raw);
      if (map.has(normalized)) return map.get(normalized);
      const internal = sock.contacts?.[raw] || sock.contacts?.[normalized];
      if (internal) {
        const name = internal.name || internal.notify || internal.verifiedName;
        if (name) {
          storeContactName(phone, normalized, name);
          return name;
        }
      }
    }
    return null;
  };

  /**
   * Format a JID as a human-readable phone number.
   * Used as fallback when no saved name is found — "+923448127229" is
   * more readable than "923448127229@s.whatsapp.net".
   */
  const jidToPhone = (jid) => `+${jid.split(':')[0].split('@')[0]}`;

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const incoming = messages || [];
    // Process live incoming messages plus status updates included in history
    // sync. Statuses must be handled before the normal decrypted-message checks
    // because Baileys can emit a status key without a message payload.
    const hasStatusUpdate = incoming.some(message => {
      const jid = message.key?.remoteJid;
      return Boolean(jid) && (jid === 'status@broadcast' || isJidStatusBroadcast(jid));
    });
    const hasRevokeUpdate = incoming.some(message =>
      isRevokeProtocol(message.message?.protocolMessage) ||
      isRevokeStub(message.messageStubType),
    );
    if (type !== 'notify' && !hasStatusUpdate && !hasRevokeUpdate) return;

    for (const msg of incoming) {
      try {
        onActivity();   // update last-activity timestamp for watchdog
        const jid = msg.key?.remoteJid || msg.message?.protocolMessage?.key?.remoteJid;
        if (!jid) continue;

        if (jid === 'status@broadcast' || isJidStatusBroadcast(jid)) {
          try {
            await handleAutoStatus(sock, msg);
          } catch (error) {
            console.error('[AutoStatus] handler error:', error.message);
          }
          continue;
        }

        // Check revoke events before history-sync filtering and before the
        // normal protocol-message skip. Some Baileys versions deliver the
        // deleted message key inside the upsert itself.
        const m = msg.message;
        const revokeProtocol = m?.protocolMessage;
        if (isRevokeProtocol(revokeProtocol)) {
          if (revokeProtocol?.key?.id) recoverDeleted([revokeProtocol.key]);
          continue;
        }
        if (isRevokeStub(msg.messageStubType)) {
          if (msg.key?.id) recoverDeleted([msg.key]);
          continue;
        }
        // Ignore history-sync messages except for status updates above.
        if (type !== 'notify') continue;

        // Skip protocol/system messages that carry no user content
        // (e.g. read-receipts, key updates, revoke notices) — these have
        // msg.message=null or only a protocolMessage/senderKeyDistributionMessage.
        if (!m) {
          noteUndecryptedMessage(jid, msg);
          continue;
        }
        // A successfully decrypted message proves the Signal state is usable.
        decryptFailure.count = 0;
        decryptFailure.firstAt = 0;
        const isProtocol = !!(m.protocolMessage || m.senderKeyDistributionMessage ||
                               m.senderKeyDistributionMessage || m.reactionMessage ||
                               m.messageHistoryBundle);
        if (isProtocol && !m.conversation && !m.extendedTextMessage &&
            !m.imageMessage && !m.videoMessage && !m.audioMessage &&
            !m.documentMessage && !m.stickerMessage && !m.ephemeralMessage &&
            !m.viewOnceMessage && !m.viewOnceMessageV2 && !m.editedMessage &&
            !m.documentWithCaptionMessage) continue;

        if (isJidBroadcast(jid)) continue;

        // ── Replay guard (persists across reconnects) ────────────────────────
        // seenMap survives bot reconnects so already-processed message IDs are
        // remembered — prevents commands from firing again after a disconnect.
        const msgId = msg.key.id;
        if (msgId) {
          if (seenMap.has(msgId)) continue;
          seenMap.set(msgId, Date.now());
          // Prune stale IDs every ~500 new entries to keep RAM bounded
          if (seenMap.size % 500 === 0) pruneSeenSet(seenMap);
        }

        const fromMe = msg.key.fromMe;
        const sender = fromMe ? (sock.user?.id || jid) : (msg.key.participant || jid);
        const body  = getBody(msg) || '';
        const isCmd  = body.startsWith(PREFIX);
        const rawCmd = isCmd ? body.slice(PREFIX.length).split(/\s+/)[0] : '';
        const cmd    = rawCmd.toLowerCase();
        const args   = isCmd ? body.slice(PREFIX.length + rawCmd.length).trim() : '';

        // Remove watched members' text and media before other automations can
        // react to or process the content. Admin moderation commands stay usable.
        if (!fromMe && jid.endsWith('@g.us') && isWatchedGroupMessage(jid, msg)) {
          const moderationCommand = isCmd && ['unban', 'banlist'].includes(cmd);
          if (!moderationCommand) {
            await deleteWatchedMessage(sock, msg);
            continue;
          }
        }

        // Cache pushName from every incoming message so group-event handlers
        // (promote/demote/welcome) can resolve display names even for contacts
        // that haven't been synced via contacts.upsert yet.
        if (msg.pushName && sender && !fromMe) {
          for (const senderId of [sender, msg.key?.participantAlt, msg.key?.remoteJidAlt].filter(Boolean)) {
            storeContactName(phone, senderId, msg.pushName);
          }
        }

        // Cache messages for anti-delete ONLY when the feature is enabled.
        // Eager media downloads (images, audio) are skipped when off, saving
        // significant RAM on low-memory servers.
        // NOTE: cacheIncomingMessage is synchronous — do NOT call .catch() on it.
        const antiDeleteSession = phone || sock.user?.phoneNumber || sock.user?.id || sock.user?.lid || '';
        if (isAntiDeleteEnabled(antiDeleteSession)) {
          try { cacheIncomingMessage(msg, antiDeleteSession); } catch {}
        }

        // Each of these is a self-contained feature unrelated to the
        // chatbot/command dispatch below. They must NEVER be able to throw
        // and abort processing of the message — a transient error in one
        // (e.g. group-metadata fetch failing) used to silently drop the
        // whole message before the chatbot ever got a chance to reply.
        if (!fromMe) {
          try { handleAutoTyping(sock, msg); } catch (e) { console.error('[AutoTyping] error:', e.message); }
        }
        if (!fromMe) {
          try { await handleAutoReact(sock, msg, PREFIX); } catch (e) { console.error('[AutoReact] error:', e.message); }
        }

        // View-once bypass — re-send media without the restriction
        if (!fromMe) {
          const captured = await handleViewOnce(sock, msg).catch((e) => { console.error('[ViewOnce] error:', e.message); return false; });
          if (captured) continue;
        }

        if (!body) continue;

        const hasImg = !!(
          msg.message?.imageMessage ||
          msg.message?.viewOnceMessage?.message?.imageMessage
        );

        if (DEBUG) console.log(`[${sock.user?.id?.split(':')[0]}] cmd="${cmd}" args="${args.slice(0,40)}"`);

        // "Message yourself" (self-chat) is the standard way an owner tests
        // the bot — its JID is just their own number, identical to sock.user.id.
        // Without this check, `fromMe && !isCmd` below silently ate every
        // plain-text self-chat message, making the chatbot look broken during
        // testing even though it would work fine for real contacts. We still
        // must NOT let this loosen the guard for the owner's outgoing messages
        // in *other* PMs/groups — that would spam their real conversations
        // with unsolicited AI replies.
        const ownBareNum = (sock.user?.id || '').split(':')[0].split('@')[0];
        const jidBareNum = jid.split('@')[0];
        const isSelfChat = fromMe && ownBareNum && jidBareNum === ownBareNum;

        if (fromMe && !isCmd && !isSelfChat) continue;

        if (!fromMe && jid.endsWith('@g.us')) {
          try {
            const removed = await handleAntilink(sock, msg, body, OWNER_NUMBER);
            if (removed) continue;
            const removedCh = await handleAntichannel(sock, msg, body, OWNER_NUMBER);
            if (removedCh) continue;
          } catch (e) {
            console.error('[Antilink/Antichannel] error:', e.message);
          }
        }

        if (isCmd && cmd) {
          // Rate-limit + human delay — prevents flood detection and removes
          // the sub-100ms mechanical response pattern that flags bots.
          if (!rateOk(jid)) continue;
          await humanDelay();
          await handleCommand(sock, msg, jid, sender, fromMe, cmd, args, hasImg, phone);
        } else if (!isCmd && (!fromMe || isSelfChat)) {
          const isGroup   = jid.endsWith('@g.us');
          // @c.us is WhatsApp Business account JID format — treat same as PM
          const isPm      = jid.endsWith('@s.whatsapp.net') ||
            jid.endsWith('@c.us') || jid.endsWith('@lid');
          const chatbotOn = (isPm && isChatbotPmEnabled()) || (isGroup && isChatbotGroupEnabled());
          let handled = false;
          if (chatbotOn) {
            if (!rateOk(jid)) continue;
            await humanDelay('medium'); // chatbot: read msg + start thinking delay
            handled = await handleChatbot(sock, msg, body, sock.user?.id || '');
          }
          if (!handled) {
            const reply = findAutoreply(body, BOT_NAME);
            if (reply) {
              if (!rateOk(jid)) continue;
              await humanDelay();
              await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            }
          }
        }
      } catch (err) {
        // Always log the stack — DEBUG being off in production was hiding the
        // real cause of "chatbot on but no reply" reports (errors were only
        // ever printed as a one-line message, never the stack).
        console.error('❌ Message error:', err.message);
        console.error(err.stack);
      }
    }
  });

  // ── Group welcome / farewell ──────────────────────────────────────────────
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'add' || action === 'remove') {
      try {
        await handleGroupWelcome(sock, id, participants, action, getContactName);
      } catch (err) {
        console.warn(`⚠️  welcome event failed: ${err.message}`);
      }
      return;
    }
  });

  // ── Group participant promote / demote notifications ─────────────────────
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action !== 'promote' && action !== 'demote') return;
    try {
      // Build the mention JID list
      const mention = participants.map(p => {
        // Keep @lid identifiers intact; converting them to @s.whatsapp.net
        // makes admin-change mentions fail on newer WhatsApp accounts.
        return p.includes('@') ? p : `${p}@s.whatsapp.net`;
      });

      // When the name is known: use "@number" so WA renders the person's
      // saved display name for all group members (same logic as welcome.js).
      // When unknown: use plain "*+number*" — avoids the "@+1 XXXXXXXXXX"
      // clutter that WA generates when rendering an @mention of an unknown contact.
      const parts = participants.map((p, i) => {
        const name = getContactName(p);
        const num  = mention[i].split('@')[0];
        return name
          ? { tag: `@${num}`,   mJid: mention[i] }
          : { tag: `*+${num}*`, mJid: mention[i] };
      });
      const nameList   = parts.map(x => x.tag).join(', ');
      const mentionArr = parts.map(x => x.mJid);

      let text;
      if (action === 'promote') {
        text =
          `╭━━━〔 👑 *ADMIN UPDATE* 〕━━━╮\n` +
          `┃ 🎉 Congratulations ${nameList}!\n` +
          `┃ ✨ You are now a *group admin*.\n` +
          `┃\n` +
          `┃ 💫 Welcome to the admin team!\n` +
          `┃ _Use your powers wisely._\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯`;
      } else {
        text =
          `╭━━━〔 📋 *ROLE UPDATE* 〕━━━╮\n` +
          `┃ 👤 ${nameList}\n` +
          `┃ is no longer a *group admin*.\n` +
          `┃\n` +
          `┃ 🙏 _Thanks for your service!_\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯`;
      }

      await sock.sendMessage(id, { text, mentions: mentionArr });
    } catch (err) {
      console.warn(`⚠️  promote/demote notification failed: ${err.message}`);
    }
  });

  // ── Anti-Delete: recover messages when someone deletes them ─────────────
  sock.ev.on('messages.delete', (item) => {
    const keys = Array.isArray(item)
      ? item
      : Array.isArray(item?.keys)
      ? item.keys
      : item?.key ? [item.key]
      : item?.id ? [item]
      : [];
    recoverDeleted(keys);
  });

  sock.ev.on('messages.update', (updates) => {
    const items = Array.isArray(updates) ? updates : updates ? [updates] : [];
    for (const update of items) {
      const protocol = update?.update?.message?.protocolMessage ||
        update?.update?.protocolMessage ||
        update?.message?.protocolMessage;
      if (isRevokeProtocol(protocol) && protocol?.key?.id) {
        recoverDeleted([protocol.key]);
        continue;
      }
      const stubType = update?.update?.messageStubType ??
        update?.update?.message?.messageStubType ??
        update?.messageStubType;
      if (isRevokeStub(stubType) && update?.key?.id) recoverDeleted([update.key]);
    }
  });
}

// ── Welcome Message ────────────────────────────────────────────────────────────

async function sendWelcomeMessage(sock, phone) {
  const jid = `${phone}@s.whatsapp.net`;
  try {
    const botImageUrl = process.env.BOT_IMAGE_URL || '';
    const welcomeText =
      `👑 *Welcome to ${BOT_NAME}!*\n\n` +
      `✅ Your WhatsApp is now connected to the bot.\n\n` +
      `📋 *Quick start:*\n` +
      `  • Send *${PREFIX}help* — see all commands\n` +
      `  • Send *${PREFIX}ping* — check if bot is alive\n` +
      `  • Send *${PREFIX}ai hello* — chat with AI\n\n` +
      `🔐 *Mode:* ${BOT_PUBLIC ? '🌍 Public (all commands open)' : '🔒 Private (restricted)'}\n\n` +
      `_♡ Powered by ${BOT_NAME}_`;

    if (botImageUrl) {
      const res = await axios.get(botImageUrl, { responseType: 'arraybuffer', timeout: 10_000 });
      await sock.sendMessage(jid, { image: Buffer.from(res.data), caption: welcomeText });
    } else {
      await sock.sendMessage(jid, { text: welcomeText });
    }
  } catch (err) {
    console.warn(`⚠️  Could not send welcome to ${phone}: ${err.message}`);
  }
}

// ── Session Factory ────────────────────────────────────────────────────────────

export async function createSession(phone, {
  onPairingCode  = () => {},
  onConnected    = () => {},
  onDisconnected = () => {},
  onError        = () => {},
} = {}) {

  if (sessions.has(phone) && isSessionActive(phone)) {
    throw new Error(`Session for ${phone} is already active.`);
  }

  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Maximum sessions reached (${MAX_SESSIONS}). Remove a session first.`);
  }

  // Every new pairing/reconnect gets a new generation. A delayed reconnect
  // from an older generation must never be allowed to recreate an unpaired
  // session after the user has run /unpair.
  const generation = (sessionGeneration.get(phone) || 0) + 1;
  sessionGeneration.set(phone, generation);
  intentionalStop.delete(phone);

  const authDir = join(AUTH_BASE, phone);
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

  // NOTE: signal sessions and pre-keys are NOT cleared here anymore.
  // Clearing them on every connect was forcing WA to renegotiate encryption for
  // every contact on each reconnect → flood of requests → WA disconnects → loop.
  // They are still cleared reactively when a Bad MAC error is actually detected.

  // ── Incomplete auth state detection ──────────────────────────────────────────
  // When a user copies ONLY creds.json to a new server (without the Signal key
  // files — pre-key-*.json, session-*.json, sender-key-*.json) the bot connects
  // and can SEND messages but cannot DECRYPT any incoming message.  The message
  // handler gets msg.message = null on every incoming message and silently drops
  // it with `continue`.  The bot appears alive (sends welcome, ping succeeds) but
  // never responds to any command.
  //
  // Detection: if creds.json says registered=true but no pre-key-*.json files
  // exist, the Signal key state is incomplete.  The only reliable fix is a fresh
  // pair — we delete the partial auth and restart the session as unregistered.
  {
    const authFiles = readdirSync(authDir);
    const hasPreKeys = authFiles.some(f => /^pre-key-\d+\.json$/.test(f));
    let credsRegistered    = false;
    let serverHasPreKeys   = false;
    try {
      const raw = JSON.parse(readFileSync(join(authDir, 'creds.json'), 'utf8'));
      credsRegistered  = !!raw.registered;
      // Baileys sets serverHasPreKeys=true only AFTER successfully uploading pre-keys
      // to WhatsApp during a real connection.  A creds.json that was manually copied
      // from another server will have this flag set because pre-keys were uploaded from
      // that other machine.  But this machine has no local pre-key files → broken.
      // A creds.json created by a fresh pairing that hasn't reconnected yet will have
      // serverHasPreKeys=false (pre-keys not uploaded yet) → totally normal, do not delete.
      serverHasPreKeys = !!raw.serverHasPreKeys;
    } catch {}

    if (credsRegistered && !hasPreKeys) {
      if (serverHasPreKeys) {
        // serverHasPreKeys=true  +  no local pre-key files
        // This happens in two scenarios:
        //   a) creds.json copied from another server without the full auth folder
        //   b) Session ran for days, pre-keys were consumed/corrupted, bot stopped responding
        //
        // RECOVERY instead of fresh pair:
        //   - Reset serverHasPreKeys=false so Baileys re-uploads new pre-keys on reconnect
        //   - Clear only Signal session/key files (keep identity: noiseKey, account, me, etc.)
        //   - Baileys reconnects and uploads 100 fresh pre-keys → bot works again
        //   - No re-pairing needed — the WhatsApp account stays linked
        console.warn(`⚠️  [${phone}] Incomplete Signal state detected (serverHasPreKeys=true but no local pre-key files).`);

        // Best option: an internal last-known-good snapshot is a FULL, self-
        // consistent auth folder (creds + all Signal keys) captured while the
        // bot was actually connected & healthy. Restoring it beats patching
        // creds.json in place, since it can't leave a half-consistent state.
        if (hasSnapshot(phone) && restoreFromSnapshot(phone)) {
          console.log(`✅ [${phone}] Recovered using internal last-known-good snapshot. Reconnecting...`);
        } else {
          console.warn(`   No internal snapshot available yet — resetting pre-keys without a fresh pair...`);
          try {
            const raw = JSON.parse(readFileSync(join(authDir, 'creds.json'), 'utf8'));
            raw.serverHasPreKeys = false;
            writeFileSync(join(authDir, 'creds.json'), JSON.stringify(raw));
          } catch (e) {
            console.warn(`   ⚠️  Could not patch creds.json: ${e.message}`);
          }
          // Delete only Signal session/key files — identity and account info stays intact
          const signalFiles = readdirSync(authDir).filter(f =>
            /^pre-key-\d+\.json$/.test(f)        ||
            /^session-.+\.json$/.test(f)          ||
            /^sender-key-.+\.json$/.test(f)       ||
            /^app-state-sync-key-.+\.json$/.test(f)
          );
          for (const f of signalFiles) {
            try { unlinkSync(join(authDir, f)); } catch {}
          }
          console.log(`✅ [${phone}] Recovery complete — cleared ${signalFiles.length} Signal file(s). Reconnecting...`);
        }
        onDisconnected(phone, 'session_recovered');
      } else {
        // serverHasPreKeys=false  +  no local pre-key files
        // → Fresh pairing that hasn't completed its first reconnect yet.
        //   WhatsApp sends 515 right after the pairing code is accepted; pre-keys are
        //   uploaded during the reconnect that follows.  Let Baileys proceed normally.
        console.log(`ℹ️  [${phone}] creds.json present, serverHasPreKeys=false — fresh pairing reconnect. Proceeding.`);
      }
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version              = await getBaileysVersion();

  // ── Per-session logger that detects Bad MAC errors ──────────────────────────
  const sessionLogger = logger.child({ session: phone });
  const _origWarn     = sessionLogger.warn.bind(sessionLogger);
  const _origError    = sessionLogger.error.bind(sessionLogger);
  const _checkMac     = (obj) => {
    const msg = typeof obj === 'string' ? obj
      : (obj?.err?.message || obj?.message || JSON.stringify(obj) || '');
    if (/bad.?mac/i.test(msg)) {
      const count = trackBadMac(phone);
      console.warn(`⚠️  [${phone}] Bad MAC #${count} — ${msg.slice(0, 80)}`);
      if (count >= BAD_MAC_THRESHOLD) {
        badMacCount.delete(phone);
        // Prefer restoring the internal last-known-good snapshot over just
        // deleting session files — a full snapshot restore resets to a state
        // that was actually confirmed working, giving a much higher chance
        // of recovery than hoping in-place renegotiation succeeds.
        if (hasSnapshot(phone) && restoreFromSnapshot(phone)) {
          console.warn(`🔑 [${phone}] Bad MAC limit hit — restored last-known-good snapshot & reconnecting`);
        } else {
          console.warn(`🔑 [${phone}] Bad MAC limit hit — no snapshot available, clearing signal sessions & reconnecting`);
          clearSignalSessions(authDir);
        }
        if (!reconnecting.has(phone)) {
          reconnecting.add(phone);
          setTimeout(() => {
            reconnecting.delete(phone);
            sessions.delete(phone);
            try { sock.ev.removeAllListeners(); } catch {}
            try { sock.end(); } catch {}
            createSession(phone, { onPairingCode, onConnected, onDisconnected, onError })
              .catch(onError);
          }, 4000);
        }
      }
    }
  };
  sessionLogger.warn  = (obj, ...a) => { _checkMac(obj); return _origWarn(obj, ...a); };
  sessionLogger.error = (obj, ...a) => { _checkMac(obj); return _origError(obj, ...a); };

  const sock = makeWASocket({
    version,
    logger: sessionLogger,
    printQRInTerminal:              false,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    // macOS/Chrome fingerprint — avoids the stale Ubuntu signature rejected
    // by newer WhatsApp Web handshakes.
    // signature and causes forcible disconnects every few hours.
    browser:                        Browsers.macOS('Chrome'),
    generateHighQualityLinkPreview: false,          // saves bandwidth + less traffic scrutiny
    connectTimeoutMs:               60_000,
    defaultQueryTimeoutMs:          60_000,
    // Jitter the keepAlive interval 22-28 s — a perfectly regular heartbeat
    // is a bot signal; slight randomness looks more like a real device.
    keepAliveIntervalMs:            22_000 + Math.floor(Math.random() * 6_000),
    retryRequestDelayMs:            2_000,
    maxMsgRetryCount:               2,          // 5 retries × Bad MAC = retry storm; 2 is enough
    syncFullHistory:                false,           // faster reconnect + less history exposure
    fireInitQueries:                true,
    emitOwnEvents:                  true,   // must be true so owner's own commands are received
    // Return undefined so Baileys knows message is not cached (stops retry loops)
    getMessage: async () => undefined,
    // Do NOT mark presence as online automatically — avoids "always online" bot signal
    markOnlineOnConnect:            false,
  });

  // Catch raw WebSocket errors — prevents unhandled rejection crashes
  sock.ws.on('error', (err) => {
    console.warn(`[WS-ERROR] [${phone}] ${err?.message || err}`);
  });

  const entry = {
    sock,
    phone,
    status:    'connecting',
    jid:       '',
    createdAt: Date.now(),
    retries:   0,
    callbacks: { onPairingCode, onConnected, onDisconnected, onError },
  };
  sessions.set(phone, entry);

  // Shared ref so attachMessageHandler can skip messages sent before this
  // session connected (prevents replaying old commands on reconnect).
  const connectTime = { value: Date.now() };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connectTime.value = Date.now(); // stamp the exact moment WA says "open"
      entry.status  = 'connected';
      entry.jid     = sock.user?.id || '';
      entry.retries = 0;
      reconnecting.delete(phone);
      connectTimes.set(phone, Date.now());
      console.log(`✅ [${phone}] Connected as ${entry.jid}`);
      try {
        restoreTimedGroupMutes(sock);
      } catch (error) {
        console.warn(`[GroupModeration] Could not restore timed mutes: ${error.message}`);
      }
      applyBotCustomization(sock).catch(() => {});
      onConnected(entry.jid);

      // Only send welcome on the very first connect, not on every reconnect
      if (!welcomedPhones.has(phone)) {
        welcomedPhones.add(phone);
        setTimeout(() => sendWelcomeMessage(sock, phone), 4000);
      }

      // Reset backoff only after 5 MINUTES of stable connection.
      // 30s was too short — a code-500 that reconnects briefly before failing again
      // would reset the counter and start the backoff from scratch, causing the
      // 87-disconnect-per-8-hours loop where every reconnect looked like attempt #1.
      setTimeout(() => {
        if (sessions.get(phone)?.status === 'connected') {
          retryCount.delete(phone);
          console.log(`✅ [${phone}] Connection stable (5 min) — backoff counter reset`);
        }
      }, 300_000);

      // ── Auto-snapshot the auth folder once the session is confirmed healthy ──
      // Waiting 3 minutes ensures the connection is genuinely stable (not a
      // fresh-pairing 515 blip) and that Baileys has finished uploading its
      // pre-key batch, so the snapshot captures a fully self-contained,
      // working set of creds + Signal keys — not a half-registered state.
      // Re-snapshotting every 6h afterward keeps it fresh as the Signal
      // ratchet advances, so a restore always lands close to "now" instead
      // of reusing a stale manual backup from days/weeks ago.
      if (entry._snapshotInterval) clearInterval(entry._snapshotInterval);
      setTimeout(() => {
        if (sessions.get(phone)?.status !== 'connected') return;
        if (snapshotAuthDir(phone)) {
          console.log(`💾 [${phone}] Auto-saved internal auth snapshot (self-heal backup)`);
        }
        entry._snapshotInterval = setInterval(() => {
          if (sessions.get(phone)?.status === 'connected') snapshotAuthDir(phone);
        }, 6 * 60 * 60 * 1000);
        if (entry._snapshotInterval.unref) entry._snapshotInterval.unref();
      }, 3 * 60 * 1000);
    }

    if (connection === 'close') {
      const err        = lastDisconnect?.error;
      const statusCode = new Boom(err)?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;
      const replaced   = statusCode === DisconnectReason.connectionReplaced;
      const forbidden  = statusCode === 403;

      entry.status = 'disconnected';
      if (entry._watchdog)         { clearInterval(entry._watchdog); entry._watchdog = null; }
      if (entry._proactiveRefresh) { clearTimeout(entry._proactiveRefresh); entry._proactiveRefresh = null; }
      if (entry._snapshotInterval) { clearInterval(entry._snapshotInterval); entry._snapshotInterval = null; }

      // Intentional stop (unpair / stopSession called) — do NOT reconnect
      if (intentionalStop.has(phone)) {
        intentionalStop.delete(phone);
        sessions.delete(phone);
        console.log(`🛑 [${phone}] Session stopped intentionally — no reconnect.`);
        return;
      }

      if (loggedOut) {
        // Credentials invalid — do NOT reconnect, user must re-pair.
        // CRITICAL: delete the auth folder so the next process restart knows to
        // request a fresh pairing code instead of loading the stale creds.json,
        // getting instantly logged-out again, and appearing "active" but dead.
        console.log(`🔴 [${phone}] Logged out — removing session and auth files.`);
        try { rmSync(authDir, { recursive: true, force: true }); } catch {}
        sessions.delete(phone);
        clearSessionRuntime(phone);
        welcomedPhones.delete(phone);
        onDisconnected(phone, 'logged_out');
      } else if (replaced) {
        // Another device connected — do NOT reconnect, would cause loop
        console.log(`🔴 [${phone}] Connection replaced by another device.`);
        sessions.delete(phone);
        clearSessionRuntime(phone);
        welcomedPhones.delete(phone);
        onDisconnected(phone, 'replaced');
      } else if (forbidden) {
        // 403 is a rejected/invalid linked-device session. Retrying the same
        // auth forever only creates the reconnect storm shown in Pterodactyl.
        // Remove it and require a clean /pair instead.
        console.warn(`🔴 [${phone}] WhatsApp rejected the saved session (403); stopping and requiring a fresh pair.`);
        try { rmSync(authDir, { recursive: true, force: true }); } catch {}
        sessions.delete(phone);
        clearSessionRuntime(phone);
        welcomedPhones.delete(phone);
        onDisconnected(phone, 'forbidden');
      } else if (statusCode === 405 && !sock.authState.creds.registered) {
        // A 405 before registration is a handshake rejection, not a normal
        // disconnect. Stop cleanly so the user can begin one fresh pairing.
        console.warn(`🔴 [${phone}] WhatsApp rejected the unregistered pairing handshake (405); stopping without another code.`);
        try { rmSync(authDir, { recursive: true, force: true }); } catch {}
        sessions.delete(phone);
        reconnecting.delete(phone);
        retryCount.delete(phone);
        onDisconnected(phone, 'pairing_failed');
      } else {
        // Temporary disconnect — reconnect with increasing backoff
        if (reconnecting.has(phone)) return; // already scheduled, skip duplicate
        reconnecting.add(phone);

        const attempts = (retryCount.get(phone) || 0) + 1;
        retryCount.set(phone, attempts);

        // Detect rapid disconnect: if we were only connected < 10s, use aggressive backoff
        const lastConnect   = connectTimes.get(phone) || 0;
        const rapidDisconnect = lastConnect && (Date.now() - lastConnect) < 10_000;

        const hasEverConnected = connectTimes.has(phone);

        // ── Delay calculation ────────────────────────────────────────────────
        // Three categories with different timing needs:
        //
        // A) Fresh pairing (never connected before) + stream error (515 etc.)
        //    The pairing credentials are valid only briefly after the user scans.
        //    Waiting 60s means the credentials expire and WA sends 401 on reconnect.
        //    Use a SHORT retry (5s) so we reconnect before they expire.
        //    After 3 failed attempts without ever connecting: give up & ask re-pair.
        //
        // B) Established session + stream error (500/428/503/515)
        //    60s minimum prevents hammering WA servers during their-side failures.
        //
        // C) Normal disconnect (not a stream error)
        //    Exponential backoff: 5s/7.5s/11s … capped at 60s.

        // 408 = Request Timeout, 428 = Precondition Required, 500/503 = WA server
        // errors, 515 = Stream Errored.  All of these on a fresh pairing need a
        // fast retry (5 s) instead of the normal 60 s min-delay — the credential
        // window is short and a 60 s wait consistently causes the session to expire,
        // leading to a 401 (Logged Out) on the first reconnect attempt.
        const streamError = [405, 408, 428, 500, 503, 515].includes(statusCode);

        // freshPairingErr: 515/stream error while creds are not yet registered.
        // Used ONLY for the max-retries / deletion decision.
        // Do NOT use this for the delay decision — it misses the post-pairing 515 case
        // where registered=true (pairing was accepted) but we still need a fast reconnect.
        const freshPairingErr = streamError && !sock.authState.creds.registered;

        // needsFastRetry: use a short 5s delay when we haven't had a STABLE
        // connection for this phone yet.  Covers two cases:
        //   1. Fresh pairing: code accepted, WhatsApp sends 515 to trigger reconnect.
        //      registered=true in memory but a 60s delay lets WA expire the session
        //      → 401 Logged Out on reconnect.  Must reconnect within ~10s.
        //   2. Bot restart with valid creds: first attempt gets 515 from WA.
        //      A fast retry is fine and gets the bot online faster.
        //
        // IMPORTANT: WhatsApp briefly fires connection='open' at the moment a
        // pairing code is accepted (before sending the 515 reset), which stamps
        // connectTimes and makes hasEverConnected=true even though we never had
        // a stable session.  We use a 30s window: if the last open event was
        // < 30s ago we still treat this as a fresh-pairing fast retry.
        const msSinceConnect  = lastConnect ? (Date.now() - lastConnect) : Infinity;
        const needsFastRetry  = streamError && (!hasEverConnected || msSinceConnect < 30_000);

        // Give up on a fresh pairing after MAX_PAIR_RETRIES quick retries
        const MAX_PAIR_RETRIES = 3;
        if (freshPairingErr && attempts > MAX_PAIR_RETRIES) {
          // Too many retries without ever opening — credentials likely expired.
          // Delete auth so next /pair starts completely fresh.
          console.warn(`🔴 [${phone}] Pairing failed after ${attempts} attempts — deleting auth & requiring re-pair`);
          try { rmSync(authDir, { recursive: true, force: true }); } catch {}
          sessions.delete(phone);
          clearSessionRuntime(phone);
          welcomedPhones.delete(phone);
          onDisconnected(phone, 'pairing_failed');
          onError(new Error(`Pairing failed (code ${statusCode}) — run /pair again`));
          return;
        }

        let delay;
        if (needsFastRetry) {
          // Quick retry — stay within WhatsApp's credential validity window
          delay = 5_000 + Math.floor(Math.random() * 2000);
        } else if (streamError) {
          // Established session stream error — back off properly
          const base = rapidDisconnect
            ? Math.min(15_000 * Math.pow(2, attempts - 1), 300_000)
            : Math.min(5_000  * Math.pow(1.5, attempts - 1), 60_000);
          delay = Math.round(Math.max(base + Math.floor(Math.random() * 5000), 60_000));
        } else {
          // Normal disconnect — standard exponential backoff
          const base = rapidDisconnect
            ? Math.min(15_000 * Math.pow(2, attempts - 1), 300_000)
            : Math.min(5_000  * Math.pow(1.5, attempts - 1), 60_000);
          delay = Math.round(base + Math.floor(Math.random() * 3000));
        }

        const dcReason = err?.message || DisconnectReason[statusCode] || 'connection closed';
        logDisconnect(phone, statusCode, dcReason);
        console.log(`⚠️  [${phone}] Disconnected [${statusCode}]${freshPairingErr ? ' (fresh-pair)' : rapidDisconnect ? ' (rapid)' : ''} — attempt ${attempts}, retry in ${(delay/1000).toFixed(1)}s`);

        // Clear signal sessions ONLY on errors that genuinely indicate corrupted
        // Signal keys (Bad MAC / decryption failure cascade).
        //
        // ✅ 500 / 503 — WA internal error, often accompanies Bad MAC storms
        // ✅ 515 — Stream Error, can mean key mismatch at protocol level
        //
        // ❌ 408 — Request Timeout: network/server slowness, keys are fine.
        //          Clearing here forces re-keying of all group sessions on every
        //          timeout reconnect, which ITSELF triggers more 428/408 errors
        //          (feedback loop that caused the 4-5 h disconnect cycle).
        // ❌ 428 — Precondition Required: WA server-side rate limit, keys are fine.
        const signalClearCodes = [500, 503, 515];
        if (signalClearCodes.includes(statusCode) && hasEverConnected) {
          clearSignalSessions(authDir);
        }

        const reconnectGeneration = sessionGeneration.get(phone) || 0;
        const reconnectTimer = setTimeout(() => {
          reconnectTimers.delete(phone);

          // /unpair or a newer /pair invalidated this delayed reconnect.
          if (sessionGeneration.get(phone) !== reconnectGeneration) {
            reconnecting.delete(phone);
            return;
          }

          reconnecting.delete(phone);
          sessions.delete(phone);

          // CRITICAL: remove all listeners BEFORE sock.end() so the old socket
          // cannot fire another connection.update('close') and schedule a second
          // parallel reconnect — that is what causes the code-500 loop.
          try { sock.ev.removeAllListeners(); } catch {}
          try { sock.end(); } catch {}

          // Wrap in try-catch so an exception in ONE session's reconnect
          // never propagates to the global event loop and crashes other sessions.
          try {
            createSession(phone, { onPairingCode, onConnected, onDisconnected, onError })
              .catch(err => {
                console.error(`❌ [${phone}] Reconnect failed: ${err?.message}`);
                onError(err);
              });
          } catch (err) {
            console.error(`❌ [${phone}] createSession threw synchronously: ${err?.message}`);
          }
        }, delay);
        reconnectTimers.set(phone, reconnectTimer);
        onDisconnected(phone, statusCode);
      }
    }
  });

  if (!sock.authState.creds.registered) {
    entry.status = 'waiting_code';
    await new Promise(r => setTimeout(r, 3000));
    try {
      const raw  = await sock.requestPairingCode(phone);
      const code = raw.match(/.{1,4}/g)?.join('-') ?? raw;
      console.log(`🔑 [${phone}] Pairing code: ${code}`);
      onPairingCode(code);
    } catch (err) {
      console.error(`❌ [${phone}] Pairing code error: ${err.message}`);
      sessions.delete(phone);
      onError(err);
      return;
    }
  } else {
    console.log(`♻️  [${phone}] Restoring existing session...`);
    // Pre-clear any corrupted signal sessions that would cause Bad MAC on startup
    badMacCount.delete(phone);
  }

  // ── Watchdog: detect zombie connections (connected but WA stopped delivering) ──
  //
  // There are TWO distinct zombie scenarios we must handle:
  //
  // A) Socket-level zombie — fetchStatus() FAILS (timeout / error)
  //    → WA server is unreachable on this socket → force reconnect after 2 fails
  //
  // B) Delivery zombie — fetchStatus() PASSES but messages stopped arriving
  //    This is the SILENT killer: WA's status server still responds, so the ping
  //    always looks healthy.  But WA has stopped routing new messages to this
  //    linked device.  The bot shows as "active" but processes nothing.
  //    Detection: track lastMessageMs (only updated by real message delivery,
  //    never by pings).  If no real message in MAX_MSG_SILENCE_MS despite
  //    successful pings, force a reconnect.
  //
  // Note: lastActivityMs IS reset by successful pings (to keep the idle-gate
  //       from firing constantly), but lastMessageMs is NOT.

  entry.lastActivityMs  = Date.now();
  entry.lastMessageMs   = Date.now(); // updated ONLY by real message delivery
  let _pingFails = 0;

  // NOTE: We intentionally do NOT use a message-silence timer to detect
  // delivery zombies.  Any fixed silence window causes false positives on
  // quiet groups (e.g. overnight) and triggers a reconnect → 428 → signal-
  // clear → more instability.  The two reliable defences are:
  //   A) Ping failure detection (scenario A below)
  //   B) Proactive 8-hour refresh (schedules a clean reconnect)
  // Together these cap the maximum zombie duration at ~8 h while never
  // forcing unnecessary reconnects on legitimate quiet periods.

  async function _roundTripPing() {
    // fetchStatus requires WA to actually respond — fire-and-forget presence does not.
    // Race against a 15s timeout so a hung socket is caught quickly.
    const timeoutMs = 15_000;
    await Promise.race([
      sock.fetchStatus(sock.user?.id || `${phone}@s.whatsapp.net`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), timeoutMs)
      ),
    ]);
  }

  function _forceReconnect(reason) {
    if (reconnecting.has(phone)) return;
    console.warn(`🔄 [${phone}] Watchdog: forcing reconnect — ${reason}`);
    clearInterval(entry._watchdog); entry._watchdog = null;
    entry.status = 'disconnected';
    reconnecting.add(phone);
    const attempts = (retryCount.get(phone) || 0) + 1;
    retryCount.set(phone, attempts);
    setTimeout(() => {
      reconnecting.delete(phone); sessions.delete(phone);
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.end(); } catch {}
      createSession(phone, { onPairingCode, onConnected, onDisconnected, onError }).catch(onError);
    }, 5000);
  }

  entry._watchdog = setInterval(async () => {
    const s = sessions.get(phone);
    if (!s || s.sock !== sock || s._watchdog == null) { clearInterval(entry._watchdog); return; }
    if (s.status !== 'connected') return;

    const idleMins = (Date.now() - (s.lastActivityMs || Date.now())) / 60_000;

    // Ping after 20 minutes idle. 10 min was too aggressive — frequent fetchStatus
    // queries triggered WA anti-bot detection causing extra Code 500/428 disconnects.
    // 20 min still catches zombies well within 1 hour.
    if (idleMins < 20) { _pingFails = 0; return; }

    console.log(`🔍 [${phone}] Watchdog: idle ${idleMins.toFixed(0)}min — round-trip pinging WA (fail#${_pingFails})`);
    try {
      await _roundTripPing();
      _pingFails = 0;
      s.lastActivityMs = Date.now(); // reset idle gate so we don't hammer WA with pings
      const msgSilenceMs  = Date.now() - (s.lastMessageMs || Date.now());
      const msgSilenceMin = Math.floor(msgSilenceMs / 60_000);
      const sessionAgeMs  = Date.now() - (s.createdAt || 0);
      console.log(`✅ [${phone}] Watchdog: WA round-trip OK (last msg ${msgSilenceMin}min ago)`);

      // ── Scenario B: delivery zombie (ping OK, but WA stopped routing msgs) ──
      // WA's status server and its message-routing layer are independent.
      // A ping can succeed while WA has silently stopped delivering new messages
      // to this linked device.  The only way to detect it is tracking when the
      // last real user-message arrived (lastMessageMs) vs. the current time.
      //
      // Threshold: 4 hours.  A bot handling active groups will always see at
      // least one message every 4 h.  If it hasn't, WA routing is likely broken.
      //
      // Guard: skip during the first 30 min of a session — the bot may not have
      // received any messages yet simply because it just connected.
      const MAX_MSG_SILENCE_MS = 4 * 60 * 60 * 1000; // 4 hours
      const SESSION_MIN_AGE_MS =     30 * 60 * 1000;  // 30 minutes
      if (msgSilenceMs > MAX_MSG_SILENCE_MS && sessionAgeMs > SESSION_MIN_AGE_MS) {
        _forceReconnect(`delivery zombie — no real message in ${msgSilenceMin}min despite ping OK`);
      }
    } catch (pingErr) {
      _pingFails++;
      console.warn(`⚠️  [${phone}] Watchdog: ping #${_pingFails} failed — ${pingErr?.message}`);
      // ── Scenario A: socket-level zombie ────────────────────────────────────
      if (_pingFails >= 2) {
        _pingFails = 0;
        _forceReconnect('2 consecutive ping failures');
      }
    }
  }, 5 * 60_000);

  // ── Proactive session refresh ─────────────────────────────────────────────────
  // WhatsApp silently zombies sessions after extended uptime.  We do a clean
  // voluntary reconnect every 8 hours to stay well within the safe window.
  // (Previous value was 20h — 3-day uptime meant 3 stale cycles before the
  //  delivery zombie accumulated; 8h means at most 8h of silence before refresh.)
  const MAX_SESSION_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
  const _proactiveRefresh = setTimeout(() => {
    const s = sessions.get(phone);
    if (!s || s.status !== 'connected' || reconnecting.has(phone)) return;
    console.log(`♻️  [${phone}] Proactive 8h session refresh — clean reconnect to prevent WA delivery zombie`);
    reconnecting.add(phone);
    sessions.delete(phone);
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(); } catch {}
    setTimeout(() => {
      reconnecting.delete(phone);
      createSession(phone, { onPairingCode, onConnected, onDisconnected, onError }).catch(onError);
    }, 3000);
  }, MAX_SESSION_AGE_MS);
  // Store so _teardownSocket can cancel it on unpair/stopSession
  entry._proactiveRefresh = _proactiveRefresh;
  // Ensure this timer doesn't prevent Node from exiting cleanly
  if (_proactiveRefresh.unref) _proactiveRefresh.unref();

  attachMessageHandler(sock, () => {
    const s = sessions.get(phone);
    if (s) {
      s.lastActivityMs = Date.now();
      s.lastMessageMs  = Date.now(); // track real message delivery separately from pings
    }
  }, connectTime, phone, authDir);
}
