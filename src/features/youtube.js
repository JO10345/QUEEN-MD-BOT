/**
 * YouTube Feature — search by name OR download by URL.
 *
 * ─── Install once (in your bot folder) ───────────────────────────────────────
 *   npm install youtubei.js axios
 *
 * ─── Search APIs (3, with automatic fallback) ────────────────────────────────
 *   1. https://hector-api.vercel.app/search/youtube?q=   → { result: [...] }
 *   2. https://eliteprotech-apis.zone.id/ytsearch?q=      → { results: { videos: [...] } }
 *   3. https://api.yupra.my.id/api/search/youtube?q=      → { results: [...] }
 *
 * ─── Download ─────────────────────────────────────────────────────────────────
 *   Uses youtubei.js (Innertube) — YouTube's own internal protocol.
 *   Returns only progressive (audio + video combined) formats so every
 *   downloaded file plays correctly on WhatsApp without needing ffmpeg.
 *   MP3 audio uses the Hector YTDL worker (confirmed working).
 *
 * ─── Commands ─────────────────────────────────────────────────────────────────
 *   !yt <url or query>   — show quality options
 *   !ytdl <number>       — download chosen quality
 *   !yts <query>         — show top 5 search results
 */

import { Innertube } from 'youtubei.js';
import axios from 'axios';
import { createWriteStream, statSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR  = join(__dirname, '../../temp');
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

const SEARCH_API_1 = 'https://hector-api.vercel.app/search/youtube';
const SEARCH_API_2 = 'https://eliteprotech-apis.zone.id/ytsearch';
const SEARCH_API_3 = 'https://api.yupra.my.id/api/search/youtube';
const YTDL_MP3     = 'https://yt-dl.officialhectormanuel.workers.dev/stream';
const MAX_BYTES    = 50 * 1024 * 1024; // 50 MB

// Innertube singleton — created once, reused for all requests
let _yt = null;
async function getYT() {
  if (!_yt) {
    _yt = await Innertube.create({
      retrieve_player: false,
      generate_session_locally: true,
    });
  }
  return _yt;
}

// Per-chat pending download state
const pending = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function isYoutubeUrl(s)  { return YT_URL_RE.test(s || ''); }
function extractVideoId(s){ const m = (s||'').match(YT_URL_RE); return m ? m[1] : null; }
function normalizeUrl(s)  { s=(s||'').trim(); return s.startsWith('http') ? s : 'https://'+s; }
function formatSize(b)    { return (!b||b===0) ? '?' : (b/1024/1024).toFixed(1)+' MB'; }

// ── Search (3 APIs with automatic fallback) ───────────────────────────────────

async function searchYouTube(query) {
  // API 1 — Hector: { result: [{ title, channel, duration, imageUrl, link }] }
  try {
    const { data } = await axios.get(SEARCH_API_1, { params: { q: query }, timeout: 18_000 });
    const arr = Array.isArray(data?.result) ? data.result : null;
    if (arr?.length) return arr.map(r => ({
      title: r.title || '', url: r.link || r.url || '',
      channel: r.channel || '', duration: r.duration || '',
      views: r.views || '', thumbnail: r.imageUrl || r.thumbnail || '',
    }));
  } catch (e) { console.warn('Search API 1 failed:', e.message); }

  // API 2 — EliteProtech: { results: { videos: [{ title, url, author, duration, views, thumbnail }] } }
  try {
    const { data } = await axios.get(SEARCH_API_2, { params: { q: query }, timeout: 18_000 });
    const arr = Array.isArray(data?.results?.videos) ? data.results.videos : null;
    if (arr?.length) return arr.map(r => ({
      title: r.title || '', url: r.url || '',
      channel: r.author?.name || r.channel || '', duration: r.duration || '',
      views: r.views || '', thumbnail: r.thumbnail || '',
    }));
  } catch (e) { console.warn('Search API 2 failed:', e.message); }

  // API 3 — Yupra: { results: [{ title, url, channel, duration, views, thumbnail }] }
  try {
    const { data } = await axios.get(SEARCH_API_3, { params: { q: query }, timeout: 18_000 });
    const arr = Array.isArray(data?.results) ? data.results : null;
    if (arr?.length) return arr.map(r => ({
      title: r.title || '', url: r.url || '',
      channel: r.channel || '', duration: r.duration || '',
      views: r.views || '', thumbnail: r.thumbnail || '',
    }));
  } catch (e) { console.warn('Search API 3 failed:', e.message); }

  throw new Error('No search results found. Please try again.');
}

// ── Download info (youtubei.js / Innertube) ───────────────────────────────────

/**
 * Returns { title, thumbnail, qualities[] } using YouTube's own internal API.
 * Only progressive (audio+video combined) MP4 formats are included so files
 * play correctly without any merging.
 */
async function getDownloadInfo(videoUrl) {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error('Invalid YouTube URL.');

  const yt   = await getYT();
  const info = await yt.getBasicInfo(videoId, 'WEB');

  const title     = info.basic_info?.title || 'YouTube Video';
  const thumbnail = info.basic_info?.thumbnail?.[0]?.url || '';

  // Progressive formats have BOTH audio and video in one file
  const formats = info.streaming_data?.formats ?? [];

  // Deduplicate by quality label, prefer highest bitrate
  const seen = new Map();
  for (const f of formats) {
    const label = f.quality_label || String(f.quality) || '?';
    const mime  = (f.mime_type || '').toLowerCase();
    if (!mime.includes('video')) continue;
    if (!seen.has(label) || (f.average_bitrate||0) > (seen.get(label).average_bitrate||0)) {
      seen.set(label, f);
    }
  }

  // Sort highest quality first
  const qualities = [...seen.values()]
    .sort((a, b) => (parseInt(b.quality_label)||0) - (parseInt(a.quality_label)||0))
    .map(f => ({
      label:    f.quality_label || String(f.quality),
      url:      f.decipher(yt.session.player),
      size:     Number(f.content_length || 0),
      ext:      'mp4',
      hasAudio: true,
      hasVideo: true,
    }));

  if (qualities.length === 0) {
    throw new Error('No playable formats found. The video may be age-restricted or unavailable.');
  }

  // Add MP3 audio option using the Hector worker (confirmed working)
  qualities.push({
    label:    'Audio only (MP3)',
    url:      `${YTDL_MP3}?id=${videoId}&format=mp3&title=${encodeURIComponent(title)}`,
    size:     0,
    ext:      'mp3',
    hasAudio: true,
    hasVideo: false,
    isMp3:    true,
  });

  return { title, thumbnail, qualities };
}

// ── Download to file ──────────────────────────────────────────────────────────

async function downloadToFile(chosen, dest) {
  const res = await axios.get(chosen.url, {
    responseType: 'stream',
    timeout: 120_000,
    maxRedirects: 8,
    headers: {
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer':      'https://www.youtube.com/',
      'Origin':       'https://www.youtube.com',
      'Range':        'bytes=0-',
    },
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
        writer.destroy(new Error('File too large (limit 50 MB). Try a lower quality.'));
      }
    });
    res.data.pipe(writer);
    writer.on('finish', () => resolve(bytes));
    writer.on('error',  reject);
    res.data.on('error', reject);
  });
}

// ── Command Handlers ──────────────────────────────────────────────────────────

export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:*\n• *!yt <YouTube link>* — get quality options\n• *!yt <search query>* — search and pick\n• *!yts <query>* — show top 5 results\n• *!ytdl <number>* — download chosen quality`,
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
      videoUrl      = top.url;
      searchTitle   = top.title;

      if (!videoUrl) throw new Error('Could not get a video URL from search results.');

      let info = `🎬 Found: *${searchTitle}*`;
      if (top.duration) info += `\n⏱️ ${top.duration}`;
      if (top.views)    info += `  ·  👁️ ${String(top.views).replace(/\D/g,'') ? Number(String(top.views).replace(/\D/g,'')).toLocaleString() : top.views} views`;
      if (top.channel)  info += `\n👤 ${top.channel}`;
      await sock.sendMessage(jid, { text: info + `\n\n_Getting quality options..._` });
    }

    const { title, qualities, thumbnail } = await getDownloadInfo(videoUrl);
    const finalTitle = title || searchTitle || 'YouTube Video';

    pending.set(jid, { url: videoUrl, title: finalTitle, qualities });

    let menu = `🎬 *${finalTitle}*\n━━━━━━━━━━━━━━━━━━━━\n📥 *Choose quality:*\n\n`;
    qualities.forEach((q, i) => {
      const icon = q.hasVideo ? '📹' : '🎵';
      const sz   = q.size > 0 ? ` (${formatSize(q.size)})` : '';
      menu += `  *${i + 1}.* ${icon} ${q.label}${sz}\n`;
    });
    menu += `\n_Reply:_ *!ytdl <number>*  (e.g. *!ytdl 1*)`;

    if (thumbnail) {
      try {
        const r = await axios.get(thumbnail, { responseType: 'arraybuffer', timeout: 10_000 });
        await sock.sendMessage(jid, { image: Buffer.from(r.data), caption: menu }, { quoted: msg });
        return;
      } catch { /* fall through to text */ }
    }
    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('YouTube info error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Couldn't fetch video info.*\n_${err.message}_`,
    }, { quoted: msg });
  }
}

export async function handleYtDl(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const n   = parseInt((args || '').trim());

  const state = pending.get(jid);
  if (!state) {
    await sock.sendMessage(jid, {
      text: `❌ No pending download. First run *!yt <link or search>*.`,
    }, { quoted: msg });
    return;
  }

  if (!n || n < 1 || n > state.qualities.length) {
    await sock.sendMessage(jid, {
      text: `❌ Pick a number from 1 to ${state.qualities.length}.\n\nRun *!yt <link>* again to see options.`,
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
        text: `⚠️ *File too large:* ${formatSize(chosen.size)} (limit 50 MB). Try a lower quality.`,
      }, { quoted: msg });
      return;
    }

    const ext  = chosen.ext || (chosen.hasVideo ? 'mp4' : 'mp3');
    tempPath   = join(TEMP_DIR, `yt_${Date.now()}.${ext}`);
    const bytes = await downloadToFile(chosen, tempPath);

    if (!existsSync(tempPath) || statSync(tempPath).size === 0) {
      throw new Error('Download came out empty. Run !yt again to refresh the links.');
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
      text: `❌ *Download failed.*\n_${err.message}_\n\nTry a lower quality or run *!yt* again.`,
    }, { quoted: msg });
  } finally {
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

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
      if (r.views)    out += `  ·  👁️ ${r.views}`;
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
