import { downloadMediaMessage } from '@whiskeysockets/baileys';
import sharp from 'sharp';

export async function handleSticker(sock, msg) {
  const jid = msg.key.remoteJid;
  const m   = msg.message;
  const inner =
    m?.ephemeralMessage?.message  ||
    m?.viewOnceMessage?.message   ||
    m?.viewOnceMessageV2?.message ||
    m;

  const imageMsg = inner?.imageMessage;
  const quoted   = m?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasImage = !!imageMsg || !!quoted?.imageMessage;

  if (!hasImage) {
    await sock.sendMessage(jid, {
      text:
        `❌ *How to make a sticker:*\n\n` +
        `1. Send an image\n` +
        `2. Type *!sticker* as the caption\n\n` +
        `Or reply to an existing image with *!sticker*`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: '⏳ Creating sticker...' });

    const target = imageMsg ? msg : { message: quoted, key: msg.key };
    const buffer = await downloadMediaMessage(
      imageMsg ? msg : { message: { imageMessage: quoted.imageMessage }, key: msg.key },
      'buffer',
      {}
    );

    const webpBuffer = await sharp(buffer)
      .resize(512, 512, {
        fit:        'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 80 })
      .toBuffer();

    await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: msg });
  } catch (err) {
    console.error('Sticker error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Could not create sticker.\n${err.message}`,
    });
  }
}
