/**
 * View Once Bypass
 *
 * Two modes:
 *  1. Auto-capture: When enabled, any incoming view-once is re-sent automatically
 *  2. Manual (!vv): Reply to a view-once message with !vv to reveal it on demand
 */

import {
  downloadMediaMessage,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';
import { getState, setState } from './state.js';

export function isViewOnceEnabled() { return getState('viewonce', false); }
export function setViewOnce(v)      { setState('viewonce', v); }

const silentLogger = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
  child: () => silentLogger,
};

/**
 * Download media from a message object using the most reliable method.
 * Tries downloadContentFromMessage first (stream), falls back to downloadMediaMessage.
 *
 * FIX: sock is now passed so that sock.updateMediaMessage can be used as
 * reuploadRequest. Without this, media with expired CDN URLs returns null
 * silently — which is why view-once re-send and !vv appeared to do nothing.
 */
async function downloadMedia(sock, key, mediaMessageObj, mediaType) {
  // Method 1: downloadContentFromMessage (most reliable for viewonce)
  try {
    const stream  = await downloadContentFromMessage(mediaMessageObj, mediaType);
    const chunks  = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (buf.length > 0) return buf;
  } catch {}

  // Method 2: downloadMediaMessage with reuploadRequest so expired CDN URLs
  // are refreshed automatically instead of silently failing.
  try {
    const buf = await downloadMediaMessage(
      { key, message: { [`${mediaType}Message`]: mediaMessageObj } },
      'buffer',
      {},
      {
        logger: silentLogger,
        ...(typeof sock.updateMediaMessage === 'function'
          ? { reuploadRequest: sock.updateMediaMessage.bind(sock) }
          : {}),
      },
    );
    if (buf && buf.length > 0) return buf;
  } catch {}

  return null;
}

/**
 * Extract the viewOnce inner message from any nesting layers.
 *
 * Newer WhatsApp versions sometimes strip the viewOnce wrapper from the
 * quoted-message context, leaving just imageMessage/videoMessage directly.
 * We accept that too so !vv still works when the wrapper is absent.
 */
function extractVoMsg(msgObj) {
  if (!msgObj) return null;
  // Unwrap ephemeral / document-with-caption
  const outer =
    msgObj.ephemeralMessage?.message ||
    msgObj.documentWithCaptionMessage?.message ||
    msgObj;

  // Standard view-once wrappers (try these first)
  const wrapped =
    outer.viewOnceMessage?.message            ||
    outer.viewOnceMessageV2?.message          ||
    outer.viewOnceMessageV2Extension?.message;
  if (wrapped) return wrapped;

  // Fallback: newer WA strips the wrapper in quoted context but leaves the
  // imageMessage/videoMessage intact.  Return outer as-is — the caller
  // checks the media fields so it works even if WA strips the wrapper.
  if (outer.imageMessage || outer.videoMessage || outer.audioMessage) return outer;

  return null;
}

// ── Auto-capture (fires on every incoming message) ────────────────────────────

export async function handleViewOnce(sock, msg) {
  if (!isViewOnceEnabled()) return false;

  const m = msg?.message;
  if (!m) return false;

  const voMsg = extractVoMsg(m);
  if (!voMsg) return false;

  const jid       = msg.key?.remoteJid;
  const sender    = msg.key?.fromMe
    ? (sock.user?.id || jid)
    : (msg.key?.participant || jid);
  const senderNum = sender.split('@')[0].split(':')[0];
  const label     = `👁️ *View Once* — from @${senderNum}`;

  const imgMsg   = voMsg.imageMessage;
  const vidMsg   = voMsg.videoMessage;
  const audMsg   = voMsg.audioMessage;
  const mediaMsg = imgMsg || vidMsg || audMsg;
  if (!mediaMsg) return false;

  const mediaType = imgMsg ? 'image' : vidMsg ? 'video' : 'audio';
  const buffer    = await downloadMedia(sock, msg.key, mediaMsg, mediaType);
  if (!buffer) return false;

  const originalCaption = mediaMsg.caption || '';
  const caption = originalCaption ? `${label}\n${originalCaption}` : label;

  try {
    if (imgMsg) {
      await sock.sendMessage(jid, { image: buffer, caption, mentions: [sender] });
    } else if (vidMsg) {
      await sock.sendMessage(jid, { video: buffer, caption, mentions: [sender] });
    } else {
      await sock.sendMessage(jid, {
        audio: buffer,
        mimetype: mediaMsg.mimetype || 'audio/mp4',
        ptt: Boolean(mediaMsg.ptt),
      });
      await sock.sendMessage(jid, { text: caption, mentions: [sender] });
    }
    return true;
  } catch {
    return false;
  }
}

// ── !vv command — reveal by replying to a view-once message ───────────────────

export async function handleVvCommand(sock, msg) {
  const jid = msg.key?.remoteJid;

  // Get context info from the quoted/replied message
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo        ||
    msg.message?.videoMessage?.contextInfo        ||
    null;

  if (!ctx?.quotedMessage || !ctx?.stanzaId) {
    return sock.sendMessage(jid, {
      text: `❌ *Reply to a view once photo, video, or voice note* with *!vv* to reveal it.`,
    }, { quoted: msg });
  }

  const quoted    = ctx.quotedMessage;
  const quotedKey = {
    remoteJid:   jid,
    id:          ctx.stanzaId,
    participant: ctx.participant || undefined,
    fromMe:      false,
  };

  // Try to find the view-once inner message
  const voMsg = extractVoMsg(quoted);

  if (!voMsg) {
    return sock.sendMessage(jid, {
      text: `❌ The replied message is not a view once photo, video, or voice note.`,
    }, { quoted: msg });
  }

  const imgMsg    = voMsg.imageMessage;
  const vidMsg    = voMsg.videoMessage;
  const audMsg    = voMsg.audioMessage;
  const mediaMsg  = imgMsg || vidMsg || audMsg;
  if (!mediaMsg) {
    return sock.sendMessage(jid, {
      text: `❌ Unsupported view once media type.`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, { text: `⏳ *Revealing view once...*` }, { quoted: msg });

  const mediaType = imgMsg ? 'image' : vidMsg ? 'video' : 'audio';
  const buffer    = await downloadMedia(sock, quotedKey, mediaMsg, mediaType);

  if (!buffer || buffer.length === 0) {
    return sock.sendMessage(jid, {
      text: `❌ *Could not download the media.*\nIt may have expired or been deleted.`,
    }, { quoted: msg });
  }

  const senderNum = (ctx.participant || ctx.remoteJid || '').split('@')[0].split(':')[0];
  const label     = `👁️ *View Once revealed* — from @${senderNum}`;
  const caption   = mediaMsg.caption ? `${label}\n${mediaMsg.caption}` : label;

  try {
    if (imgMsg) {
      await sock.sendMessage(jid, { image: buffer, caption, mentions: ctx.participant ? [ctx.participant] : [] });
    } else if (vidMsg) {
      await sock.sendMessage(jid, { video: buffer, caption, mentions: ctx.participant ? [ctx.participant] : [] });
    } else {
      await sock.sendMessage(jid, {
        audio: buffer,
        mimetype: mediaMsg.mimetype || 'audio/mp4',
        ptt: Boolean(mediaMsg.ptt),
      }, { quoted: msg });
      await sock.sendMessage(jid, {
        text: caption,
        mentions: ctx.participant ? [ctx.participant] : [],
      }, { quoted: msg });
    }
  } catch (err) {
    await sock.sendMessage(jid, {
      text: `❌ Failed to send media: ${err.message}`,
    }, { quoted: msg });
  }
}
