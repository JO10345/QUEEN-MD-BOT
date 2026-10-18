/**
 * Anti-Delete
 *
 * v5 — bounded audio prefetch, lazy media fallback, and revoke-event dedupe
 *
 * Cache message metadata immediately. Prefetch only small audio/voice notes,
 * with per-file and total-memory limits, since their CDN links can expire
 * before the delete event arrives. Other media uses the lazy fallback.
 */

import {
  downloadContentFromMessage,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { getState, setState }   from './state.js';

function normalizeSessionId(value) {
  if (!value) return '';
  const raw = String(value);
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw.replace(/\D/g, '');
  const local = raw.slice(0, at).split(':')[0];
  const server = raw.slice(at + 1).toLowerCase();
  if (server === 's.whatsapp.net' || server === 'c.us') {
    return local.replace(/\D/g, '');
  }
  return `${local}@${server}`;
}

function stateKey(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  return normalized ? `antidelete:${normalized}` : 'antidelete';
}

function cacheKey(sessionId, messageId) {
  return `${normalizeSessionId(sessionId) || 'default'}:${messageId}`;
}

function pairedJid(sessionId) {
  if (!sessionId) return '';
  const raw = String(sessionId);
  if (raw.includes('@')) {
    const at = raw.lastIndexOf('@');
    return `${raw.slice(0, at).split(':')[0]}@${raw.slice(at + 1)}`;
  }
  const number = raw.replace(/\D/g, '');
  return number ? `${number}@s.whatsapp.net` : '';
}

function pairedSocketJid(sock, sessionId, fallback = '') {
  // Prefer the connected WhatsApp identity; the persisted pairing number is
  // used only when Baileys has not populated its user object yet.
  return pairedJid(sock?.user?.phoneNumber) ||
    pairedJid(sock?.user?.id) ||
    pairedJid(sock?.user?.lid) ||
    pairedJid(sessionId) ||
    pairedJid(fallback);
}

export function isAntiDeleteEnabled(sessionId = '') {
  if (!normalizeSessionId(sessionId)) return getState('antidelete', false);
  // Read the legacy global toggle as a migration fallback. A paired account's
  // first explicit command stores its own value and clears that old default.
  return getState(stateKey(sessionId), getState('antidelete', false));
}
export function setAntiDelete(v, sessionId = '') {
  if (normalizeSessionId(sessionId)) {
    setState(stateKey(sessionId), Boolean(v));
    if (getState('antidelete', false)) setState('antidelete', false);
    return;
  }
  setState('antidelete', Boolean(v));
}

// ── Download concurrency guard ────────────────────────────────────────────────
// Limits simultaneous lazy-downloads so a burst of deletions can't create
// dozens of concurrent hung network requests that freeze the bot.
const MAX_CONCURRENT_DL  = 3;
const DOWNLOAD_TIMEOUT_MS = 25_000;  // allow slow media CDN responses to complete
let _activeDl = 0;

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map();
const recoveryInFlight = new Set();
const audioPrefetchInFlight = new Set();
let cachedAudioBytes = 0;
let activeAudioPrefetch = 0;

// Keep a useful rolling window even on busy, multi-session bots.
// Each entry is a plain object with a msg reference (~5–20 KB), not a buffer.
const CACHE_MAX = 1000;
const MAX_CACHED_AUDIO_PER_MESSAGE = 8 * 1024 * 1024;
const MAX_CACHED_AUDIO_TOTAL = 24 * 1024 * 1024;
const MAX_AUDIO_PREFETCH_CONCURRENCY = 2;

// Keep a little longer than WhatsApp's usual deletion window so reconnects
// and delayed revoke events still have a chance to recover the message.
const CACHE_TTL_MS = 10 * 60 * 1000;

function removeCacheEntry(id) {
  const entry = cache.get(id);
  if (entry?.mediaBuffer) {
    cachedAudioBytes = Math.max(0, cachedAudioBytes - entry.mediaBuffer.length);
  }
  cache.delete(id);
}

function evictOldestCachedAudio(exceptId = '') {
  for (const [id, entry] of cache) {
    if (id === exceptId || !entry.mediaBuffer) continue;
    cachedAudioBytes = Math.max(0, cachedAudioBytes - entry.mediaBuffer.length);
    delete entry.mediaBuffer;
    return true;
  }
  return false;
}

function storeCachedAudio(id, buffer) {
  const entry = cache.get(id);
  if (!entry || entry.type !== 'audio' || !Buffer.isBuffer(buffer) || !buffer.length ||
      buffer.length > MAX_CACHED_AUDIO_PER_MESSAGE) return;

  if (entry.mediaBuffer) {
    cachedAudioBytes = Math.max(0, cachedAudioBytes - entry.mediaBuffer.length);
    delete entry.mediaBuffer;
  }
  while (cachedAudioBytes + buffer.length > MAX_CACHED_AUDIO_TOTAL) {
    if (!evictOldestCachedAudio(id)) return;
  }
  entry.mediaBuffer = buffer;
  cachedAudioBytes += buffer.length;
}

function trim() {
  const cutoff = Date.now() - CACHE_TTL_MS;

  // 1. TTL eviction
  for (const [id, entry] of cache) {
    if (entry.ts < cutoff) removeCacheEntry(id);
  }

  // 2. Size cap — keep newest CACHE_MAX entries
  if (cache.size > CACHE_MAX) {
    const oldest = Array.from(cache.keys()).slice(0, cache.size - CACHE_MAX);
    for (const id of oldest) removeCacheEntry(id);
  }
}

function advertisedMediaSize(media) {
  const raw = media?.fileLength;
  if (raw == null) return null;
  const size = Number(typeof raw === 'object' && typeof raw.toString === 'function' ? raw.toString() : raw);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

async function streamToBuffer(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        stream.destroy?.();
        return null;
      }
      chunks.push(bytes);
    }
    return size ? Buffer.concat(chunks, size) : null;
  } catch {
    return null;
  }
}

async function prefetchAudio(entryKey, cachedMsg, audioMessage, sessionId) {
  if (!audioMessage || activeAudioPrefetch >= MAX_AUDIO_PREFETCH_CONCURRENCY) return;
  const advertisedSize = advertisedMediaSize(audioMessage);
  if (advertisedSize != null && advertisedSize > MAX_CACHED_AUDIO_PER_MESSAGE) return;
  if (cache.get(entryKey)?.mediaBuffer || audioPrefetchInFlight.has(entryKey)) return;

  audioPrefetchInFlight.add(entryKey);
  activeAudioPrefetch++;
  try {
    const stream = await downloadContentFromMessage(audioMessage, 'audio');
    const buffer = await streamToBuffer(stream, MAX_CACHED_AUDIO_PER_MESSAGE);
    if (buffer?.length && isAntiDeleteEnabled(sessionId)) {
      storeCachedAudio(entryKey, buffer);
    }
  } catch {
    // Keep the metadata cache; the delete-time downloader is still attempted.
  } finally {
    activeAudioPrefetch--;
    audioPrefetchInFlight.delete(entryKey);
  }
}

// ── Cache incoming message (lightweight — NO buffer download) ─────────────────

export function cacheIncomingMessage(msg, sessionId = '') {
  const m = msg?.message;
  if (!m || msg.key?.remoteJid === 'status@broadcast') return;

  const msgId  = msg.key?.id;
  const jid    = msg.key?.remoteJid;
  const fromMe = msg.key?.fromMe;
  if (!msgId || !jid) return;

  const sender = fromMe
    ? pairedJid(sessionId)
    : (msg.key?.participant || msg.key?.participantAlt || jid || '');

  const inner =
    m.ephemeralMessage?.message             ||
    m.viewOnceMessage?.message              ||
    m.viewOnceMessageV2?.message            ||
    m.viewOnceMessageV2Extension?.message   ||
    m.editedMessage?.message                ||
    m.documentWithCaptionMessage?.message   ||
    m;

  let type = null;
  let text = null;
  let caption = null;

  if (inner.conversation || inner.extendedTextMessage?.text) {
    type = 'text';
    text = inner.conversation || inner.extendedTextMessage?.text || '';
  } else if (inner.imageMessage) {
    type    = 'image';
    caption = inner.imageMessage.caption || '';
  } else if (inner.videoMessage) {
    type    = 'video';
    caption = inner.videoMessage.caption || '';
  } else if (inner.audioMessage) {
    type = 'audio';
  } else if (inner.stickerMessage) {
    type = 'sticker';
  } else if (inner.documentMessage) {
    type    = 'document';
    caption = inner.documentMessage.caption || inner.documentMessage.fileName || '';
  } else {
    return;
  }

  // Baileys may mutate the event object after a revoke, so clone when possible.
  let cachedMsg = msg;
  try {
    cachedMsg = structuredClone(msg);
  } catch {}
  const entryId = cacheKey(sessionId, msgId);
  const previous = cache.get(entryId);
  const preservedAudio = previous?.type === type ? previous.mediaBuffer : null;
  if (previous?.mediaBuffer && !preservedAudio) {
    cachedAudioBytes = Math.max(0, cachedAudioBytes - previous.mediaBuffer.length);
  }
  cache.delete(entryId);
  cache.set(entryId, {
    msg: cachedMsg,
    jid,
    sender,
    pairedJid: pairedJid(sessionId),
    type,
    text,
    caption,
    mimetype: inner.audioMessage?.mimetype || inner.documentMessage?.mimetype || '',
    ptt: Boolean(inner.audioMessage?.ptt),
    ...(preservedAudio ? { mediaBuffer: preservedAudio } : {}),
    fileName: inner.documentMessage?.fileName || '',
    ts: Date.now(),
  });
  trim();
  if (type === 'audio' && !preservedAudio) {
    void prefetchAudio(entryId, cachedMsg, inner.audioMessage, sessionId);
  }
}

// ── Handle delete event (lazy download happens here) ─────────────────────────

const silentLogger = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
  child: () => silentLogger,
};

async function lazyDownload(sock, entry) {
  const { msg, type } = entry;
  if (type === 'text') return null;
  if (Buffer.isBuffer(entry.mediaBuffer) && entry.mediaBuffer.length) return entry.mediaBuffer;

  // Concurrency gate: if too many downloads are already running, skip this one.
  // This prevents a burst of deletions from spawning dozens of hung requests.
  if (_activeDl >= MAX_CONCURRENT_DL) return null;

  const mediaTypeMap = {
    image:    'image',
    video:    'video',
    audio:    'audio',
    sticker:  'sticker',
    document: 'document',
  };
  const mediaType = mediaTypeMap[type];
  if (!mediaType) return null;

  _activeDl++;
  try {
    // A re-upload callback lets Baileys refresh an expired media URL. The
    // callback is optional on older forks, so only pass it when available.
    const downloadOptions = { logger: silentLogger };
    if (typeof sock.updateMediaMessage === 'function') {
      downloadOptions.reuploadRequest = sock.updateMediaMessage.bind(sock);
    }
    const download = downloadMediaMessage(
      msg,
      'buffer',
      {},
      downloadOptions,
    );
    let timeout;
    try {
      const timeoutP = new Promise((_, rej) => {
        timeout = setTimeout(() => rej(new Error('media download timeout')), DOWNLOAD_TIMEOUT_MS);
      });
      const buf = await Promise.race([download, timeoutP]);
      return Buffer.isBuffer(buf) && buf.length > 0 ? buf : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  } finally {
    _activeDl--;
  }
}

function formatTime(ts) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.BOT_TIME_ZONE || 'Asia/Karachi',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

async function getChatName(sock, entry) {
  if (!entry.jid?.endsWith('@g.us')) return 'Private chat';
  try {
    const metadata = await sock.groupMetadata(entry.jid);
    return metadata?.subject || entry.jid.split('@')[0];
  } catch {
    return entry.jid.split('@')[0];
  }
}

function getTypeLabel(type) {
  return ({
    text: '📝 Text Message',
    image: '🖼️ Image',
    video: '🎥 Video',
    audio: '🎵 Audio',
    sticker: '🏷️ Sticker',
    document: '📄 Document',
  })[type] || '📦 Message';
}

function recoveryNotice(entry, chatName) {
  const senderLocal = entry.sender
    ? entry.sender.split('@')[0].split(':')[0]
    : '';
  const senderTag = senderLocal ? `@${senderLocal}` : 'Unknown sender';
  const content = entry.text || entry.caption || (entry.type === 'text' ? '(empty message)' : '(no caption)');
  const text =
    `🚨 *RECOVERED MESSAGE*\n\n` +
    `👤 *Sender:* ${senderTag}\n` +
    `📍 *Chat:* ${chatName}\n` +
    `⏱️ *Time:* ${formatTime(entry.ts)}\n` +
    `📦 *Type:* ${getTypeLabel(entry.type)}\n` +
    `🛡️ *Status:* Anti-Delete Protection Active\n\n` +
    `📝 *Content:*\n${content}`;
  return { text, mentions: entry.sender ? [entry.sender] : [] };
}

export async function handleAntiDelete(sock, deletedKeys, sessionId = '') {
  if (!isAntiDeleteEnabled(sessionId)) return;

  let keys = [];
  if (Array.isArray(deletedKeys))           keys = deletedKeys;
  else if (Array.isArray(deletedKeys?.keys)) keys = deletedKeys.keys;
  else if (deletedKeys?.key)                keys = [deletedKeys.key];
  else if (deletedKeys?.id)                 keys = [deletedKeys];

  for (const key of keys) {
    const msgId = key?.id;
    if (!msgId) continue;

    const entryKey = cacheKey(sessionId, msgId);
    const entry = cache.get(entryKey);
    if (!entry) {
      console.warn(`[ANTIDELETE] Delete event received, but its message was not in the enabled session's cache (${key?.remoteJid?.endsWith('@g.us') ? 'group' : 'chat'}).`);
      continue;
    }
    // Multiple Baileys revoke events can describe the same deletion. This
    // per-message lock prevents concurrent handlers from sending duplicates.
    if (recoveryInFlight.has(entryKey)) continue;
    recoveryInFlight.add(entryKey);

    // Never route recovered content to OWNER_NUMBER. Send it only to the
    // WhatsApp account whose session has Anti-Delete enabled.
    const destJid = pairedSocketJid(sock, sessionId, entry.pairedJid);
    if (!destJid) {
      recoveryInFlight.delete(entryKey);
      continue;
    }

    try {
      const chatName = await getChatName(sock, entry);
      const notice = recoveryNotice(entry, chatName);

      if (entry.type === 'text') {
        await sock.sendMessage(destJid, notice);
      } else {
        // Attempt lazy download only after a deletion event is detected.
        const buf = await lazyDownload(sock, entry);
        if (entry.type === 'image' && buf) {
          await sock.sendMessage(destJid, { image: buf, caption: notice.text, mentions: notice.mentions });
        } else if (entry.type === 'video' && buf) {
          await sock.sendMessage(destJid, { video: buf, caption: notice.text, mentions: notice.mentions });
        } else if (entry.type === 'document' && buf) {
          await sock.sendMessage(destJid, {
            document: buf,
            mimetype: entry.mimetype || 'application/octet-stream',
            fileName: entry.fileName || 'file',
            caption: notice.text,
            mentions: notice.mentions,
          });
        } else if (entry.type === 'audio' && buf) {
          await sock.sendMessage(destJid, {
            audio: buf,
            mimetype: entry.mimetype || 'audio/mp4',
            ptt: entry.ptt,
          });
          // Mark consumed immediately after the audio is sent, before its
          // separate metadata note, so another event cannot replay the audio.
          removeCacheEntry(entryKey);
          await sock.sendMessage(destJid, notice);
        } else if (entry.type === 'sticker' && buf) {
          await sock.sendMessage(destJid, { sticker: buf });
          removeCacheEntry(entryKey);
          await sock.sendMessage(destJid, notice);
        } else {
          const fallbackNotice = {
            ...notice,
            text: `${notice.text}\n\n_(Media could not be recovered before its download link expired.)_`,
          };
          await sock.sendMessage(destJid, fallbackNotice);
        }
      }

      removeCacheEntry(entryKey);
    } catch (err) {
      console.error('[ANTIDELETE] send error:', err.message);
    } finally {
      recoveryInFlight.delete(entryKey);
    }
  }
}
