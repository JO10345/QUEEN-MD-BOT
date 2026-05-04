/**
 * Auto-React Feature — reacts with a random emoji.
 * Independent toggles for PM (DMs) and Group chats.
 *
 * Owner commands:
 *   !autoreact          → show status
 *   !autoreact pm on/off
 *   !autoreact group on/off
 *   !autoreact on/off   → toggle BOTH
 */

import { getState, setState } from './state.js';

let pmEnabled    = getState('autoreact_pm',    process.env.AUTOREACT_PM_ENABLED    !== 'false');
let groupEnabled = getState('autoreact_group', process.env.AUTOREACT_GROUP_ENABLED === 'true');

const DEFAULT_EMOJIS = [
  '❤️', '👍', '😂', '😮', '😢', '😡',
  '🙏', '🔥', '🎉', '💯', '👏', '✅',
  '😍', '🤣', '💪', '⭐', '🥰', '😊',
];

function getReactEmojis() {
  const raw = (process.env.AUTOREACT_EMOJIS || '').trim();
  if (!raw) return DEFAULT_EMOJIS;
  return raw.split(',').map(e => e.trim()).filter(Boolean);
}

function randomEmoji() {
  const pool = getReactEmojis();
  return pool[Math.floor(Math.random() * pool.length)];
}

export function isAutoReactPmEnabled()    { return pmEnabled; }
export function isAutoReactGroupEnabled() { return groupEnabled; }
export function setAutoReactPm(v)    { pmEnabled    = Boolean(v); setState('autoreact_pm',    pmEnabled);    }
export function setAutoReactGroup(v) { groupEnabled = Boolean(v); setState('autoreact_group', groupEnabled); }

export function isAutoReactEnabled() { return pmEnabled || groupEnabled; }
export function setAutoReact(v) {
  setAutoReactPm(v);
  setAutoReactGroup(v);
}

/**
 * Send a reaction. Works for both DMs and groups.
 */
export async function handleAutoReact(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid) return false;

  // Never react to broadcast / status
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return false;

  const isGroup = jid.endsWith('@g.us');
  const isPm    = jid.endsWith('@s.whatsapp.net');

  if (isGroup && !groupEnabled) return false;
  if (isPm    && !pmEnabled)    return false;
  if (!isGroup && !isPm)        return false;

  const msgId = msg.key?.id;
  if (!msgId) return false;

  // Skip protocol / empty messages
  if (msg.message?.protocolMessage) return false;
  if (msg.message?.reactionMessage)  return false;

  try {
    // Build reaction key — participant is required for group messages
    const reactKey = {
      remoteJid: msg.key.remoteJid,
      fromMe:    msg.key.fromMe ?? false,
      id:        msgId,
    };

    // For group messages, participant identifies the sender
    const participant = msg.key.participant || msg.participant;
    if (participant) reactKey.participant = participant;

    await sock.sendMessage(jid, {
      react: { text: randomEmoji(), key: reactKey },
    });
    return true;
  } catch (err) {
    // Silent fail — reaction errors are non-critical
    return false;
  }
}
