import axios from 'axios';

const API = 'https://api.botcahx.eu.org/api/dowloader/telesticker';
const API_KEY = 'GMauog6R';
const URL_RE = /^https?:\/\/t\.me\/addstickers\/[\w-]+/i;

export async function handleTelesticker(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const input = String(args || '').trim();
  if (!input || !URL_RE.test(input)) {
    return sock.sendMessage(jid, {
      text: 'Usage: *!telesticker https://t.me/addstickers/packname*',
    }, { quoted: msg });
  }

  try {
    await sock.sendMessage(jid, { text: '🧩 Fetching Telegram sticker pack...' }, { quoted: msg });
    const { data } = await axios.get(API, {
      params: { url: input, apikey: API_KEY },
      timeout: 60_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!data?.status) throw new Error(data?.message || 'Telegram sticker API returned an error.');
    const rows = Array.isArray(data.result) ? data.result : [];
    if (!rows.length) throw new Error('No stickers were returned.');

    let sent = 0;
    for (const row of rows.slice(0, 30)) {
      const stickerUrl = typeof row === 'string' ? row : row?.url || row?.sticker;
      if (!stickerUrl) continue;
      try {
        const response = await axios.get(stickerUrl, {
          responseType: 'arraybuffer',
          timeout: 30_000,
          maxContentLength: 2 * 1024 * 1024,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        await sock.sendMessage(jid, { sticker: Buffer.from(response.data) });
        sent++;
      } catch (error) {
        console.warn(`[TeleSticker] skipped sticker: ${error.message}`);
      }
    }
    if (!sent) throw new Error('The sticker files could not be downloaded.');
    return sock.sendMessage(jid, {
      text: `✅ Sent ${sent} sticker${sent === 1 ? '' : 's'} from the Telegram pack.`,
    });
  } catch (error) {
    console.error('[TeleSticker] error:', error.message);
    return sock.sendMessage(jid, {
      text: `❌ *Telegram sticker download failed.*\n_${error.message}_`,
    }, { quoted: msg });
  }
}