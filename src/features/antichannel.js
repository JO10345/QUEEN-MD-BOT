/**
 * Anti-Channel Link Feature
 *
 * Detects and deletes WhatsApp channel-related content in groups:
 *   1. Channel share links  (https://whatsapp.com/channel/...)
 *   2. Messages forwarded FROM a WhatsApp channel (newsletter forwards)
 *
 * Warn system: 3 warns → kick (same as antilink)
 * Owner and admins are always exempt.
 *
 * Commands (run inside the group):
 *   !antichannel on     — enable protection for this group
 *   !antichannel off    — disable
 *   !antichannel        — show current status
 *   !antichannel list   — owner: list all protected groups
 */

import { getState, setState } from './state.js';

const KEY      = 'antichannel_groups';
const MAX_WARNS = 3;

function loadList() { return new Set(getState(KEY, [])); }
function saveList(set) { setState(KEY, [...set]); }

export function isAntichannelOn(groupJid) { return loadList().has(groupJid); }
export function setAntichannel(groupJid, on) {
  const list = loadList();
  if (on) list.add(groupJid); else list.delete(groupJid);
  saveList(list);
}
export function listAntichannelGroups() { return [...loadList()]; }

// ── Detection ─────────────────────────────────────────────────────────────────

// Matches any whatsapp.com/channel/ URL
const CHANNEL_LINK_RE = /https?:\/\/(www\.)?whatsapp\.com\/channel\/\S*/i;

/**
 * Returns true if the message is a WhatsApp channel link or a forward FROM a channel.
 */
function isChannelContent(msg, body) {
  // 1. Text contains a channel link
  if (body && CHANNEL_LINK_RE.test(body)) return true;

  // 2. Forwarded FROM a WhatsApp newsletter/channel
  //    Baileys puts forwardedNewsletterMessageInfo in contextInfo when a channel post is forwarded
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo        ||
    msg.message?.imageMessage?.contextInfo               ||
    msg.message?.videoMessage?.contextInfo               ||
    msg.message?.documentMessage?.contextInfo            ||
    msg.message?.audioMessage?.contextInfo               ||
    msg.message?.stickerMessage?.contextInfo             ||
    msg.message?.buttonsMessage?.contextInfo             ||
    msg.message?.templateMessage?.contextInfo            ||
    {};

  if (ctx?.forwardedNewsletterMessageInfo) return true;

  // 3. The quoted/context remoteJid is a newsletter JID (@newsletter)
  if (ctx?.remoteJid?.endsWith?.('@newsletter')) return true;

  // 4. Check top-level message keys that Baileys uses for newsletter messages
  if (msg.message?.newsletterAdminInviteMessage) return true;
  if (msg.message?.requestPhoneNumberMessage) return false; // not a channel

  return false;
}

// ── Warn tracker ──────────────────────────────────────────────────────────────

const warnMap = new Map();
const wKey    = (g, s) => `${g}:${s}`;

function bareNum(jid) {
  return (jid || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
}

function incrementWarn(groupJid, senderNum) {
  const k = wKey(groupJid, senderNum);
  const c = (warnMap.get(k) || 0) + 1;
  warnMap.set(k, c);
  return c;
}
function resetWarn(groupJid, senderNum) {
  warnMap.delete(wKey(groupJid, senderNum));
}

async function doWarn(sock, jid, senderRaw, count) {
  const senderNum = bareNum(senderRaw);
  if (count >= MAX_WARNS) {
    resetWarn(jid, senderNum);
    await sock.sendMessage(jid, {
      text:
        `╭─❍ 🚫 *KICKED* ❍─╮\n` +
        `│\n` +
        `│  @${senderNum}\n` +
        `│  3 channel warnings reached!\n` +
        `│  Goodbye 👋\n` +
        `│\n` +
        `╰─────────────────╯`,
      mentions: [senderRaw],
    });
    try { await sock.groupParticipantsUpdate(jid, [senderRaw], 'remove'); } catch {}
  } else {
    await sock.sendMessage(jid, {
      text:
        `╭─❍ 📢 *ANTICHANNEL WARNING* ❍─╮\n` +
        `│\n` +
        `│  @${senderNum}\n` +
        `│  Channel content NOT allowed! 🚫\n` +
        `│\n` +
        `│  ⚠️ *Warning ${count}/${MAX_WARNS}*\n` +
        `│  ${MAX_WARNS - count} more = KICK 🦵\n` +
        `│\n` +
        `╰─────────────────╯`,
      mentions: [senderRaw],
    });
  }
}

// ── Auto handler (fires on every group message) ───────────────────────────────

export async function handleAntichannel(sock, msg, body, ownerNumber) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us'))   return false;
  if (!isAntichannelOn(jid))     return false;
  if (!isChannelContent(msg, body)) return false;

  const senderRaw = msg.key.participant || '';
  const sender    = bareNum(senderRaw);
  const ownerNum  = (ownerNumber || '').replace(/[^0-9]/g, '');

  // Exempt owner
  if (ownerNum && sender === ownerNum) return false;

  // Exempt admins
  try {
    const meta  = await sock.groupMetadata(jid);
    const isAdm = meta.participants.some(
      p => bareNum(p.id) === sender && (p.admin === 'admin' || p.admin === 'superadmin'),
    );
    if (isAdm) return false;
  } catch { return false; }

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
  } catch {}

  const count = incrementWarn(jid, sender);
  await doWarn(sock, jid, senderRaw, count);
  return true;
}

// ── !antichannel command ──────────────────────────────────────────────────────

export async function handleAntichannelCommand(sock, msg, args, ownerNumber) {
  const jid     = msg.key.remoteJid;
  const isGroup = jid?.endsWith('@g.us');
  const a       = (args || '').trim().toLowerCase();

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

  // !antichannel list — owner only
  if (a === 'list') {
    if (!isOwner) {
      return sock.sendMessage(jid, { text: '❌ Only the bot owner can use this.' }, { quoted: msg });
    }
    const list = listAntichannelGroups();
    if (!list.length) {
      return sock.sendMessage(jid, { text: '📢 Antichannel is not enabled in any group.' }, { quoted: msg });
    }
    let out = `📢 *Antichannel enabled in ${list.length} group(s):*\n\n`;
    for (let i = 0; i < list.length; i++) {
      try { const m = await sock.groupMetadata(list[i]); out += `${i + 1}. ${m.subject}\n`; }
      catch { out += `${i + 1}. _(unknown group)_\n`; }
    }
    return sock.sendMessage(jid, { text: out }, { quoted: msg });
  }

  if (!isOwner && !isGroupAdmin) {
    return sock.sendMessage(jid, {
      text: '❌ Only the bot owner or a group admin can change this setting.',
    }, { quoted: msg });
  }

  if (!isGroup) {
    return sock.sendMessage(jid, {
      text: `❌ Use *!antichannel on/off* inside the group you want to protect.`,
    }, { quoted: msg });
  }

  if (a === 'on' || a === 'enable') {
    setAntichannel(jid, true);
    return sock.sendMessage(jid, {
      text:
        `✅ *Antichannel enabled* for this group.\n\n` +
        `📢 *What gets deleted:*\n` +
        `  • WhatsApp channel links (whatsapp.com/channel/...)\n` +
        `  • Posts forwarded FROM WhatsApp channels\n\n` +
        `⚠️ *Warn system:*\n` +
        `  • 1st offence → Warning 1/3\n` +
        `  • 2nd offence → Warning 2/3\n` +
        `  • 3rd offence → Warning 3/3 + KICK 🦵\n\n` +
        `_Owner and group admins are exempt._`,
    }, { quoted: msg });
  }

  if (a === 'off' || a === 'disable') {
    setAntichannel(jid, false);
    return sock.sendMessage(jid, { text: `🔓 *Antichannel disabled* for this group.` }, { quoted: msg });
  }

  // Show status
  const status = isAntichannelOn(jid) ? '🟢 ON' : '🔴 OFF';
  return sock.sendMessage(jid, {
    text:
      `📢 *Antichannel Status:* ${status}\n\n` +
      `*Protects against:*\n` +
      `  • WhatsApp channel share links\n` +
      `  • Posts forwarded from channels\n\n` +
      `*Warn system:* 3 warnings → kick\n\n` +
      `  !antichannel on    — enable\n` +
      `  !antichannel off   — disable\n` +
      `  !antichannel list  — all protected groups (owner)`,
  }, { quoted: msg });
}
