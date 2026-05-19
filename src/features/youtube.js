/**
 * YouTube Feature — search by name OR download by URL.
 *
 * Search:   https://api.yupra.my.id/api/search/youtube?q=
 * Download: https://api.botcahx.eu.org/api/dowloader/yt?url=&apikey=GMauog6R
 *
 * Flow:
 *   1. !yt <url or query>  → bot shows title + "Video" / "Audio" options
 *   2. !ytdl 1             → download MP4 video
 *   3. !ytdl 2             → download MP3 audio
 *
 * Also: !yts <query>  → shows top 5 results
 */

import axios from 'axios';

const BOTCAHX_KEY  = 'GMauog6R';
const SEARCH_URL   = 'https://api.yupra.my.id/api/search/youtube';
const DOWNLOAD_URL = 'https://api.botcahx.eu.org/api/dowloader/yt';

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// Per-chat pending state: jid → { mp4, mp3, title, duration }
const pending = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isYoutubeUrl(s) { return YT_URL_RE.test(s || ''); }

function fmtDuration(sec) {
  const s = parseInt(sec || 0);
  if (!s) return '';
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

// ── Search ────────────────────────────────────────────────────────────────────

async function searchYouTube(query) {
  const { data } = await axios.get(SEARCH_URL, {
    params: { q: query }, timeout: 18_000,
  });
  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('No search results found. Try a different keyword.');
  }
  return results.map(r => ({
    title:     r.title     || '',
    url:       r.url       || '',
    channel:   r.channel   || '',
    duration:  r.duration  || '',
    views:     r.views     || '',
    thumbnail: r.thumbnail || '',
  }));
}

// ── Download info ─────────────────────────────────────────────────────────────

async function getDownloadInfo(videoUrl) {
  const { data } = await axios.get(DOWNLOAD_URL, {
    params: { url: videoUrl, apikey: BOTCAHX_KEY },
    timeout: 30_000,
  });
  if (!data?.status) throw new Error(data?.message || 'Download API returned an error.');
  const r = data.result;
  if (!r) throw new Error('No result from download API.');
  return {
    title:    r.title || 'YouTube Video',
    thumb:    r.thumb || '',
    duration: fmtDuration(r.duration),
    mp4:      r.mp4   || '',
    mp3:      r.mp3   || '',
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text:
        `❌ *Usage:*\n` +
        `• *!yt <YouTube link>* — get download options\n` +
        `• *!yt <search query>* — search and pick\n` +
        `• *!yts <query>* — show top 5 results\n` +
        `• *!ytdl 1* — download as Video (MP4)\n` +
        `• *!ytdl 2* — download as Audio (MP3)`,
    }, { quoted: msg });
    return;
  }

  try {
    let videoUrl;

    if (isYoutubeUrl(query)) {
      videoUrl = query.trim();
      await sock.sendMessage(jid, { text: `🔍 *Fetching video info...*` });
    } else {
      await sock.sendMessage(jid, { text: `🔎 *Searching YouTube for:* _${query}_` });
      const results = await searchYouTube(query);
      const top = results[0];
      videoUrl = top.url;
      if (!videoUrl) throw new Error('No video URL from search result.');

      let info = `🎬 *Found:* ${top.title}`;
      if (top.duration) info += `\n⏱️ ${top.duration}`;
      if (top.channel)  info += `  ·  👤 ${top.channel}`;
      if (top.views)    info += `\n👁️ ${top.views}`;
      await sock.sendMessage(jid, { text: info + `\n\n_Getting download link..._` });
    }

    const info = await getDownloadInfo(videoUrl);
    pending.set(jid, { ...info, url: videoUrl });

    const menu =
      `🎬 *${info.title}*\n` +
      (info.duration ? `⏱️ ${info.duration}\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📥 *Choose format:*\n\n` +
      `  *1.* 📹 Video (MP4)\n` +
      `  *2.* 🎵 Audio (MP3)\n\n` +
      `_Reply:_ *!ytdl 1* or *!ytdl 2*`;

    if (info.thumb) {
      try {
        const img = await axios.get(info.thumb, { responseType: 'arraybuffer', timeout: 10_000 });
        await sock.sendMessage(jid, {
          image: Buffer.from(img.data), caption: menu,
        }, { quoted: msg });
        return;
      } catch {}
    }
    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('[YT] info error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Couldn't fetch video info.*\n_${err.message}_`,
    }, { quoted: msg });
  }
}

export async function handleYtDl(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const n     = parseInt((args || '').trim());
  const state = pending.get(jid);

  if (!state) {
    await sock.sendMessage(jid, {
      text: `❌ No pending download. Run *!yt <link or query>* first.`,
    }, { quoted: msg });
    return;
  }

  if (n !== 1 && n !== 2) {
    await sock.sendMessage(jid, {
      text: `❌ Reply *!ytdl 1* for Video (MP4) or *!ytdl 2* for Audio (MP3).`,
    }, { quoted: msg });
    return;
  }

  const isVideo = n === 1;
  const dlUrl   = isVideo ? state.mp4 : state.mp3;

  if (!dlUrl) {
    await sock.sendMessage(jid, {
      text: `❌ Download URL not available. Run *!yt* again.`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, {
      text:
        `⬇️ *Downloading:* ${state.title}\n` +
        `📦 Format: *${isVideo ? 'MP4 Video' : 'MP3 Audio'}*\n\n` +
        `_Please wait..._`,
    });

    const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 90_000 });
    const buf = Buffer.from(res.data);
    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);

    if (buf.length > 50 * 1024 * 1024) {
      await sock.sendMessage(jid, {
        text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is 50 MB.`,
      }, { quoted: msg });
      return;
    }

    if (isVideo) {
      await sock.sendMessage(jid, {
        video:    buf,
        caption:  `🎬 *${state.title}*\n` + (state.duration ? `⏱️ ${state.duration}  ·  ` : '') + `📦 ${sizeMb} MB`,
        mimetype: 'video/mp4',
      }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, {
        audio:    buf,
        mimetype: 'audio/mpeg',
        ptt:      false,
      }, { quoted: msg });
      await sock.sendMessage(jid, { text: `🎵 *${state.title}*\n📦 ${sizeMb} MB` });
    }

    pending.delete(jid);

  } catch (err) {
    console.error('[YT] download error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Download failed.*\n_${err.message}_\n\nTry again with *!yt <link>*.`,
    }, { quoted: msg });
  }
}

export async function handleYtSearch(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ Usage: *!yts <search query>*\nExample: *!yts love me like*`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: `🔍 *Searching YouTube...*` });
    const results = await searchYouTube(query.trim());
    const top5 = results.slice(0, 5);

    let out = `🎬 *YouTube Search:* _${query}_\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    top5.forEach((r, i) => {
      out += `*${i + 1}.* 🎥 *${r.title || '(no title)'}*\n`;
      if (r.channel)  out += `   👤 ${r.channel}\n`;
      if (r.duration) out += `   ⏱️ ${r.duration}`;
      if (r.views)    out += `  ·  👁️ ${r.views}`;
      if (r.duration || r.views) out += '\n';
      if (r.url)      out += `   🔗 ${r.url}\n`;
      out += '\n';
    });
    out += `_Use *!yt <link>* to download any of these._`;
    await sock.sendMessage(jid, { text: out }, { quoted: msg });

  } catch (err) {
    console.error('[YTS] error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Search failed.*\n_${err.message}_`,
    }, { quoted: msg });
  }
}
