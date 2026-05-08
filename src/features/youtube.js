/**
 * YouTube Feature — search by name OR download by URL.
 *
 * APIs (verified response shapes):
 *   Search primary:  GET https://hector-api.vercel.app/search/youtube?q=
 *                    → { result: [{ title, channel, duration, imageUrl, link }] }
 *
 *   Search fallback: GET https://eliteprotech-apis.zone.id/ytsearch?q=
 *                    → { results: { videos: [{ title, url, thumbnail, duration, views, author }] } }
 *
 *   Download:        GET https://yt-dl.officialhectormanuel.workers.dev/?url=
 *                    → { title, thumbnail, audio, videos: { "144": url, "360": url, ... } }
 *
 * Flow:
 *   1. !yt <url or search>  — shows quality menu
 *   2. !ytdl <number>       — downloads chosen quality
 *   3. !yts <query>         — shows top 5 results
 */

import axios from 'axios';
import { createWriteStream, statSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR  = join(__dirname, '../../temp');
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

const SEARCH_API  = 'https://hector-api.vercel.app/search/youtube';
const YTDL_API    = 'https://yt-dl.officialhectormanuel.workers.dev/';
const ELITE_API   = 'https://eliteprotech-apis.zone.id/ytsearch';
const YT_URL_RE   = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const MAX_BYTES   = 50 * 1024 * 1024; // 50 MB cap

// Per-chat pending download state: jid → { url, title, qualities[] }
const pending = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isYoutubeUrl(s) { return YT_URL_RE.test(s || ''); }

function extractVideoId(s) {
  const m = (s || '').match(YT_URL_RE);
  return m ? m[1] : null;
}

function normalizeUrl(s) {
  s = (s || '').trim();
  if (!s.startsWith('http')) s = 'https://' + s;
  return s;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '?';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * Search YouTube by query.
 * Primary returns data.result[], fallback returns data.results.videos[].
 * Returns a unified array: [{ title, url, channel, duration, views, thumbnail }]
 */
async function searchYouTube(query) {
  // --- Primary: hector-api → { result: [...] } ---
  try {
    const { data } = await axios.get(SEARCH_API, {
      params:  { q: query },
      timeout: 20_000,
    });
    // Primary uses "result" (singular)
    const arr = Array.isArray(data?.result) ? data.result : null;
    if (arr && arr.length > 0) {
      // Normalise to common shape: URL is in "link"
      return arr.map(r => ({
        title:     r.title     || '',
        url:       r.link      || r.url || '',
        channel:   r.channel   || '',
        duration:  r.duration  || '',
        views:     r.views     || '',
        thumbnail: r.imageUrl  || r.thumbnail || '',
      }));
    }
  } catch (err) {
    console.warn('Primary search failed, trying fallback:', err.message);
  }

  // --- Fallback: eliteprotech → { results: { videos: [...] } } ---
  try {
    const { data } = await axios.get(ELITE_API, {
      params:  { q: query },
      timeout: 20_000,
    });
    // Elite uses "results.videos" (nested)
    const arr = Array.isArray(data?.results?.videos) ? data.results.videos : null;
    if (arr && arr.length > 0) {
      return arr.map(r => ({
        title:     r.title  || '',
        url:       r.url    || '',
        channel:   r.author?.name || r.channel || '',
        duration:  r.duration || '',
        views:     r.views  || '',
        thumbnail: r.thumbnail || '',
      }));
    }
  } catch (err) {
    console.warn('Elite search failed:', err.message);
  }

  throw new Error('No search results found. Please try again or use a different query.');
}

/**
 * Get download info for a YouTube URL.
 * YTDL API returns: { title, thumbnail, audio, videos: { "144": url, "360": url, ... } }
 * Returns: { title, thumbnail, qualities[] }
 */
async function getDownloadInfo(videoUrl) {
  const { data } = await axios.get(YTDL_API, {
    params:  { url: videoUrl },
    timeout: 35_000,
  });

  const title     = data?.title || 'YouTube Video';
  const thumbnail = data?.thumbnail || '';
  let qualities   = [];

  // "videos" is an object: { "144": downloadUrl, "360": downloadUrl, ... }
  if (data?.videos && typeof data.videos === 'object' && !Array.isArray(data.videos)) {
    const entries = Object.entries(data.videos);
    // Sort by resolution descending
    entries.sort((a, b) => (parseInt(b[0]) || 0) - (parseInt(a[0]) || 0));
    for (const [quality, url] of entries) {
      if (!url) continue;
      qualities.push({
        label:    `${quality}p`,
        url,
        size:     0,
        ext:      'mp4',
        hasAudio: true,
        hasVideo: true,
      });
    }
  }

  // Audio-only option
  if (data?.audio) {
    qualities.push({
      label:    'Audio only (MP3)',
      url:      data.audio,
      size:     0,
      ext:      'mp3',
      hasAudio: true,
      hasVideo: false,
    });
  }

  if (qualities.length === 0) {
    throw new Error('No downloadable formats found. The video may be unavailable or age-restricted.');
  }

  return { title, thumbnail, qualities };
}

/**
 * Stream a URL to a temp file and return bytes written.
 */
async function streamToFile(url, dest) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout:      120_000,
    maxRedirects: 8,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });

  const writer = createWriteStream(dest);
  let bytes    = 0;
  let tooLarge = false;

  return new Promise((resolve, reject) => {
    res.data.on('data', chunk => {
      bytes += chunk.length;
      if (!tooLarge && bytes > MAX_BYTES) {
        tooLarge = true;
        res.data.destroy();
        writer.destroy(new Error(`File too large (limit 50 MB). Please try a lower quality.`));
      }
    });

    res.data.pipe(writer);
    writer.on('finish', () => resolve(bytes));
    writer.on('error',  reject);
    res.data.on('error', reject);
  });
}

// ── Command Handlers ──────────────────────────────────────────────────────────

/**
 * !yt <url or search query>
 */
export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:*\n• *!yt <YouTube link>* — get quality options\n• *!yt <search query>* — search and get options\n• *!yts <query>* — show top 5 results\n• *!ytdl <number>* — download chosen quality`,
    }, { quoted: msg });
    return;
  }

  try {
    let videoUrl;
    let searchTitle = '';

    if (isYoutubeUrl(query)) {
      videoUrl = normalizeUrl(query);
      await sock.sendMessage(jid, { text: `🔍 *Fetching video info...*` });
    } else {
      await sock.sendMessage(jid, { text: `🔎 *Searching YouTube for:* _${query}_` });
      const results = await searchYouTube(query);
      const top     = results[0];

      videoUrl    = top.url;
      searchTitle = top.title;

      if (!videoUrl) throw new Error('Could not get a video URL from search results.');

      let infoLine = `🎬 Found: *${searchTitle}*`;
      if (top.duration) infoLine += `\n⏱️ ${top.duration}`;
      if (top.views)    infoLine += `  ·  👁️ ${Number(top.views).toLocaleString()} views`;
      if (top.channel)  infoLine += `\n👤 ${top.channel}`;
      await sock.sendMessage(jid, { text: infoLine + `\n\n_Getting quality options..._` });
    }

    const { title, qualities, thumbnail } = await getDownloadInfo(videoUrl);
    const finalTitle = title || searchTitle || 'YouTube Video';

    pending.set(jid, { url: videoUrl, title: finalTitle, qualities });

    let menu = `🎬 *${finalTitle}*\n`;
    menu += `━━━━━━━━━━━━━━━━━━━━\n`;
    menu += `📥 *Choose quality to download:*\n\n`;
    qualities.forEach((q, i) => {
      const icon = q.hasVideo ? '📹' : '🎵';
      const sz   = q.size > 0 ? ` (${formatSize(q.size)})` : '';
      menu += `  *${i + 1}.* ${icon} ${q.label}${sz}\n`;
    });
    menu += `\n_Reply:_ *!ytdl <number>*  (e.g. !ytdl 1)`;

    if (thumbnail) {
      try {
        const res = await axios.get(thumbnail, { responseType: 'arraybuffer', timeout: 10_000 });
        await sock.sendMessage(jid, {
          image:   Buffer.from(res.data),
          caption: menu,
        }, { quoted: msg });
        return;
      } catch { /* fall through */ }
    }

    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('YouTube info error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Couldn't fetch video info.*\n_${err.message}_\n\nTip: check the URL is valid or try a different search.`,
    }, { quoted: msg });
  }
}

/**
 * !ytdl <number>
 */
export async function handleYtDl(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const n   = parseInt((args || '').trim());

  const state = pending.get(jid);
  if (!state) {
    await sock.sendMessage(jid, {
      text: `❌ No pending download. First run *!yt <link or search>* to pick a video.`,
    }, { quoted: msg });
    return;
  }

  if (!n || n < 1 || n > state.qualities.length) {
    await sock.sendMessage(jid, {
      text: `❌ Invalid choice. Pick a number from 1 to ${state.qualities.length}.\n\nRun *!yt <link>* again to see options.`,
    }, { quoted: msg });
    return;
  }

  const chosen  = state.qualities[n - 1];
  let tempPath  = '';

  try {
    await sock.sendMessage(jid, {
      text: `⬇️ *Downloading:* ${state.title}\n📺 Quality: *${chosen.label}*\n\n_Please wait..._`,
    });

    if (chosen.size > 0 && chosen.size > MAX_BYTES) {
      await sock.sendMessage(jid, {
        text: `⚠️ *File too large:* ${formatSize(chosen.size)} (limit 50 MB).\n\nTry a lower quality.`,
      }, { quoted: msg });
      return;
    }

    const ext   = chosen.ext || (chosen.hasVideo ? 'mp4' : 'mp3');
    tempPath    = join(TEMP_DIR, `yt_${Date.now()}.${ext}`);
    const bytes = await streamToFile(chosen.url, tempPath);

    if (!existsSync(tempPath) || statSync(tempPath).size === 0) {
      throw new Error('Download finished empty. Try running !yt again — the link may have expired.');
    }

    const sizeMb = (bytes / 1024 / 1024).toFixed(1);

    if (chosen.hasVideo) {
      await sock.sendMessage(jid, {
        video:    { url: tempPath },
        caption:  `🎬 *${state.title}*\n📺 ${chosen.label}  ·  📦 ${sizeMb} MB`,
        mimetype: 'video/mp4',
      }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, {
        audio:    { url: tempPath },
        mimetype: 'audio/mpeg',
        ptt:      false,
      }, { quoted: msg });
      await sock.sendMessage(jid, { text: `🎵 *${state.title}*\n📦 ${sizeMb} MB` });
    }

    pending.delete(jid);

  } catch (err) {
    console.error('YouTube download error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Download failed.*\n_${err.message}_\n\nTry a different quality or run *!yt* again.`,
    }, { quoted: msg });
  } finally {
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

/**
 * !yts <query>
 * Shows top 5 search results.
 */
export async function handleYtSearch(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ Usage: *!yts <search query>*\nExample: *!yts cartoon network*`,
    }, { quoted: msg });
    return;
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
      if (r.views)    out += `  ·  👁️ ${Number(r.views || 0).toLocaleString()} views`;
      if (r.duration || r.views) out += '\n';
      if (r.url)      out += `   🔗 ${r.url}\n`;
      out += '\n';
    });

    out += `_Use *!yt <link>* to download any of these._`;
    await sock.sendMessage(jid, { text: out }, { quoted: msg });

  } catch (err) {
    console.error('YT search error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Search failed.*\n_${err.message}_`,
    }, { quoted: msg });
  }
}
