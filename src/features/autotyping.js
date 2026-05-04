/**
 * Auto-Typing Feature — shows a "typing…" indicator whenever the bot
 * is about to respond to any message (command or chatbot reply).
 *
 * Owner commands:
 *   !autotyping          → show current status
 *   !autotyping on/off   → toggle
 */

import { getState, setState } from './state.js';

let enabled = getState('autotyping', process.env.AUTO_TYPING_ENABLED !== 'false');

export function isAutoTypingEnabled() { return enabled; }
export function setAutoTyping(v) {
  enabled = Boolean(v);
  setState('autotyping', enabled);
}

export async function sendTyping(sock, jid) {
  if (!enabled) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch {}
}

export async function stopTyping(sock, jid) {
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
}
