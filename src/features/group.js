/**
 * Group Management Commands
 * !kick @user    — remove member (admin only)
 * !add number    — add member (admin only)
 * !promote @user — make admin (admin only)
 * !demote @user  — remove admin (admin only)
 * !groupinfo     — show group details
 * !tagall        — mention all members
 * !mute          — disable messaging (admin only)
 * !unmute        — enable messaging (admin only)
 */

function getBotJid(sock) {
  const raw = sock.user?.id || '';
  const number = raw.split(':')[0].split('@')[0];
  return `${number}@s.whatsapp.net`;
}

function getMentions(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  return ctx?.mentionedJid || [];
}

async function getGroupInfo(sock, jid) {
  const meta   = await sock.groupMetadata(jid);
  const botJid = getBotJid(sock);
  const botP   = meta.participants.find(p => p.id === botJid || p.id.startsWith(botJid.split('@')[0]));
  return { meta, botJid, isBotAdmin: !!(botP?.admin) };
}

function getSenderJid(msg) {
  const raw = msg.key.participant || msg.key.remoteJid;
  const num  = raw.split('@')[0];
  return `${num}@s.whatsapp.net`;
}

function isAdmin(meta, jid) {
  return meta.participants.some(p => (p.id === jid || p.id.startsWith(jid.split('@')[0])) && p.admin);
}

export async function handleGroup(sock, msg, cmd, args, ownerNumber) {
  const jid     = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');

  if (!isGroup) {
    await sock.sendMessage(jid, { text: '❌ This command only works inside a group.' });
    return;
  }

  const sender       = getSenderJid(msg);
  const ownerClean   = (ownerNumber || '').replace(/[^0-9]/g, '');
  const senderNum    = sender.replace(/[^0-9]/g, '');
  const senderIsOwner = ownerClean && senderNum.includes(ownerClean);

  const { meta, botJid, isBotAdmin } = await getGroupInfo(sock, jid).catch(() => null) || {};
  if (!meta) {
    await sock.sendMessage(jid, { text: '❌ Could not fetch group info.' });
    return;
  }

  const senderIsAdmin = isAdmin(meta, sender) || senderIsOwner;

  // ── Commands that don't need admin ─────────────────────────────────────────
  if (cmd === 'groupinfo') {
    const admins = meta.participants.filter(p => p.admin).length;
    await sock.sendMessage(jid, {
      text:
        `👥 *Group Info*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `📌 *Name:* ${meta.subject}\n` +
        `👤 *Members:* ${meta.participants.length}\n` +
        `🛡️ *Admins:* ${admins}\n` +
        `📅 *Created:* ${new Date(meta.creation * 1000).toDateString()}\n` +
        `🆔 *ID:* ${jid.split('@')[0]}`,
    }, { quoted: msg });
    return;
  }

  if (cmd === 'tagall') {
    if (!senderIsAdmin) { await sock.sendMessage(jid, { text: '❌ Admins only.' }); return; }
    const mentions = meta.participants.map(p => p.id);
    const text     = `📣 *${meta.subject}*\n\n` + mentions.map(m => `@${m.split('@')[0]}`).join(' ');
    await sock.sendMessage(jid, { text, mentions }, { quoted: msg });
    return;
  }

  // ── Admin-only commands ─────────────────────────────────────────────────────
  if (!senderIsAdmin) {
    await sock.sendMessage(jid, { text: '❌ Only group admins can use this command.' });
    return;
  }

  if (cmd === 'kick') {
    if (!isBotAdmin) { await sock.sendMessage(jid, { text: '❌ Make me an admin first.' }); return; }
    const targets = getMentions(msg);
    if (!targets.length) { await sock.sendMessage(jid, { text: `❌ Usage: *!kick @user*` }); return; }
    await sock.groupParticipantsUpdate(jid, targets, 'remove');
    await sock.sendMessage(jid, { text: `✅ Removed ${targets.length} member(s).` }, { quoted: msg });
    return;
  }

  if (cmd === 'add') {
    if (!isBotAdmin) { await sock.sendMessage(jid, { text: '❌ Make me an admin first.' }); return; }
    const num = args.replace(/[^0-9]/g, '');
    if (!num) { await sock.sendMessage(jid, { text: `❌ Usage: *!add 2348012345678*` }); return; }
    const target = `${num}@s.whatsapp.net`;
    await sock.groupParticipantsUpdate(jid, [target], 'add');
    await sock.sendMessage(jid, { text: `✅ Added +${num} to the group.` }, { quoted: msg });
    return;
  }

  if (cmd === 'promote') {
    if (!isBotAdmin) { await sock.sendMessage(jid, { text: '❌ Make me an admin first.' }); return; }
    const targets = getMentions(msg);
    if (!targets.length) { await sock.sendMessage(jid, { text: `❌ Usage: *!promote @user*` }); return; }
    await sock.groupParticipantsUpdate(jid, targets, 'promote');
    await sock.sendMessage(jid, { text: `✅ Promoted ${targets.length} member(s) to admin.` }, { quoted: msg });
    return;
  }

  if (cmd === 'demote') {
    if (!isBotAdmin) { await sock.sendMessage(jid, { text: '❌ Make me an admin first.' }); return; }
    const targets = getMentions(msg);
    if (!targets.length) { await sock.sendMessage(jid, { text: `❌ Usage: *!demote @user*` }); return; }
    await sock.groupParticipantsUpdate(jid, targets, 'demote');
    await sock.sendMessage(jid, { text: `✅ Demoted ${targets.length} member(s).` }, { quoted: msg });
    return;
  }

  if (cmd === 'mute') {
    if (!isBotAdmin) { await sock.sendMessage(jid, { text: '❌ Make me an admin first.' }); return; }
    await sock.groupSettingUpdate(jid, 'announcement');
    await sock.sendMessage(jid, { text: '🔇 Group muted — only admins can send messages.' }, { quoted: msg });
    return;
  }

  if (cmd === 'unmute') {
    if (!isBotAdmin) { await sock.sendMessage(jid, { text: '❌ Make me an admin first.' }); return; }
    await sock.groupSettingUpdate(jid, 'not_announcement');
    await sock.sendMessage(jid, { text: '🔊 Group unmuted — everyone can send messages.' }, { quoted: msg });
    return;
  }
}
