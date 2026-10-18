/**
 * Auto-React Feature — reacts with a random emoji to incoming messages.
 * Independent toggles for PM and Group chats.
 *
 * DEFAULTS: both OFF (user must explicitly enable)
 *
 * Owner commands:
 *   !autoreact             → show status
 *   !autoreact pm on/off
 *   !autoreact group on/off
 *   !autoreact on/off      → toggle BOTH
 */

import { getState, setState } from './state.js';

// Default both to OFF — user enables them explicitly
let pmEnabled    = getState('autoreact_pm',    process.env.AUTOREACT_PM_ENABLED    === 'true');
let groupEnabled = getState('autoreact_group', process.env.AUTOREACT_GROUP_ENABLED === 'true');

const DEFAULT_EMOJIS = [
  '❤️', '👍', '😂', '😮', '😢', '🙏',
  '🔥', '🎉', '💯', '👏', '✅', '😍',
  '💪', '⭐', '🥰', '😊', '🫶', '🤩',
  '💫', '✨',
];

function getReactEmojis() {
  const saved = getState('autoreact_emojis', null);
  if (Array.isArray(saved) && saved.length === 3) return saved;
  const raw = (process.env.AUTOREACT_EMOJIS || '').trim();
  if (!raw) return DEFAULT_EMOJIS;
  return raw.split(',').map(e => e.trim()).filter(Boolean);
}

export function getAutoReactEmojis() {
  return getReactEmojis();
}

export function setAutoReactEmojis(emojis) {
  setState('autoreact_emojis', emojis);
}

function randomEmoji() {
  const pool = getReactEmojis();
  if (!pool.length) return DEFAULT_EMOJIS[0];
  return pool[Math.floor(Math.random() * pool.length)];
}

export function isAutoReactPmEnabled()    { return pmEnabled; }
export function isAutoReactGroupEnabled() { return groupEnabled; }
export function setAutoReactPm(v)    { pmEnabled    = Boolean(v); setState('autoreact_pm',    pmEnabled);    }
export function setAutoReactGroup(v) { groupEnabled = Boolean(v); setState('autoreact_group', groupEnabled); }
export function isAutoReactEnabled() { return pmEnabled || groupEnabled; }
export function setAutoReact(v) { setAutoReactPm(v); setAutoReactGroup(v); }

/**
 * Send a reaction emoji on an incoming message.
 * Skips: commands (prefix), own messages, broadcasts, status updates.
 *
 * @param {string} prefix  — the bot command prefix (e.g. "!")
 */
export async function handleAutoReact(sock, msg, prefix) {
  try {
    const jid = msg.key?.remoteJid;
    if (!jid) return false;

    const isGroup = jid.endsWith('@g.us');
    const isPm    = jid.endsWith('@s.whatsapp.net') ||
      jid.endsWith('@c.us') || jid.endsWith('@lid');

    if (!isGroup && !isPm) return false;
    if (isGroup && !groupEnabled) return false;
    if (isPm    && !pmEnabled)    return false;

    const msgId  = msg.key.id;
    if (!msgId) return false;

    // Don't react to own bot messages
    if (msg.key.fromMe) return false;

    // Don't react to command messages (starts with prefix)
    if (prefix) {
      const text =
        msg.message?.conversation               ||
        msg.message?.extendedTextMessage?.text  ||
        msg.message?.imageMessage?.caption      ||
        msg.message?.videoMessage?.caption      ||
        '';
      if (text.startsWith(prefix)) return false;
    }

    // Keep participantAlt/device information when Baileys provides it.
    const reactKey = { ...msg.key, fromMe: msg.key.fromMe ?? false };
    if (isGroup && !reactKey.participant && reactKey.participantAlt) {
      reactKey.participant = reactKey.participantAlt;
    }

    await sock.sendMessage(jid, {
      react: { text: randomEmoji(), key: reactKey },
    });
    return true;
  } catch {
    return false;
  }
}
