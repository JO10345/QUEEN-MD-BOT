/**
 * Group Welcome / Farewell
 *
 * Sends a detailed group card when members join or leave.
 * Toggle: !welcome on | off
 *
 * The toggle is stored per group so enabling it in one group does not affect
 * any other group.
 */

import { getState, setState } from './state.js';

const KEY = 'welcome_groups';

function loadGroups() {
  return new Set(getState(KEY, []));
}

function saveGroups(groups) {
  setState(KEY, [...groups]);
}

export function isWelcomeEnabled(groupJid) {
  return Boolean(groupJid && loadGroups().has(groupJid));
}

export function setWelcome(groupJid, enabled) {
  if (!groupJid?.endsWith('@g.us')) return;
  const groups = loadGroups();
  if (enabled) groups.add(groupJid);
  else groups.delete(groupJid);
  saveGroups(groups);
}

function participantJid(value) {
  const raw = typeof value === 'string' ? value : (value?.id || value?.jid || '');
  if (!raw) return '';
  // Keep @lid JIDs intact. Converting them to @s.whatsapp.net breaks mentions
  // on newer WhatsApp accounts.
  return raw.includes('@') ? raw : `${raw}@s.whatsapp.net`;
}

function numberPart(jid) {
  return (jid || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
}

function dateText(value = Date.now()) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    timeZone: 'Asia/Karachi',
  }).format(new Date(value));
}

function groupRules(description) {
  const clean = String(description || '').replace(/\s+/g, ' ').trim();
  if (clean) return clean.slice(0, 220);
  return 'No forbidden links ❌\nNo adult content 🔞\nNo spamming 🚫';
}

/**
 * Handle a group-participants.update event for add/remove actions.
 * @param {object} sock Baileys socket
 * @param {string} id Group JID
 * @param {string[]} participants Array of participant JIDs
 * @param {'add'|'remove'} action
 * @param {Function} getContactName (jid) => name | null
 */
export async function handleGroupWelcome(sock, id, participants, action, getContactName) {
  if (!isWelcomeEnabled(id)) return;
  if (action !== 'add' && action !== 'remove') return;

  try {
    const meta = await sock.groupMetadata(id).catch(() => null);
    const subject = meta?.subject || 'Our Group';
    const members = meta?.participants?.length || 0;
    const created = meta?.creation ? dateText(meta.creation * 1000) : '—';
    const today = dateText();

    // Preserve the exact participant JID, including @lid, so the mention
    // remains clickable and the joining/leaving person gets notified.
    const rawParticipants = participants
      .map(p => typeof p === 'string' ? p : (p?.id || p?.jid || ''))
      .filter(Boolean);
    const mentions = rawParticipants.map(participantJid);
    const tags = rawParticipants.map((p, i) => {
      const mJid = mentions[i];
      const name = getContactName?.(p);
      const num = numberPart(mJid);
      return name ? `@${num}` : `@${num || 'member'}`;
    }).join(', ');

    let text;
    if (action === 'add') {
      text =
        `╭━━━〔 🎉 *WELCOME* 〕━━━╮\n` +
        `┃ 👤 ${tags}\n` +
        `┃ 🌟 *APKA WELCOME HOGIYA!*\n` +
        `┃\n` +
        `┃ 🎓 Group: *${subject}* 🤖\n` +
        `┃ 👥 Members: *${members}*\n` +
        `┃ 🗓️ Created on: *${created}*\n` +
        `┃ 📅 Date: *${today}*\n` +
        `┃\n` +
        `┃ 📜 *Rules:*\n` +
        `┃ └ ${groupRules(meta?.desc).replace(/\n/g, '\n┃ └ ')}\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        `💖 _Group mein khush amdeed! Tamam rules ka khayal rakhein._`;
    } else {
      text =
        `╭━━━〔 😢 *FAREWELL* 〕━━━╮\n` +
        `┃ 👤 ${tags}\n` +
        `┃ 💔 *BHOT DUKH HUWA GROUP CHORNY KA*\n` +
        `┃\n` +
        `┃ 🎓 Group: *${subject}*\n` +
        `┃ 👥 Members now: *${members}*\n` +
        `┃ 📅 Date: *${today}*\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        `🙏 _Shayad phir milein... Good luck!_`;
    }

    await sock.sendMessage(id, mentions.length ? { text, mentions } : { text });
  } catch (err) {
    console.warn(`⚠️ welcome/farewell notification failed: ${err.message}`);
  }
}