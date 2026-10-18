/**
 * Antilink — auto-deletes messages containing links in groups.
 * Owner and group admins are exempt.
 *
 * Warn system: 3 warnings then kick.
 *
 * Auto commands (fired on any link in group):
 *   1st offence → Warning 1/3
 *   2nd offence → Warning 2/3
 *   3rd offence → Warning 3/3 + KICK
 *
 * Manual warn commands:
 *   !warn @user        — manually add a warn to tagged user
 *   !warncount         — show all current warns in this group
 *   !resetwarn @user   — reset warns for tagged user
 *
 * Antilink toggle:
 *   !antilink on/off/list
 */

import { getState, setState } from './state.js';

const KEY = 'antilink_groups';
const KICK_KEY = 'antilink_kick_groups';
const MAX_WARNS = 3;

function loadList() { return new Set(getState(KEY, [])); }
function saveList(set) { setState(KEY, [...set]); }
function loadKickList() { return new Set(getState(KICK_KEY, [])); }
function saveKickList(set) { setState(KICK_KEY, [...set]); }

export function isAntilinkOn(groupJid) { return loadList().has(groupJid); }
export function setAntilink(groupJid, on) {
  const list = loadList();
  if (on) list.add(groupJid); else list.delete(groupJid);
  saveList(list);
  if (!on) setAntilinkKick(groupJid, false);
}
export function listAntilinkGroups() { return [...loadList()]; }
export function isAntilinkKickOn(groupJid) { return loadKickList().has(groupJid); }
export function setAntilinkKick(groupJid, on) {
  const list = loadKickList();
  if (on) list.add(groupJid); else list.delete(groupJid);
  saveKickList(list);
}

const LINK_RE = /(https?:\/\/\S+|www\.\S+|chat\.whatsapp\.com\/\S+|wa\.me\/\S+|t\.me\/\S+|\b\S+\.(com|net|org|io|me|co|xyz|app|dev|gg|tv|live|link|ly|to|ng|in|us|uk)\b\/?\S*)/i;

function bareNum(jid) {
  if (!jid) return '';
  return jid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
}

// Warn tracker: `${groupJid}:${senderNum}` → count
const warnMap = new Map();
const wKey    = (g, s) => `${g}:${s}`;

export function getWarnCount(groupJid, senderNum) {
  return warnMap.get(wKey(groupJid, senderNum)) || 0;
}
function incrementWarn(groupJid, senderNum) {
  const k = wKey(groupJid, senderNum);
  const c = (warnMap.get(k) || 0) + 1;
  warnMap.set(k, c);
  return c;
}
export function resetWarnForUser(groupJid, senderNum) {
  warnMap.delete(wKey(groupJid, senderNum));
}
function getAllWarns(groupJid) {
  const result = [];
  for (const [key, count] of warnMap.entries()) {
    if (key.startsWith(groupJid + ':')) {
      const num = key.slice(groupJid.length + 1);
      result.push({ num, count });
    }
  }
  return result;
}

async function doWarn(sock, jid, senderRaw, count) {
  const senderNum = bareNum(senderRaw);
  if (count >= MAX_WARNS) {
    // Kick
    resetWarnForUser(jid, senderNum);
    await sock.sendMessage(jid, {
      text:
        `╭─❍ 🚫 *KICKED* ❍─╮\n` +
        `│\n` +
        `│  @${senderNum}\n` +
        `│  3/3 warnings reached!\n` +
        `│  Goodbye 👋\n` +
        `│\n` +
        `╰─────────────────╯`,
      mentions: [senderRaw],
    });
    try { await sock.groupParticipantsUpdate(jid, [senderRaw], 'remove'); } catch {}
  } else {
    await sock.sendMessage(jid, {
      text:
        `╭─❍ ⚠️ *ANTILINK WARNING* ❍─╮\n` +
        `│\n` +
        `│  @${senderNum}\n` +
        `│  Links are NOT allowed here! ❌\n` +
        `│\n` +
        `│  ⚠️ *Warning ${count}/${MAX_WARNS}*\n` +
        `│  ${MAX_WARNS - count} more = KICK 🦵\n` +
        `│\n` +
        `╰─────────────────╯`,
      mentions: [senderRaw],
    });
  }
}

// ── Auto antilink handler ─────────────────────────────────────────────────────

export async function handleAntilink(sock, msg, body, ownerNumber) {
  const jid = msg.key.remoteJid;
  if (!jid?.endsWith('@g.us')) return false;
  if (!isAntilinkOn(jid))      return false;
  if (!body || !LINK_RE.test(body)) return false;

  const senderRaw = msg.key.participant || '';
  const sender    = bareNum(senderRaw);
  const ownerNum  = (ownerNumber || '').replace(/[^0-9]/g, '');

  if (ownerNum && sender === ownerNum) return false;

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
      delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: senderRaw },
    });
  } catch {}

  // Plain `!antilink on` only deletes the link.  Warnings and kicks are
  // opt-in with `!antilink kick`.
  if (!isAntilinkKickOn(jid)) return true;

  const count = incrementWarn(jid, sender);
  await doWarn(sock, jid, senderRaw, count);
  return true;
}

// ── !antilink command ─────────────────────────────────────────────────────────

export async function handleAntilinkCommand(sock, msg, args, ownerNumber) {
  const jid     = msg.key.remoteJid;
  const isGroup = jid?.endsWith('@g.us');
  const a       = (args || '').trim().toLowerCase();

  const senderRaw  = msg.key.participant || msg.key.remoteJid || '';
  const sender     = bareNum(senderRaw);
  const ownerNum   = (ownerNumber || '').replace(/[^0-9]/g, '');
  const isOwner    = ownerNum && sender === ownerNum;

  let isGroupAdmin = false;
  if (isGroup) {
    try {
      const meta = await sock.groupMetadata(jid);
      isGroupAdmin = meta.participants.some(
        p => bareNum(p.id) === sender && (p.admin === 'admin' || p.admin === 'superadmin'),
      );
    } catch {}
  }

  if (a === 'list' && !isOwner) {
    await sock.sendMessage(jid, { text: '❌ Only the bot owner can list protected groups.' }, { quoted: msg });
    return;
  }
  if (a !== 'list' && !isOwner && !isGroupAdmin) {
    await sock.sendMessage(jid, {
      text: '❌ Only the bot owner or a group admin can change antilink settings.',
    }, { quoted: msg });
    return;
  }

  if (a === 'list') {
    const list = listAntilinkGroups();
    if (!list.length) {
      await sock.sendMessage(jid, { text: '🔗 Antilink is not enabled in any group.' }, { quoted: msg });
      return;
    }
    let out = `🚫 *Antilink enabled in ${list.length} group(s):*\n\n`;
    for (let i = 0; i < list.length; i++) {
      try { const meta = await sock.groupMetadata(list[i]); out += `${i + 1}. ${meta.subject}\n`; }
      catch { out += `${i + 1}. _(unknown group)_\n`; }
    }
    await sock.sendMessage(jid, { text: out }, { quoted: msg });
    return;
  }

  if (!isGroup) {
    await sock.sendMessage(jid, {
      text: `❌ Use *!antilink on/off* inside the group.\nUse *!antilink list* to see all protected groups.`,
    }, { quoted: msg });
    return;
  }

  if (a === 'on' || a === 'enable') {
    setAntilink(jid, true);
    setAntilinkKick(jid, false);
    await sock.sendMessage(jid, {
      text:
        `✅ *Antilink enabled* for this group.\n\n` +
        `🔗 Links will be deleted automatically.\n` +
        `ℹ️ No warnings or kicks in this mode.\n\n` +
        `Use *!antilink kick* to enable warnings and kicking.\n\n` +
        `_Owner and admins are exempt._`,
    }, { quoted: msg });
    return;
  }

  if (a === 'kick') {
    setAntilink(jid, true);
    setAntilinkKick(jid, true);
    await sock.sendMessage(jid, {
      text:
        `✅ *Antilink kick mode enabled* for this group.\n\n` +
        `⚠️ *Warn system (${MAX_WARNS} warns then kick):*\n` +
        `  • 1st link → Warning 1/3 ⚠️\n` +
        `  • 2nd link → Warning 2/3 ⚠️\n` +
        `  • 3rd link → Warning 3/3 + KICK 🦵\n\n` +
        `_Owner and admins are exempt._`,
    }, { quoted: msg });
    return;
  }

  if (a === 'off' || a === 'disable') {
    setAntilink(jid, false);
    await sock.sendMessage(jid, { text: `🔓 *Antilink disabled* for this group.` }, { quoted: msg });
    return;
  }

  const status = isAntilinkOn(jid) ? '🟢 ON' : '🔴 OFF';
  const mode = isAntilinkKickOn(jid) ? '⚠️ Kick mode' : '🗑️ Delete-only mode';
  await sock.sendMessage(jid, {
    text:
      `🔗 *Antilink Status:* ${status}\n` +
      `Mode: ${mode}\n\n` +
      `  !antilink on        — enable\n` +
      `  !antilink kick      — delete + warn + kick\n` +
      `  !antilink off       — disable\n` +
      `  !antilink list      — all protected groups\n` +
      `  !warn @user         — manually warn user\n` +
      `  !warncount          — see all warns\n` +
      `  !resetwarn @user    — reset user warns`,
  }, { quoted: msg });
}

// ── !warn command — manually warn a user ─────────────────────────────────────

export async function handleWarnCommand(sock, msg, ownerNumber, isBotAdmin = false) {
  const jid = msg.key.remoteJid;
  if (!jid?.endsWith('@g.us')) {
    return sock.sendMessage(jid, { text: '❌ !warn must be used in a group.' }, { quoted: msg });
  }

  // isBotAdmin is already verified by whatsapp.js command dispatcher.
  // Also do a local owner/group-admin check as a fallback.
  const senderRaw = msg.key.participant || msg.key.remoteJid || '';
  const sender    = bareNum(senderRaw);
  const ownerNum  = (ownerNumber || '').replace(/[^0-9]/g, '');
  // Use endsWith on last 9 digits to handle country-code prefix mismatches
  const isOwner   = isBotAdmin ||
    (ownerNum && ownerNum.length >= 9 && sender.endsWith(ownerNum.slice(-9)));

  let isGroupAdmin = false;
  try {
    const meta = await sock.groupMetadata(jid);
    isGroupAdmin = meta.participants.some(
      p => bareNum(p.id) === sender && (p.admin === 'admin' || p.admin === 'superadmin'),
    );
  } catch {}

  if (!isOwner && !isGroupAdmin) {
    return sock.sendMessage(jid, { text: '❌ Only the owner or group admin can warn users.' }, { quoted: msg });
  }

  // Get the mentioned/tagged user
  const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentions.length) {
    return sock.sendMessage(jid, {
      text: `❌ *Usage:* !warn @user\n\nTag the user you want to warn.`,
    }, { quoted: msg });
  }

  const targetJid = mentions[0];
  const targetNum = bareNum(targetJid);
  const count     = incrementWarn(jid, targetNum);

  await doWarn(sock, jid, targetJid, count);
}

// ── !warncount command — show all warns ───────────────────────────────────────

export async function handleWarnCount(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid?.endsWith('@g.us')) {
    return sock.sendMessage(jid, { text: '❌ !warncount must be used in a group.' }, { quoted: msg });
  }

  const warns = getAllWarns(jid);
  if (!warns.length) {
    return sock.sendMessage(jid, { text: `✅ *No active warnings* in this group.` }, { quoted: msg });
  }

  let text = `⚠️ *Active Warnings in this group:*\n\n`;
  warns.forEach(({ num, count }) => {
    text += `@${num}  —  ⚠️ ${count}/${MAX_WARNS}\n`;
  });
  text += `\n_Use !resetwarn @user to clear warns_`;
  const mentions = warns.map(w => `${w.num}@s.whatsapp.net`);
  await sock.sendMessage(jid, { text, mentions }, { quoted: msg });
}

// ── !resetwarn command ────────────────────────────────────────────────────────

export async function handleResetWarn(sock, msg, ownerNumber) {
  const jid = msg.key.remoteJid;
  if (!jid?.endsWith('@g.us')) {
    return sock.sendMessage(jid, { text: '❌ Must be used in a group.' }, { quoted: msg });
  }

  const senderRaw = msg.key.participant || msg.key.remoteJid || '';
  const sender    = bareNum(senderRaw);
  const ownerNum  = (ownerNumber || '').replace(/[^0-9]/g, '');
  const isOwner   = ownerNum && sender === ownerNum;

  let isGroupAdmin = false;
  try {
    const meta = await sock.groupMetadata(jid);
    isGroupAdmin = meta.participants.some(
      p => bareNum(p.id) === sender && (p.admin === 'admin' || p.admin === 'superadmin'),
    );
  } catch {}

  if (!isOwner && !isGroupAdmin) {
    return sock.sendMessage(jid, { text: '❌ Only the owner or group admin can reset warns.' }, { quoted: msg });
  }

  const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentions.length) {
    return sock.sendMessage(jid, {
      text: `❌ *Usage:* !resetwarn @user`,
    }, { quoted: msg });
  }

  const targetJid = mentions[0];
  const targetNum = bareNum(targetJid);
  resetWarnForUser(jid, targetNum);

  await sock.sendMessage(jid, {
    text: `✅ Warns reset for @${targetNum}`,
    mentions: [targetJid],
  }, { quoted: msg });
}
