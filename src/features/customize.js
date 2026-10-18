import axios from 'axios';

// ─── Get the bot's own JID without changing PN/LID addressing ────────────────
function getBotJid(sock) {
  const raw = sock.user?.id || sock.user?.lid || sock.user?.phoneNumber || '';
  if (!raw) return '';
  const at = raw.lastIndexOf('@');
  return at >= 0
    ? `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`
    : raw.split(':')[0];
}

// ─── Apply all customizations on startup ─────────────────────────────────────
// Profile picture is intentionally NOT updated automatically on every connect.
// Auto-updating profile pics annoys users and can trigger WA anti-bot checks.
// Use !setppbot in chat to change the profile picture manually if needed.
export async function applyBotCustomization(sock) {
  const botBio = process.env.BOT_BIO || '👑 Queen MD Bot | !help for commands';

  await new Promise(r => setTimeout(r, 3000));

  try {
    await sock.updateProfileStatus(botBio);
    console.log(`✅ Bot bio set: "${botBio}"`);
  } catch (err) {
    console.error('⚠️  Could not set bot bio:', err.message);
  }
}

// ─── Set bot profile picture from a URL ──────────────────────────────────────
export async function setBotImage(sock, imageUrl) {
  try {
    const jid      = getBotJid(sock);
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const buffer   = Buffer.from(response.data);
    await sock.updateProfilePicture(jid, buffer);
    console.log(`✅ Bot profile picture updated (jid: ${jid})`);
    return true;
  } catch (err) {
    console.error('⚠️  Could not set profile picture:', err.message);
    return false;
  }
}

// ─── Set bot profile picture from an image sent in chat ──────────────────────
export async function setBotImageFromMessage(sock, msg) {
  try {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const jid    = getBotJid(sock);
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    await sock.updateProfilePicture(jid, buffer);
    console.log(`✅ Bot profile picture updated from message (jid: ${jid})`);
    return true;
  } catch (err) {
    console.error('⚠️  Could not set profile picture from message:', err.message);
    return false;
  }
}

// ─── Bot info card ────────────────────────────────────────────────────────────
export function getBotInfoCard() {
  const botName    = process.env.BOT_NAME     || 'Queen MD Bot';
  const botVersion = process.env.BOT_VERSION  || '1.0.0';
  const prefix     = process.env.PREFIX       || '!';
  const owner      = process.env.OWNER_NUMBER || 'Not set';

  return (
    `╔══════════════════════════╗\n` +
    `║     👑 *${botName}*\n` +
    `╠══════════════════════════╣\n` +
    `║  🛠️ *Created by:* TECH\n` +
    `║  👤 *Owner:* fizu\n` +
    `╚══════════════════════════╝\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 *Version*   : ${botVersion}\n` +
    `⌨️  *Prefix*    : ${prefix}\n` +
    `📱 *Owner No.* : +${owner}\n` +
    `🌐 *Platform*  : WhatsApp MD\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Send *${prefix}help* to see all commands.`
  );
}
