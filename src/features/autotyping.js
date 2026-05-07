/**
 * Auto-Typing Feature
 * When enabled, the bot shows a "typing..." presence whenever it receives
 * a message — making the bot feel alive and attentive in every chat.
 *
 * Independent toggles for PM and Group chats.
 *
 * Owner commands:
 *   !autotyping              → show status
 *   !autotyping on/off       → toggle both PM and Group
 *   !autotyping pm on/off    → toggle DMs only
 *   !autotyping group on/off → toggle groups only
 */

import { getState, setState } from './state.js';

let pmEnabled    = getState('autotyping_pm',    process.env.AUTOTYPING_PM_ENABLED    !== 'false');
let groupEnabled = getState('autotyping_group', process.env.AUTOTYPING_GROUP_ENABLED !== 'false');

const TYPING_DURATION = parseInt(process.env.AUTOTYPING_DURATION_MS || '3000');

export function isAutoTypingPmEnabled()    { return pmEnabled;    }
export function isAutoTypingGroupEnabled() { return groupEnabled; }

export function setAutoTypingPm(v) {
  pmEnabled = Boolean(v);
  setState('autotyping_pm', pmEnabled);
}
export function setAutoTypingGroup(v) {
  groupEnabled = Boolean(v);
  setState('autotyping_group', groupEnabled);
}
export function setAutoTyping(v) {
  setAutoTypingPm(v);
  setAutoTypingGroup(v);
}

/**
 * Fire-and-forget — shows "typing..." for TYPING_DURATION ms then clears it.
 * Never throws, never blocks the message handler.
 */
export function handleAutoTyping(sock, msg) {
  try {
    const jid = msg.key?.remoteJid;
    if (!jid) return;

    const isGroup = jid.endsWith('@g.us');
    const isPm    = jid.endsWith('@s.whatsapp.net');

    if (isGroup && !groupEnabled) return;
    if (isPm    && !pmEnabled)    return;
    if (!isGroup && !isPm)        return;

    sock.sendPresenceUpdate('composing', jid).catch(() => {});
    setTimeout(() => {
      sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }, TYPING_DURATION);
  } catch {
    // silently ignore
  }
}
