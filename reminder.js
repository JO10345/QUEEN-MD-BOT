/**
 * Reminder Feature
 * Usage: !remind <time> <message>
 * Time formats: 10s, 5m, 2h, 1d
 * Examples:
 *   !remind 10m Check the oven
 *   !remind 2h Team meeting
 *   !remind 1d Happy birthday!
 */

function parseTime(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit  = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}

function formatDuration(ms) {
  if (ms >= 86400000) return `${Math.round(ms / 86400000)} day(s)`;
  if (ms >= 3600000)  return `${Math.round(ms / 3600000)} hour(s)`;
  if (ms >= 60000)    return `${Math.round(ms / 60000)} minute(s)`;
  return `${Math.round(ms / 1000)} second(s)`;
}

export async function handleReminder(sock, msg, args) {
  const jid    = msg.key.remoteJid;
  const parts  = args.trim().split(/\s+/);
  const timeStr = parts[0];
  const text    = parts.slice(1).join(' ');

  if (!timeStr || !text) {
    await sock.sendMessage(jid, {
      text:
        `⏰ *Reminder Usage:*\n` +
        `!remind <time> <message>\n\n` +
        `*Time formats:*\n` +
        `  10s  — 10 seconds\n` +
        `  5m   — 5 minutes\n` +
        `  2h   — 2 hours\n` +
        `  1d   — 1 day\n\n` +
        `*Examples:*\n` +
        `  !remind 10m Check the oven\n` +
        `  !remind 2h Team meeting\n` +
        `  !remind 30s Timer done`,
    }, { quoted: msg });
    return;
  }

  const ms = parseTime(timeStr);
  if (!ms) {
    await sock.sendMessage(jid, {
      text: `❌ Invalid time format.\nUse: *10s*, *5m*, *2h*, *1d*`,
    });
    return;
  }

  if (ms > 7 * 86400000) {
    await sock.sendMessage(jid, {
      text: `❌ Maximum reminder time is *7 days*.`,
    });
    return;
  }

  const humanTime = formatDuration(ms);
  const sender    = msg.key.participant || jid;

  await sock.sendMessage(jid, {
    text: `✅ *Reminder set!*\n⏰ I'll remind you in *${humanTime}*\n📝 "${text}"`,
  }, { quoted: msg });

  setTimeout(async () => {
    try {
      const mention = sender !== jid ? [sender] : [];
      const pingText = sender !== jid ? `@${sender.split('@')[0]} ` : '';
      await sock.sendMessage(jid, {
        text: `⏰ *REMINDER* ${pingText}\n\n📝 "${text}"`,
        mentions: mention,
      });
    } catch (err) {
      console.error('Reminder send error:', err.message);
    }
  }, ms);
}
