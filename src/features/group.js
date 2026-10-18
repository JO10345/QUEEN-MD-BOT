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
  return sock.user?.id || sock.user?.lid || sock.user?.phoneNumber || '';
}

function normalizeJid(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const at = raw.lastIndexOf('@');
  return at >= 0
    ? `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`
    : raw.split(':')[0];
}

function jidAliases(value) {
  const values = Array.isArray(value) ? value : [value];
  const aliases = new Set();
  for (const item of values) {
    if (typeof item === 'string') {
      const normalized = normalizeJid(item);
      if (normalized) aliases.add(normalized);
    } else if (item && typeof item === 'object') {
      for (const id of [item.id, item.phoneNumber, item.lid, item.jid]) {
        const normalized = normalizeJid(id);
        if (normalized) aliases.add(normalized);
      }
    }
  }
  return aliases;
}

function sameIdentity(left, right) {
  const rightAliases = jidAliases(right);
  return [...jidAliases(left)].some(id => rightAliases.has(id));
}

function phoneDigits(value) {
  const candidates = [...jidAliases(value)];
  const pn = candidates.find(id =>
    id.endsWith('@s.whatsapp.net') || id.endsWith('@c.us'),
  );
  return pn ? pn.slice(0, pn.lastIndexOf('@')).replace(/\D/g, '') : '';
}

function getMentions(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  return ctx?.mentionedJid || [];
}

async function getGroupInfo(sock, jid) {
  const fetchMeta = () => sock.groupMetadata(jid);

  let meta = await fetchMeta();
  let botP = meta.participants.find(p => sameIdentity(p, sock.user));

  // Stale-cache retry: if the first fetch says the bot is not admin, re-fetch
  // once after a short wait. Group metadata is cached by Baileys and can lag
  // behind reality by several seconds after the bot is made admin, causing the
  // admin gate to wrongly block commands even when the bot has full rights.
  if (!botP?.admin) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      meta = await fetchMeta();
      botP = meta.participants.find(p => sameIdentity(p, sock.user));
    } catch {
      // ignore — keep the first result
    }
  }

  return { meta, botJid: getBotJid(sock), isBotAdmin: !!(botP?.admin) };
}

function getSenderJids(msg) {
  return [
    msg.key?.participant,
    msg.key?.participantAlt,
    msg.key?.remoteJidAlt,
    msg.key?.remoteJid?.endsWith('@g.us') ? null : msg.key?.remoteJid,
  ].filter(Boolean);
}

function bareNum(jid) {
  if (!jid) return '';
  return jid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
}

function isAdmin(meta, jid) {
  // v7 can identify a participant by LID and expose the phone JID separately.
  // Match any exact ID/alternate instead of coercing a LID into a fake number.
  return meta.participants.some(p => sameIdentity(p, jid) && p.admin);
}

export async function handleGroup(sock, msg, cmd, args, ownerNumber) {
  const jid     = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');

  if (!isGroup) {
    await sock.sendMessage(jid, { text: '❌ This command only works inside a group.' });
    return;
  }

  const sender       = getSenderJids(msg);
  const ownerClean   = (ownerNumber || '').replace(/[^0-9]/g, '');
  const senderIsOwner =
    sameIdentity(sender, sock.user) ||
    (ownerClean.length >= 9 && sender.some(id => {
      const digits = phoneDigits(id);
      return digits.length >= 9 && digits.slice(-9) === ownerClean.slice(-9);
    }));

  const { meta, botJid, isBotAdmin } = await getGroupInfo(sock, jid).catch(() => null) || {};
  if (!meta) {
    await sock.sendMessage(jid, { text: '❌ Could not fetch group info.' });
    return;
  }

  const senderIsAdmin = isAdmin(meta, sender) || senderIsOwner;

  // If the bot runs on the SAME number as the owner and that number is a group
  // admin, treat the bot as having admin rights (same account = same permissions).
  const effectiveBotAdmin = isBotAdmin || (senderIsOwner && senderIsAdmin);

  // Mention every member with a compact live group status. This is read-only
  // and intentionally available to regular group members.
  if (cmd === 'gcstatus') {
    const mentions = meta.participants.map(p => p.id);
    const admins = meta.participants.filter(p => p.admin).length;
    const mentionText = mentions.map(id => `@${id.split('@')[0].split(':')[0]}`).join(' ');
    await sock.sendMessage(jid, {
      text:
        `📢 *${meta.subject} — Group Status*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `👥 Members: *${meta.participants.length}*\n` +
        `🛡️ Admins: *${admins}*\n\n${mentionText}`,
      mentions,
    }, { quoted: msg });
    return;
  }

  // ── !botinfo — no permission needed, anyone can run it ────────────────────
  if (cmd === 'botinfo') {
    const botNum    = bareNum(botJid);
    const rawBotId  = sock.user?.id || 'unknown';
    const adminList = meta.participants
      .filter(p => p.admin)
      .map(p => `  • +${bareNum(p.id)} (${p.admin})`)
      .join('\n') || '  (none)';
    const senderNum = bareNum(msg.key.participantAlt || msg.key.participant || msg.key.remoteJid || '');
    await sock.sendMessage(jid, {
      text:
        `🤖 *Bot Diagnostic*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 *Bot raw ID:* ${rawBotId}\n` +
        `📱 *Bot number:* +${botNum}\n` +
        `🛡️ *Bot is admin:* ${isBotAdmin ? '✅ YES' : '❌ NO — open group info → make +' + botNum + ' an admin'}\n` +
        `👤 *Your number:* +${senderNum}\n` +
        `👤 *You are admin:* ${senderIsAdmin ? '✅ YES' : '❌ NO'}\n\n` +
        `*Current admins in group:*\n${adminList}`,
    }, { quoted: msg });
    return;
  }

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

  // Helper: reusable "bot needs admin" reply with the bot's number
  const needBotAdmin = () =>
    sock.sendMessage(jid, {
      text:
        `❌ *Bot needs admin rights!*\n\n` +
        `Please make *+${bareNum(botJid)}* an admin in this group, then try again.\n\n` +
        `_Tip: send *!botinfo* to check the bot's current status._`,
    }, { quoted: msg });

  if (cmd === 'kick') {
    if (!effectiveBotAdmin) { await needBotAdmin(); return; }
    const targets = getMentions(msg);
    if (!targets.length) { await sock.sendMessage(jid, { text: `❌ Usage: *!kick @user*` }); return; }
    await sock.groupParticipantsUpdate(jid, targets, 'remove');
    await sock.sendMessage(jid, { text: `✅ Removed ${targets.length} member(s).` }, { quoted: msg });
    return;
  }

  if (cmd === 'add') {
    if (!effectiveBotAdmin) { await needBotAdmin(); return; }
    const num = args.replace(/[^0-9]/g, '');
    if (!num) { await sock.sendMessage(jid, { text: `❌ Usage: *!add 2348012345678*` }); return; }
    const target = `${num}@s.whatsapp.net`;
    await sock.groupParticipantsUpdate(jid, [target], 'add');
    await sock.sendMessage(jid, { text: `✅ Added +${num} to the group.` }, { quoted: msg });
    return;
  }

  if (cmd === 'promote') {
    if (!effectiveBotAdmin) { await needBotAdmin(); return; }
    const targets = getMentions(msg);
    if (!targets.length) { await sock.sendMessage(jid, { text: `❌ Usage: *!promote @user*` }); return; }
    await sock.groupParticipantsUpdate(jid, targets, 'promote');
    await sock.sendMessage(jid, { text: `✅ Promoted ${targets.length} member(s) to admin.` }, { quoted: msg });
    return;
  }

  if (cmd === 'demote') {
    if (!effectiveBotAdmin) { await needBotAdmin(); return; }
    const targets = getMentions(msg);
    if (!targets.length) { await sock.sendMessage(jid, { text: `❌ Usage: *!demote @user*` }); return; }
    await sock.groupParticipantsUpdate(jid, targets, 'demote');
    await sock.sendMessage(jid, { text: `✅ Demoted ${targets.length} member(s).` }, { quoted: msg });
    return;
  }

  if (cmd === 'mute') {
    try {
      await sock.groupSettingUpdate(jid, 'announcement');
      await sock.sendMessage(jid, { text: '🔇 Group muted — only admins can send messages.' }, { quoted: msg });
    } catch (err) {
      await sock.sendMessage(jid, {
        text: `❌ Could not mute group.\nReason: ${err.message}\n\nMake sure *+${bareNum(botJid)}* is a group admin.`,
      }, { quoted: msg });
    }
    return;
  }

  if (cmd === 'unmute') {
    try {
      await sock.groupSettingUpdate(jid, 'not_announcement');
      await sock.sendMessage(jid, { text: '🔊 Group unmuted — everyone can send messages.' }, { quoted: msg });
    } catch (err) {
      await sock.sendMessage(jid, {
        text: `❌ Could not unmute group.\nReason: ${err.message}\n\nMake sure *+${bareNum(botJid)}* is a group admin.`,
      }, { quoted: msg });
    }
    return;
  }
}
