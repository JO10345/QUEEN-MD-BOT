/**
 * Auto Status View
 * Automatically views all WhatsApp statuses and optionally
 * sends a cute reply to the poster.
 *
 * Toggle: !autostatus on/off/reply on/off
 */

import { getState, setState } from './state.js';

const KEY_VIEW  = 'autostatusView';
const KEY_REPLY = 'autostatusReply';
const KEY_REACT = 'autostatusReact';
const KEY_EMOJIS = 'autostatusEmojis';
const DEFAULT_EMOJIS = ['❤️', '🔥', '😍'];
const handledStatuses = new Map();
const processingStatuses = new Set();

function beginStatusHandling(sock, key) {
  const token = [
    sock.user?.id || '',
    key.participant || key.participantAlt || key.remoteJidAlt || '',
    key.id,
  ].join(':');
  const now = Date.now();
  if (handledStatuses.has(token) || processingStatuses.has(token)) return null;
  processingStatuses.add(token);
  if (handledStatuses.size > 1000) {
    for (const [seenToken, timestamp] of handledStatuses) {
      if (now - timestamp > 24 * 60 * 60 * 1000) handledStatuses.delete(seenToken);
    }
    while (handledStatuses.size > 2500) {
      handledStatuses.delete(handledStatuses.keys().next().value);
    }
  }
  return token;
}

function finishStatusHandling(token) {
  processingStatuses.delete(token);
  handledStatuses.set(token, Date.now());
}

export function isAutoStatusViewEnabled()  { return getState(KEY_VIEW,  false); }
export function isAutoStatusReplyEnabled() { return getState(KEY_REPLY, false); }
export function isAutoStatusReactionEnabled() { return getState(KEY_REACT, false); }
export function getAutoStatusEmojis() {
  const saved = getState(KEY_EMOJIS, DEFAULT_EMOJIS);
  return Array.isArray(saved) && saved.length === 3 ? saved : DEFAULT_EMOJIS;
}

export function setAutoStatusView(val)  { setState(KEY_VIEW,  val); }
export function setAutoStatusReply(val) { setState(KEY_REPLY, val); }
export function setAutoStatusReaction(val) { setState(KEY_REACT, val); }
export function setAutoStatusEmojis(emojis) { setState(KEY_EMOJIS, emojis); }

/**
 * Called from messages.upsert BEFORE the broadcast filter.
 * Returns true if the message was a status that was handled.
 */
export async function handleAutoStatus(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (jid !== 'status@broadcast') return false;
  if (!msg.key?.id || msg.key.fromMe) return true;
  const shouldView = isAutoStatusViewEnabled();
  const shouldReply = isAutoStatusReplyEnabled();
  const shouldReact = isAutoStatusReactionEnabled();
  if (!shouldView && !shouldReply && !shouldReact) return true;

  const token = beginStatusHandling(sock, msg.key);
  if (!token) return true;
  const poster = msg.key.participant || msg.key.participantAlt || msg.key.remoteJidAlt;

  try {
    // Mark status as viewed.
    if (shouldView) {
      try {
        await sock.readMessages([msg.key]);
        console.log(`[AutoStatus] Viewed status ${msg.key.id}`);
      } catch (error) {
        console.warn(`[AutoStatus] Could not mark status ${msg.key.id} as viewed: ${error.message}`);
      }
    }

    // A WhatsApp status reaction is sent against the original status message key.
    if (shouldReact) {
      const emojis = getAutoStatusEmojis();
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      if (emoji && poster) {
        try {
          await sock.sendMessage('status@broadcast', {
            react: { text: emoji, key: msg.key },
          }, { statusJidList: [poster] });
        } catch (error) {
          console.warn(`[AutoStatus] Could not react to status ${msg.key.id}: ${error.message}`);
        }
      } else if (emoji) {
        console.warn(`[AutoStatus] Could not react to status ${msg.key.id}: poster JID is missing`);
      }
    }

    // Send cute reply to the poster.
    if (shouldReply && poster && poster !== 'status@broadcast') {
      try {
        const content = { text: 'APKA STATUS DEKH LIYA ♥️' };
        const options = msg.message ? { quoted: msg } : undefined;
        await sock.sendMessage(poster, content, options);
      } catch (error) {
        console.warn(`[AutoStatus] Could not reply to status poster: ${error.message}`);
      }
    }
  } finally {
    finishStatusHandling(token);
  }

  return true;
}

/**
 * !autostatus command handler (owner only).
 * Usage:
 *   !autostatus on / off          — toggle auto-view
 *   !autostatus reply on / off    — toggle cute reply
 *   !autostatus react <3 emoji>   — choose from three status reactions
 *   !autostatus react on / off    — toggle reactions
 *   !autostatus status            — show current settings
 */
export async function handleAutoStatusCommand(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const raw = (args || '').trim();
  const a   = raw.toLowerCase();

  const reply = text => sock.sendMessage(jid, { text }, { quoted: msg });
  const usage = 'Use: !autostatus react ❤️ 🔥 😍 — set exactly 3 emoji; or !autostatus react on/off.';

  if (a === 'on') {
    setAutoStatusView(true);
    return reply('✅ Auto status view *ON* — I will view all statuses automatically.');
  }
  if (a === 'off') {
    setAutoStatusView(false);
    return reply('🔴 Auto status view *OFF*.');
  }
  if (a === 'reply on') {
    setAutoStatusReply(true);
    return reply('✅ Status reply *ON* — I will send *APKA STATUS DEKH LIYA ♥️* to each poster.');
  }
  if (a === 'reply off') {
    setAutoStatusReply(false);
    return reply('🔴 Status reply *OFF* — I will view silently.');
  }
  if (a.startsWith('react ') || a.startsWith('reaction ')) {
    const value = raw.slice(raw.indexOf(' ') + 1).trim();
    const lowerValue = value.toLowerCase();
    if (lowerValue === 'on') {
      setAutoStatusReaction(true);
      return reply(`✅ Status reactions *ON* — I will randomly react with ${getAutoStatusEmojis().join(' ')}.`);
    }
    if (lowerValue === 'off') {
      setAutoStatusReaction(false);
      return reply('🔴 Status reactions *OFF*.');
    }

    const emojis = value.split(/[,\s]+/).filter(Boolean);
    const isEmoji = token =>
      /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]|[#*0-9]\uFE0F?\u20E3)+$/u.test(token);
    if (emojis.length !== 3 || emojis.some(token => !isEmoji(token))) return reply(usage);
    setAutoStatusEmojis(emojis);
    setAutoStatusReaction(true);
    return reply(`✅ Custom status reactions saved and *ON*: ${emojis.join(' ')}`);
  }
  if (a === 'status' || a === '') {
    const v = isAutoStatusViewEnabled();
    const r = isAutoStatusReplyEnabled();
    const react = isAutoStatusReactionEnabled();
    return reply(
      `👁️ *Auto Status Settings*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Auto-view:  ${v ? '🟢 ON'  : '🔴 OFF'}\n` +
      `Cute reply: ${r ? '🟢 ON'  : '🔴 OFF'}\n\n` +
      `Reaction: ${react ? '🟢 ON' : '🔴 OFF'} (${getAutoStatusEmojis().join(' ')})\n\n` +
      `Commands:\n` +
      `• !autostatus on / off\n` +
      `• !autostatus reply on / off\n` +
      `• !autostatus react ❤️ 🔥 😍\n` +
      `• !autostatus react on / off`,
    );
  }

  return reply(`❓ Usage: !autostatus on/off, !autostatus reply on/off, or ${usage}`);
}
