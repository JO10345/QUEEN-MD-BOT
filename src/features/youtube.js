/**
 * YouTube Feature — search + download (MP4 / MP3)
 *
 * Primary downloader API: https://backend1.tioo.eu.org/api/downloader/youtube
 * It returns title/thumbnail and ready-to-download MP4 and MP3 URLs. A
 * DavidCyril API remains as a provider fallback; this feature never scrapes
 * YouTube directly, avoiding the "Sign in to confirm you're not a bot" path.
 *
 * Commands:
 *   !yt  <url|query>  — fetch info + show format picker
 *   !ytdl 1           — download as MP4 video
 *   !ytdl 2           — download as MP3/M4A audio
 *   !yts <query>      — show top 5 search results
 */

import axios from 'axios';
import { ytSearchAPIs } from '../apis/config.js';

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// Per-chat pending state — ONLY the YouTube URL is stored, never the download URL
const pending = new Map();

// ── Downloader APIs ──────────────────────────────────────────────────────────

const BOTCAHX_YT = 'https://backend1.tioo.eu.org/api/downloader/youtube';
const YTV3 = 'https://apis.davidcyriltech.my.id/download/ytv3';

async function ytv3(videoUrl, format = 'mp4') {
  const { data } = await axios.get(YTV3, {
    params:  { url: videoUrl, format },
    timeout: 30_000,
  });

  const r = data?.result;
  if (!r?.download_url) throw new Error('ytv3 API: no download_url');

  return {
    downloadUrl: r.download_url,
    title:       r.title    || '',
    thumbnail:   r.thumbnail || '',
    quality:     r.quality  || '',
  };
}

async function botcahxYoutube(videoUrl) {
  const { data } = await axios.get(BOTCAHX_YT, {
    params: { url: videoUrl },
    timeout: 45_000,
  });
  if (data?.status !== true) {
    throw new Error(data?.message || 'YouTube download API did not return a result');
  }
  if (typeof data.mp4 !== 'string' || typeof data.mp3 !== 'string') {
    throw new Error('YouTube download API response is missing MP4/MP3 links');
  }
  return {
    title: data.title || '',
    thumbnail: data.thumbnail || '',
    author: data.author || '',
    mp4: data.mp4,
    mp3: data.mp3,
  };
}

function looksLikeErrorPage(buf) {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<html') || head.startsWith('<!doctype') ||
    head.startsWith('{') || head.startsWith('{"') ||
    head.startsWith('upstream connect error');
}

async function fetchMediaFile(downloadUrl, format) {
  const res = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'Accept': format === 'mp4' ? 'video/mp4,video/*;q=0.9,*/*;q=0.8' : 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
    },
  });

  const buf = Buffer.from(res.data);
  if (buf.length < 2_000) throw new Error('Download API returned an empty or incomplete file');
  if (looksLikeErrorPage(buf)) throw new Error('Download API returned an error page, not media');

  const ftypIndex = buf.indexOf(Buffer.from('ftyp'));
  const isIsoBmff = ftypIndex >= 0 && ftypIndex <= 64;
  if (format === 'mp4') {
    // ISO-BMFF MP4 files contain an `ftyp` box near the start. Reject CDN
    // webpages and malformed responses before sending them to WhatsApp.
    if (!isIsoBmff) {
      throw new Error('Download API response is not a valid MP4 file');
    }
    return { buffer: buf, mimetype: 'video/mp4' };
  } else {
    const hasId3 = buf.subarray(0, 3).toString('ascii') === 'ID3';
    const hasMpegFrame = buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    if (hasId3 || hasMpegFrame) return { buffer: buf, mimetype: 'audio/mpeg' };
    // The Botcahx endpoint calls this field "mp3" but currently returns an
    // AAC/M4A ISO-BMFF stream (audio/mp4). Pass its actual MIME type to WA.
    if (isIsoBmff) return { buffer: buf, mimetype: 'audio/mp4' };
    throw new Error('Download API response is not a valid audio file');
  }
}

async function fetchYoutubeMedia(videoUrl, format) {
  // First try the currently verified Botcahx downloader endpoint. If either
  // its metadata call or its CDN download fails, try the older API provider.
  try {
    const info = await botcahxYoutube(videoUrl);
    const media = await fetchMediaFile(info[format], format);
    return {
      buffer: media.buffer,
      mimetype: media.mimetype,
      title: info.title,
      thumbnail: info.thumbnail,
      quality: format === 'mp4' ? 'MP4' : media.mimetype === 'audio/mp4' ? 'M4A' : 'MP3',
    };
  } catch (primaryError) {
    console.warn(`[YT] Botcahx ${format} provider failed: ${primaryError.message}`);
  }

  try {
    const info = await ytv3(videoUrl, format);
    const media = await fetchMediaFile(info.downloadUrl, format);
    return {
      buffer: media.buffer,
      mimetype: media.mimetype,
      title: info.title,
      thumbnail: info.thumbnail,
      quality: info.quality || (format === 'mp4' ? 'MP4' : media.mimetype === 'audio/mp4' ? 'M4A' : 'MP3'),
    };
  } catch (fallbackError) {
    console.error(`[YT] Backup ${format} provider failed: ${fallbackError.message}`);
    throw new Error('The download services did not return a valid media file. Please retry in a few minutes.');
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isYoutubeUrl(s) { return YT_URL_RE.test(s || ''); }

async function searchYouTube(query) {
  const enabled = ytSearchAPIs.filter(a => a.enabled);
  let lastErr;
  for (const api of enabled) {
    try {
      const { data } = await axios.get(api.url, { params: api.params(query), timeout: 25_000 });
      const results = api.parse(data);
      const seen = new Set();
      return results.filter(result => {
        if (!result?.title || !result?.url) return false;
        const id = result.url.match(YT_URL_RE)?.[1] || result.url;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    } catch (e) {
      console.warn(`[YT] search ${api.name} failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error('All search APIs failed');
}

// ── !yt ───────────────────────────────────────────────────────────────────────

export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:*\n` +
        `• *!yt <YouTube link>* — get download options\n` +
        `• *!yt <search query>* — search YouTube\n` +
        `• *!yts <query>* — top 5 results\n` +
        `• *!ytdl 1* — Video (MP4)\n` +
        `• *!ytdl 2* — Audio (MP3/M4A)`,
    }, { quoted: msg });
  }

  try {
    let videoUrl = '', title = '', duration = '', thumbnail = '';

    if (isYoutubeUrl(query)) {
      videoUrl = query.trim();
      await sock.sendMessage(jid, { text: `🔍 *Fetching video info...*` });

      try {
        const info = await botcahxYoutube(videoUrl);
        title     = info.title;
        thumbnail = info.thumbnail;
      } catch {
        title = 'YouTube Video';
      }

    } else {
      await sock.sendMessage(jid, { text: `🔎 *Searching YouTube for:* _${query}_` });
      const results = await searchYouTube(query);
      const top     = results[0];
      if (!top?.url) throw new Error('No results found');
      videoUrl  = top.url;
      title     = top.title;
      duration  = top.duration;
      thumbnail = top.thumbnail;

      let found = `🎬 *Found:* ${title}`;
      if (duration)    found += `\n⏱️ ${duration}`;
      if (top.channel) found += `  ·  👤 ${top.channel}`;
      if (top.views)   found += `\n👁️ ${top.views}`;
      await sock.sendMessage(jid, { text: found });
    }

    // Store ONLY the YouTube URL — never cache the download link
    pending.set(jid, { url: videoUrl, title, duration, thumbnail });

    const menu =
      `🎬 *${title}*\n` +
      (duration ? `⏱️ ${duration}\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📥 *Choose format:*\n\n` +
      `  *1.* 📹 Video (MP4)\n` +
      `  *2.* 🎵 Audio (MP3/M4A)\n\n` +
      `_Reply:_ *!ytdl 1* or *!ytdl 2*`;

    if (thumbnail) {
      try {
        const img = await axios.get(thumbnail, { responseType: 'arraybuffer', timeout: 10_000 });
        return sock.sendMessage(jid, { image: Buffer.from(img.data), caption: menu }, { quoted: msg });
      } catch {}
    }
    return sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('[YT] handleYouTube error:', err.message);
    return sock.sendMessage(jid, {
      text: `❌ *YouTube search is temporarily unavailable.*\nPlease try again in a little while.`,
    }, { quoted: msg });
  }
}

// ── !ytdl ─────────────────────────────────────────────────────────────────────

export async function handleYtDl(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const n     = parseInt((args || '').trim());
  const state = pending.get(jid);

  if (!state) {
    return sock.sendMessage(jid, {
      text: `❌ No pending download. Run *!yt <link or query>* first.`,
    }, { quoted: msg });
  }
  if (n !== 1 && n !== 2) {
    return sock.sendMessage(jid, {
      text: `❌ Reply *!ytdl 1* for Video or *!ytdl 2* for Audio.`,
    }, { quoted: msg });
  }

  const isVideo = n === 1;
  const format  = isVideo ? 'mp4' : 'mp3';
  const label   = isVideo ? 'MP4 Video' : 'Audio · MP3/M4A';

  try {
    await sock.sendMessage(jid, {
      text:
        `⬇️ *Downloading:* ${state.title}\n` +
        `📦 Format: *${label}*\n\n` +
        `_Please wait — this may take 30–60 seconds..._`,
    });

    let finalTitle = state.title;
    let outputQuality = '';
    let outputMime = '';
    let buf;

    console.log(`[YT] Requesting ${format} through configured download APIs`);
    const downloaded = await fetchYoutubeMedia(state.url, format);
    buf = downloaded.buffer;
    outputMime = downloaded.mimetype;
    finalTitle = downloaded.title || finalTitle;
    outputQuality = downloaded.quality || '';

    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);
    console.log(`[YT] Sending ${sizeMb} MB ${format} to ${jid}`);

    if (buf.length > 50 * 1024 * 1024) {
      return sock.sendMessage(jid, {
        text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is 50 MB.`,
      }, { quoted: msg });
    }

    if (isVideo) {
      await sock.sendMessage(jid, {
        video:    buf,
        caption:
          `🎬 *${finalTitle}*\n` +
          (outputQuality  ? `📺 ${outputQuality}  ·  ` : '') +
          (state.duration  ? `⏱️ ${state.duration}  ·  ` : '') +
          `📦 ${sizeMb} MB`,
        mimetype: 'video/mp4',
      }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, {
        audio:    buf,
        mimetype: outputMime || 'audio/mpeg',
        ptt:      false,
      }, { quoted: msg });
      await sock.sendMessage(jid, {
        text: `🎵 *${finalTitle}*\n` +
              (outputQuality ? `🎶 ${outputQuality}  ·  ` : '') +
              `📦 ${sizeMb} MB`,
      });
    }

    pending.delete(jid);

  } catch (err) {
    console.error('[YT] handleYtDl error:', err.message);
    return sock.sendMessage(jid, {
      text: `❌ *Download failed.*\nThe download API could not provide a valid ${format.toUpperCase()} file. Please try another result or retry in a few minutes.`,
    }, { quoted: msg });
  }
}

// ── !yts ──────────────────────────────────────────────────────────────────────

export async function handleYtSearch(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    return sock.sendMessage(jid, {
      text: `❌ Usage: *!yts <search query>*`,
    }, { quoted: msg });
  }

  try {
    await sock.sendMessage(jid, { text: `🔍 *Searching YouTube...*` });
    const results = await searchYouTube(query.trim());
    const top5    = results.slice(0, 5);

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
    return sock.sendMessage(jid, { text: out }, { quoted: msg });

  } catch (err) {
    console.error('[YTS] error:', err.message);
    return sock.sendMessage(jid, {
      text: `❌ *YouTube search is temporarily unavailable.*\nPlease try again in a little while.`,
    }, { quoted: msg });
  }
}