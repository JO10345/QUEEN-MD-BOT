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

export function isAutoStatusViewEnabled()  { return getState(KEY_VIEW,  true);  }
export function isAutoStatusReplyEnabled() { return getState(KEY_REPLY, true);  }

export function setAutoStatusView(val)  { setState(KEY_VIEW,  val); }
export function setAutoStatusReply(val) { setState(KEY_REPLY, val); }

/**
 * Called from messages.upsert BEFORE the broadcast filter.
 * Returns true if the message was a status that was handled.
 */
export async function handleAutoStatus(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (jid !== 'status@broadcast') return false;
  if (!msg.message) return true; // still a status, just no content

  if (!isAutoStatusViewEnabled()) return true;

  const poster = msg.key.participant || msg.key.remoteJid;

  // Mark status as viewed
  try {
    await sock.readMessages([msg.key]);
  } catch {}

  // Send cute reply to the poster
  if (isAutoStatusReplyEnabled() && poster && poster !== 'status@broadcast') {
    try {
      await sock.sendMessage(poster, {
        text: 'APKA STATUS DEKH LIYA ♥️',
      }, { quoted: msg });
    } catch {}
  }

  return true;
}

/**
 * !autostatus command handler (owner only).
 * Usage:
 *   !autostatus on / off          — toggle auto-view
 *   !autostatus reply on / off    — toggle cute reply
 *   !autostatus status            — show current settings
 */
export async function handleAutoStatusCommand(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const a   = (args || '').trim().toLowerCase();

  const reply = text => sock.sendMessage(jid, { text }, { quoted: msg });

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
  if (a === 'status' || a === '') {
    const v = isAutoStatusViewEnabled();
    const r = isAutoStatusReplyEnabled();
    return reply(
      `👁️ *Auto Status Settings*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Auto-view:  ${v ? '🟢 ON'  : '🔴 OFF'}\n` +
      `Cute reply: ${r ? '🟢 ON'  : '🔴 OFF'}\n\n` +
      `Commands:\n` +
      `• !autostatus on / off\n` +
      `• !autostatus reply on / off`,
    );
  }

  return reply('❓ Usage: !autostatus on/off  or  !autostatus reply on/off');
}
