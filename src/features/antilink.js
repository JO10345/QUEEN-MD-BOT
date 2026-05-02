/**
 * Antilink — auto-deletes messages containing links in groups where it's
 * enabled. Owner and group admins are exempt.
 *
 * Owner commands (run inside the group):
 *   !antilink on        — enable for this group
 *   !antilink off       — disable for this group
 *   !antilink           — show status
 *   !antilink list      — list all groups where antilink is enabled
 *
 * State persists in state.json under "antilink_groups" (array of group JIDs).
 */

import { getState, setState } from './state.js';

const KEY = 'antilink_groups';

function loadList() {
  return new Set(getState(KEY, []));
}
function saveList(set) {
  setState(KEY, [...set]);
}

export function isAntilinkOn(groupJid) {
  return loadList().has(groupJid);
}
export function setAntilink(groupJid, on) {
  const list = loadList();
  if (on) list.add(groupJid);
  else    list.delete(groupJid);
  saveList(list);
}
export function listAntilinkGroups() {
  return [...loadList()];
}

// Detects URLs and WhatsApp group invite links
const LINK_RE = /(https?:\/\/\S+|www\.\S+|chat\.whatsapp\.com\/\S+|wa\.me\/\S+|t\.me\/\S+|\b\S+\.(com|net|org|io|me|co|xyz|app|dev|gg|tv|live|link|ly|to|ng|in|us|uk)\b\/?\S*)/i;

function bareNum(jid) {
  if (!jid) return '';
  return jid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
}

/**
 * Run on every incoming group message.
 * @returns {Promise<boolean>} true if the message was deleted.
 */
export async function handleAntilink(sock, msg, body, ownerNumber) {
  const jid = msg.key.remoteJid;
  if (!jid?.endsWith('@g.us')) return false;
  if (!isAntilinkOn(jid))      return false;
  if (!body || !LINK_RE.test(body)) return false;

  // Exempt owner
  const senderRaw = msg.key.participant || '';
  const sender    = bareNum(senderRaw);
  const ownerNum  = (ownerNumber || '').replace(/[^0-9]/g, '');
  if (ownerNum && sender === ownerNum) return false;

  // Exempt group admins
  try {
    const meta  = await sock.groupMetadata(jid);
    const isAdm = meta.participants.some(
      p => bareNum(p.id) === sender && (p.admin === 'admin' || p.admin === 'superadmin'),
    );
    if (isAdm) return false;
  } catch {
    // If we can't fetch metadata, fail-safe: do nothing
    return false;
  }

  // Delete the message
  try {
    await sock.sendMessage(jid, {
      delete: {
        remoteJid:   jid,
        fromMe:      false,
        id:          msg.key.id,
        participant: senderRaw,
      },
    });
    await sock.sendMessage(jid, {
      text:
        `╭─❍ 🚫 *LINK DELETED* ❍─╮\n` +
        `│\n` +
        `│  @${sender}\n` +
        `│  *KAKA LINK ALLOW NAI HAI* 😤\n` +
        `│\n` +
        `╰─────────────────╯`,
      mentions: [senderRaw],
    });
    return true;
  } catch (err) {
    console.error('Antilink delete failed:', err.message);
    return false;
  }
}

/**
 * Command handler for !antilink — allowed for the bot owner OR any group admin.
 */
export async function handleAntilinkCommand(sock, msg, args, ownerNumber) {
  const jid = msg.key.remoteJid;
  const isGroup = jid?.endsWith('@g.us');
  const a = (args || '').trim().toLowerCase();

  // ── Permission check (owner OR group admin) ────────────────────────────────
  const senderRaw = msg.key.participant || msg.key.remoteJid || '';
  const sender    = bareNum(senderRaw);
  const ownerNum  = (ownerNumber || '').replace(/[^0-9]/g, '');
  const isOwner   = ownerNum && sender === ownerNum;

  let isGroupAdmin = false;
  if (isGroup) {
    try {
      const meta = await sock.groupMetadata(jid);
      isGroupAdmin = meta.participants.some(
        p => bareNum(p.id) === sender && (p.admin === 'admin' || p.admin === 'superadmin'),
      );
    } catch {}
  }

  // For "list" we allow only the owner (it can leak group names)
  if (a === 'list' && !isOwner) {
    await sock.sendMessage(jid, { text: '❌ Only the bot owner can list all protected groups.' }, { quoted: msg });
    return;
  }
  // For on/off/status inside a group, owner or any group admin is enough
  if (a !== 'list' && !isOwner && !isGroupAdmin) {
    await sock.sendMessage(jid, {
      text: '❌ Only the bot owner or a group admin can change antilink settings.',
    }, { quoted: msg });
    return;
  }

  if (a === 'list') {
    const list = listAntilinkGroups();
    if (list.length === 0) {
      await sock.sendMessage(jid, { text: '🔗 *Antilink* is not enabled in any group.' }, { quoted: msg });
      return;
    }
    let out = `🚫 *Antilink enabled in ${list.length} group(s):*\n\n`;
    for (let i = 0; i < list.length; i++) {
      try {
        const meta = await sock.groupMetadata(list[i]);
        out += `${i + 1}. ${meta.subject}\n`;
      } catch {
        out += `${i + 1}. _(unknown group)_ ${list[i]}\n`;
      }
    }
    await sock.sendMessage(jid, { text: out }, { quoted: msg });
    return;
  }

  if (!isGroup) {
    await sock.sendMessage(jid, {
      text: `❌ *!antilink on/off* must be used inside the group you want to protect.\n\nUse *!antilink list* to see all protected groups.`,
    }, { quoted: msg });
    return;
  }

  if (a === 'on' || a === 'enable') {
    setAntilink(jid, true);
    await sock.sendMessage(jid, {
      text: `✅ *Antilink enabled* for this group.\n\nLinks from non-admins will be auto-deleted.\n_Owner and admins are exempt._`,
    }, { quoted: msg });
    return;
  }

  if (a === 'off' || a === 'disable') {
    setAntilink(jid, false);
    await sock.sendMessage(jid, { text: `🔓 *Antilink disabled* for this group.` }, { quoted: msg });
    return;
  }

  // Status
  const status = isAntilinkOn(jid) ? '🟢 ON' : '🔴 OFF';
  await sock.sendMessage(jid, {
    text:
      `🔗 *Antilink Status*\n\n   • This group: ${status}\n\n` +
      `Commands (owner only):\n` +
      `  !antilink on        — enable here\n` +
      `  !antilink off       — disable here\n` +
      `  !antilink list      — see all protected groups`,
  }, { quoted: msg });
}
