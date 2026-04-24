import ytSearch from 'yt-search';
import axios    from 'axios';

const YTDL_API = 'https://yt-dl.officialhectormanuel.workers.dev';
const YT_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))([\w-]{11})/;

// Pick the best quality that WhatsApp can handle (≤ 360p to stay under size limits)
function pickVideoQuality(videos, available) {
  const preferred = ['360', '240', '480', '144', '720'];
  for (const q of preferred) {
    if (videos[q] && available.includes(q)) return { url: videos[q], quality: q };
  }
  // Fallback: first available
  const first = available.find(q => videos[q]);
  return first ? { url: videos[first], quality: first } : null;
}

export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  try {
    let videoUrl = '';
    let title    = '';

    if (YT_REGEX.test(query)) {
      videoUrl = query;
    } else {
      await sock.sendMessage(jid, { text: `🔍 Searching YouTube for: *${query}*...` });
      const results = await ytSearch(query);
      const video   = results.videos[0];
      if (!video) {
        await sock.sendMessage(jid, { text: `❌ No results found for *"${query}"*` });
        return;
      }
      videoUrl = video.url;
      title    = video.title;
    }

    await sock.sendMessage(jid, { text: `📹 Fetching video info...` });

    // Get download links from the API
    const res  = await axios.get(`${YTDL_API}/`, {
      params:  { url: videoUrl },
      timeout: 20000,
    });
    const data = res.data;

    if (!data?.status) throw new Error('API returned error status');
    title = data.title || title;

    const pick = pickVideoQuality(data.videos || {}, data.available_qualities || []);
    if (!pick) throw new Error('No downloadable video quality found');

    await sock.sendMessage(jid, {
      text: `📹 *${title}*\n🎞️ Quality: ${pick.quality}p\n📥 Downloading...`,
    });

    // Download the video binary
    const videoRes = await axios.get(pick.url, {
      responseType: 'arraybuffer',
      timeout:      120000,
      headers:      { 'User-Agent': 'Mozilla/5.0' },
    });

    const buf = Buffer.from(videoRes.data);
    if (buf.length < 1000) throw new Error('Downloaded file too small');

    await sock.sendMessage(jid, {
      video:    buf,
      caption:  `📹 *${title}*\n_${pick.quality}p • Powered by Queen MD Bot_`,
      mimetype: 'video/mp4',
    }, { quoted: msg });

  } catch (err) {
    console.error('YouTube error:', err.message);
    await sock.sendMessage(jid, {
      text:
        `❌ Could not download video.\n\n` +
        `Try:\n• A direct YouTube link\n• A shorter video (under 5 min)`,
    });
  }
}
