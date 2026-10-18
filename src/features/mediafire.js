import axios from 'axios';

const API = 'https://apis.davidcyriltech.my.id/mediafire';
const URL_RE = /mediafire\.com\//i;
const MAX_BYTES = 100 * 1024 * 1024;

function pickDownload(data) {
  const result = data?.result || data?.data || data;
  return {
    title: result?.title || result?.filename || result?.fileName || 'MediaFire file',
    url: result?.download || result?.download_url || result?.downloadUrl ||
      result?.url || result?.link,
  };
}

export async function handleMediafire(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const input = String(args || '').trim();
  if (!input || !URL_RE.test(input)) {
    return sock.sendMessage(jid, {
      text: 'Usage: *!mediafire <MediaFire file link>*',
    }, { quoted: msg });
  }

  try {
    await sock.sendMessage(jid, { text: '🔍 Fetching MediaFire file...' }, { quoted: msg });
    const { data } = await axios.get(API, {
      params: { url: input },
      timeout: 45_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (data?.success === false || data?.status === false) {
      throw new Error(data?.message || 'MediaFire API returned an error.');
    }
    const file = pickDownload(data);
    if (!file.url) throw new Error('No MediaFire download URL was returned.');

    const response = await axios.get(file.url, {
      responseType: 'arraybuffer',
      timeout: 180_000,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const buffer = Buffer.from(response.data);
    const contentType = response.headers?.['content-type'] || 'application/octet-stream';
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
    return sock.sendMessage(jid, {
      document: buffer,
      mimetype: contentType,
      fileName: file.title,
      caption: `✅ *${file.title}*\n📦 ${sizeMb} MB`,
    }, { quoted: msg });
  } catch (error) {
    console.error('[MediaFire] error:', error.message);
    return sock.sendMessage(jid, {
      text: `❌ *MediaFire download failed.*\n_${error.message}_`,
    }, { quoted: msg });
  }
}