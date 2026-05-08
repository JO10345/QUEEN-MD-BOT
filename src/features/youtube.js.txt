/**
 * YouTube Feature — search by name OR download by URL.
 * Uses three APIs:
 *   Search (primary):   https://hector-api.vercel.app/search/youtube?q=<query>
 *   Search (fallback):  https://eliteprotech-apis.zone.id/ytsearch?q=<query>
 *   Download (primary): https://yt-dl.officialhectormanuel.workers.dev/?url=<youtube_url>
 *   Download (fallback):https://eliteprotech-apis.zone.id/ytsearch?q=<youtube_url>
 *
 * Quality selection flow:
 *   1. User sends: !yt <url or search query>
 *   2. Bot shows video info + numbered quality list
 *   3. User replies: !ytdl <number>  — to download at chosen quality
 *
 * Also supports: !yts <query>  — shows top 5 search results
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

function mime2ext(mime) {
  if (!mime) return 'mp4';
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp3'))  return 'mp3';
  if (mime.includes('m4a'))  return 'm4a';
  return 'mp4';
}

/**
 * Normalise a raw results array from any search API into a consistent shape.
 */
function extractResults(data) {
  return (
    data?.results     ||
    data?.videos      ||
    data?.data        ||
    data?.items       ||
    (Array.isArray(data) ? data : null)
  );
}

/**
 * Search YouTube by query.
 * Tries primary API first, falls back to Elite API on error or empty result.
 */
async function searchYouTube(query) {
  // --- Primary: hector-api ---
  try {
    const { data } = await axios.get(SEARCH_API, {
      params:  { q: query },
      timeout: 20_000,
    });
    const results = extractResults(data);
    if (results && results.length > 0) return results;
  } catch (err) {
    console.warn('Primary search API failed, trying fallback:', err.message);
  }

  // --- Fallback: eliteprotech ---
  try {
    const { data } = await axios.get(ELITE_API, {
      params:  { q: query },
      timeout: 20_000,
    });
    const results = extractResults(data);
    if (results && results.length > 0) return results;
  } catch (err) {
    console.warn('Elite search API failed:', err.message);
  }

  throw new Error('No search results found from any API.');
}

/**
 * Parse qualities out of an Elite API response for a single video.
 * The Elite API is called with the video URL/ID as the query.
 */
function parseEliteResponse(data) {
  const info = data?.data || data?.result || data?.video || data;
  if (!info) return null;

  const title     = info.title || info.videoTitle || 'YouTube Video';
  const thumbnail = info.thumbnail || info.thumbnailUrl || info.image || '';
  let qualities   = [];

  // Formats array
  if (Array.isArray(info.formats) && info.formats.length > 0) {
    const seen = new Set();
    for (const f of info.formats) {
      const mime    = (f.mimeType || f.type || '').toLowerCase();
      const hasVid  = f.hasVideo !== false && (f.qualityLabel || f.quality || f.resolution);
      if (!hasVid) continue;
      const label   = f.qualityLabel || f.quality || f.resolution || '?';
      if (seen.has(label)) continue;
      seen.add(label);
      qualities.push({
        label,
        url:      f.url || f.downloadUrl,
        size:     Number(f.contentLength || f.filesize || 0),
        ext:      mime2ext(mime),
        hasAudio: f.hasAudio !== false,
        hasVideo: true,
      });
    }
    qualities.sort((a, b) => (parseInt(b.label) || 0) - (parseInt(a.label) || 0));
  }

  // Single video URL fields
  const directUrl = info.video || info.videoUrl || info.downloadUrl || info.url || info.mp4;
  if (qualities.length === 0 && directUrl) {
    qualities.push({
      label:    info.quality || info.qualityLabel || '360p',
      url:      directUrl,
      size:     0,
      ext:      'mp4',
      hasAudio: true,
      hasVideo: true,
    });
  }

  // Audio only
  const audioUrl = info.audio || info.audioUrl || info.mp3;
  if (audioUrl) {
    qualities.push({
      label:    'Audio only (MP3)',
      url:      audioUrl,
      size:     0,
      ext:      'mp3',
      hasAudio: true,
      hasVideo: false,
    });
  }

  if (qualities.length === 0) return null;
  return { title, qualities, thumbnail };
}

/**
 * Get download info for a YouTube URL → returns { title, qualities[], thumbnail }
 * Tries primary YTDL API first, falls back to Elite API.
 */
async function getDownloadInfo(videoUrl) {
  // --- Primary: yt-dl worker ---
  try {
    const { data } = await axios.get(YTDL_API, {
      params:  { url: videoUrl },
      timeout: 35_000,
    });

    const info  = data?.data || data;
    const title = info?.title || info?.videoDetails?.title || '';
    let qualities = [];

    if (Array.isArray(info?.formats) && info.formats.length > 0) {
      const seen = new Set();
      const videoFormats = info.formats.filter(f => {
        const mime   = (f.mimeType || f.type || '').toLowerCase();
        const hasVid = f.hasVideo !== false && (f.qualityLabel || f.quality);
        return hasVid && (mime.includes('mp4') || mime.includes('video') || mime.includes('webm'));
      });

      for (const f of videoFormats) {
        const label = f.qualityLabel || f.quality || '?';
        if (seen.has(label)) continue;
        seen.add(label);
        qualities.push({
          label,
          url:      f.url,
          size:     Number(f.contentLength || f.filesize || 0),
          ext:      mime2ext(f.mimeType || f.type || ''),
          hasAudio: f.hasAudio !== false,
          hasVideo: true,
        });
      }
      qualities.sort((a, b) => (parseInt(b.label) || 0) - (parseInt(a.label) || 0));

    } else if (info?.video || info?.videoUrl || info?.downloadUrl) {
      const url = info.video || info.videoUrl || info.downloadUrl;
      qualities.push({ label: info.quality || '360p', url, size: 0, ext: 'mp4', hasAudio: true, hasVideo: true });
    }

    if (info?.audio || info?.audioUrl) {
      qualities.push({
        label:    'Audio only (MP3)',
        url:      info.audio || info.audioUrl,
        size:     0,
        ext:      'mp3',
        hasAudio: true,
        hasVideo: false,
      });
    }

    if (qualities.length > 0) {
      return {
        title:     title || 'YouTube Video',
        qualities,
        thumbnail: info?.thumbnail || info?.thumbnailUrl || '',
      };
    }
    console.warn('Primary YTDL API returned no formats, trying Elite fallback...');
  } catch (err) {
    console.warn('Primary YTDL API error, trying Elite fallback:', err.message);
  }

  // --- Fallback: eliteprotech with video URL as query ---
  try {
    const videoId = extractVideoId(videoUrl);
    const query   = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : videoUrl;

    const { data } = await axios.get(ELITE_API, {
      params:  { q: query },
      timeout: 35_000,
    });

    // Elite API may return a list or a single video object
    const list = extractResults(data);
    if (list && list.length > 0) {
      const parsed = parseEliteResponse(list[0]);
      if (parsed) return parsed;
    }

    // Try parsing the response directly as a single video
    const parsed = parseEliteResponse(data);
    if (parsed) return parsed;

  } catch (err) {
    console.warn('Elite download fallback failed:', err.message);
  }

  throw new Error('Could not fetch download info from any API. Try a different video.');
}

/**
 * Stream a URL to a temp file and return bytes written.
 * Fixed: properly handles the MAX_BYTES cap without hanging.
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
        writer.destroy(new Error(`File too large (>${formatSize(MAX_BYTES)}). Try a lower quality.`));
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
 * Shows video info and quality options.
 */
export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:*\n• *!yt <YouTube link>* — get quality options\n• *!yt <search query>* — search and get options\n• *!yts <query>* — show search results\n• *!ytdl <number>* — download chosen quality`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: `🔍 *Fetching info...*` });

    let videoUrl;
    let searchTitle = '';

    if (isYoutubeUrl(query)) {
      videoUrl = normalizeUrl(query);
    } else {
      await sock.sendMessage(jid, { text: `🔎 *Searching YouTube for:* _${query}_` });
      const results = await searchYouTube(query);
      const top     = results[0];

      videoUrl    = top.url || top.link || top.videoUrl || top.href || top.watchUrl || '';
      searchTitle = top.title || top.name || '';
      const dur   = top.duration || top.length || '';
      const views = top.views    || top.viewCount || '';

      if (!videoUrl) throw new Error('Could not extract video URL from search result.');

      let infoLine = `🎬 Found: *${searchTitle}*`;
      if (dur)   infoLine += `\n⏱️ ${dur}`;
      if (views) infoLine += `  ·  👁️ ${Number(views).toLocaleString()} views`;
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

    menu += `\n_Reply:_ *!ytdl <number>*\n`;
    menu += `_e.g. !ytdl 1 to download option 1_`;

    if (thumbnail) {
      try {
        const res = await axios.get(thumbnail, { responseType: 'arraybuffer', timeout: 10_000 });
        await sock.sendMessage(jid, {
          image:   Buffer.from(res.data),
          caption: menu,
        }, { quoted: msg });
        return;
      } catch { /* fall through to text */ }
    }

    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('YouTube info error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Couldn't fetch video info.\n_${err.message}_\n\nTip: check the URL is valid or try a different search.`,
    }, { quoted: msg });
  }
}

/**
 * !ytdl <number>
 * Downloads the quality the user picked.
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

    const ext  = chosen.ext || (chosen.hasVideo ? 'mp4' : 'mp3');
    tempPath   = join(TEMP_DIR, `yt_${Date.now()}.${ext}`);
    const bytes = await streamToFile(chosen.url, tempPath);

    if (!existsSync(tempPath) || statSync(tempPath).size === 0) {
      throw new Error('Download finished empty. The direct link may have expired — run !yt again.');
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
      await sock.sendMessage(jid, {
        text: `🎵 *${state.title}*\n📦 ${sizeMb} MB`,
      });
    }

    pending.delete(jid);

  } catch (err) {
    console.error('YouTube download error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Download failed.\n_${err.message}_\n\nTry a different quality or run *!yt* again.`,
    }, { quoted: msg });
  } finally {
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

/**
 * !yts <query>
 * Shows top 5 search results so user can pick one then use !yt <url>.
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
      const title   = r.title    || r.name        || '(no title)';
      const dur     = r.duration || r.length       || '';
      const views   = r.views    || r.viewCount    || '';
      const channel = r.channel  || r.author       || r.channelName || '';
      const url     = r.url      || r.link         || r.videoUrl    || r.watchUrl || '';

      out += `*${i + 1}.* 🎥 *${title}*\n`;
      if (channel) out += `   👤 ${channel}\n`;
      if (dur)     out += `   ⏱️ ${dur}`;
      if (views)   out += `  ·  👁️ ${Number(views || 0).toLocaleString()} views`;
      if (dur || views) out += '\n';
      if (url)     out += `   🔗 ${url}\n`;
      out += '\n';
    });

    out += `_Use *!yt <link>* to download any of these._`;
    await sock.sendMessage(jid, { text: out }, { quoted: msg });

  } catch (err) {
    console.error('YT search error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Search failed.\n_${err.message}_`,
    }, { quoted: msg });
  }
}
