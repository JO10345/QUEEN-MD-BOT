/**
 * YouTube Feature — search by name OR download by URL.
 * Uses three APIs with automatic fallback:
 *   Search  #1: https://hector-api.vercel.app/search/youtube?q=<query>
 *   Search  #2: https://eliteprotech-apis.zone.id/ytsearch?q=<query>  ← fallback
 *   Download:   https://yt-dl.officialhectormanuel.workers.dev/?url=<youtube_url>
 *
 * If Search API #1 fails or returns no results, Search API #2 is tried automatically.
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
import { join } from 'path';

// ── FIX #1: TEMP_DIR uses process.cwd() not __dirname ─────────────────────────
// On Pterodactyl, __dirname + '../../temp' can resolve outside the container root.
// process.cwd() always points to the bot's working directory — safe on all hosts.
const TEMP_DIR = join(process.cwd(), 'temp');
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

// ── API endpoints ─────────────────────────────────────────────────────────────
const SEARCH_API_1 = 'https://hector-api.vercel.app/search/youtube';  // primary
const SEARCH_API_2 = 'https://eliteprotech-apis.zone.id/ytsearch';    // fallback
const YTDL_API     = 'https://yt-dl.officialhectormanuel.workers.dev/';

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB cap

// ── Pending download state: jid → { url, title, qualities[], _timer } ─────────
const pending     = new Map();
const PENDING_TTL = 10 * 60 * 1000; // 10 minutes auto-expire

function setPending(jid, value) {
  const existing = pending.get(jid);
  if (existing && existing._timer) clearTimeout(existing._timer);
  const timer = setTimeout(() => pending.delete(jid), PENDING_TTL);
  pending.set(jid, { ...value, _timer: timer });
}

function deletePending(jid) {
  const existing = pending.get(jid);
  if (existing && existing._timer) clearTimeout(existing._timer);
  pending.delete(jid);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isYoutubeUrl(s) { return YT_URL_RE.test(s || ''); }

function normalizeUrl(s) {
  s = (s || '').trim();
  if (!s.startsWith('http')) s = 'https://' + s;
  return s;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '?';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatViews(views) {
  if (!views) return '';
  const str = String(views).trim();
  if (/[KMBkmb]$/i.test(str)) return str; // already "1.2M" style
  const num = Number(str);
  if (isNaN(num)) return str;
  return num.toLocaleString();
}

function mime2ext(mime) {
  mime = (mime || '').toLowerCase();
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp3'))  return 'mp3';
  if (mime.includes('m4a'))  return 'm4a';
  return 'mp4';
}

// ── Search helpers ────────────────────────────────────────────────────────────

/**
 * Normalise a raw result item from ANY search API into a consistent shape.
 * Handles different field names used by different APIs.
 */
function normalizeResult(r) {
  // FIX #2: Guard against non-object entries in the results array
  if (!r || typeof r !== 'object') return { title: '', url: '', duration: '', views: '', channel: '', thumbnail: '' };

  const videoId = r.videoId || r.id || r.video_id || '';
  const url =
    r.url || r.link || r.videoUrl || r.href ||
    (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');

  return {
    title:     r.title       || r.name        || '',
    url,
    duration:  r.duration    || r.length       || r.durationText || '',
    views:     r.views       || r.viewCount    || r.view_count   || '',
    channel:   r.channel     || r.author       || r.channelName  || r.uploader || '',
    thumbnail: r.thumbnail   || r.thumbnailUrl || r.image        || '',
  };
}

/**
 * Try the primary search API (hector-api).
 * Returns array of normalised results, or throws.
 */
async function searchViaPrimary(query) {
  const { data } = await axios.get(SEARCH_API_1, {
    params:  { q: query },
    timeout: 15_000,
  });

  const raw =
    data?.results ||
    data?.videos  ||
    data?.data    ||
    (Array.isArray(data) ? data : null);

  if (!raw || raw.length === 0) throw new Error('No results from primary search API.');
  return raw.map(normalizeResult).filter(r => r.url); // only keep results with a usable URL
}

/**
 * Try the fallback search API (eliteprotech-apis).
 * Returns array of normalised results, or throws.
 */
async function searchViaFallback(query) {
  const { data } = await axios.get(SEARCH_API_2, {
    params:  { q: query },
    timeout: 15_000,
  });

  const raw =
    data?.results ||
    data?.videos  ||
    data?.data    ||
    data?.items   ||
    (Array.isArray(data) ? data : null);

  if (!raw || raw.length === 0) throw new Error('No results from fallback search API.');
  return raw.map(normalizeResult).filter(r => r.url); // only keep results with a usable URL
}

/**
 * Search YouTube — tries primary API first, auto-falls back to eliteprotech API.
 * Returns a non-empty array of normalised results, or throws if BOTH fail.
 */
async function searchYouTube(query) {
  let primaryError = null;

  // ── Try primary ────────────────────────────────────────────────────────────
  try {
    const results = await searchViaPrimary(query);
    if (results.length > 0) {
      console.log('[YT] Search via primary API ✓');
      return results;
    }
    throw new Error('Primary API returned results but none had a valid URL.');
  } catch (err) {
    primaryError = err;
    console.warn(`[YT] Primary search failed (${err.message}) — trying fallback...`);
  }

  // ── Try fallback ───────────────────────────────────────────────────────────
  try {
    const results = await searchViaFallback(query);
    if (results.length > 0) {
      console.log('[YT] Search via fallback API ✓');
      return results;
    }
    throw new Error('Fallback API returned results but none had a valid URL.');
  } catch (err) {
    console.error(`[YT] Fallback search also failed: ${err.message}`);
    throw new Error(
      `Both search APIs failed.\n• API 1: ${primaryError.message}\n• API 2: ${err.message}`
    );
  }
}

// ── Download API ──────────────────────────────────────────────────────────────

/**
 * Get download info for a YouTube URL → returns { title, qualities[], thumbnail }
 * qualities = [{ label, url, size, ext, hasAudio, hasVideo }]
 */
async function getDownloadInfo(videoUrl) {
  let data;
  try {
    const res = await axios.get(YTDL_API, {
      params:  { url: videoUrl },
      timeout: 30_000,
    });
    data = res.data;
  } catch (err) {
    const status = err?.response?.status;
    const body   = err?.response?.data;
    throw new Error(
      status
        ? `Download API returned HTTP ${status}${body ? ': ' + JSON.stringify(body) : ''}. The API may be down or the video is unavailable.`
        : `Download API unreachable: ${err.message}`
    );
  }

  const info = (data && data.data) ? data.data : data;

  if (!info || typeof info !== 'object') {
    throw new Error('Download API returned an unexpected response format.');
  }

  const title = (info.title) || (info.videoDetails && info.videoDetails.title) || 'YouTube Video';
  const qualities = [];

  if (Array.isArray(info.formats) && info.formats.length > 0) {
    const videoFormats = info.formats.filter(f => {
      if (!f || typeof f !== 'object') return false;
      const mimeStr = (f.mimeType || f.type || '').toLowerCase();
      const hasVid  = f.hasVideo !== false && (f.qualityLabel || f.quality);
      return hasVid && (
        mimeStr.includes('mp4') ||
        mimeStr.includes('video') ||
        mimeStr.includes('webm')
      );
    });

    const seen = new Set();
    for (const f of videoFormats) {
      const label   = f.qualityLabel || f.quality || '?';
      const mimeStr = (f.mimeType || f.type || '').toLowerCase();
      if (seen.has(label)) continue;
      seen.add(label);
      qualities.push({
        label,
        url:      f.url || '',
        size:     Number(f.contentLength || f.filesize || 0),
        ext:      mime2ext(mimeStr),
        hasAudio: f.hasAudio !== false,
        hasVideo: true,
      });
    }

    // FIX #3: parseInt with explicit radix 10 to avoid octal parsing edge cases
    qualities.sort((a, b) => (parseInt(b.label, 10) || 0) - (parseInt(a.label, 10) || 0));

  } else if (info.video || info.videoUrl || info.downloadUrl) {
    const url  = info.video || info.videoUrl || info.downloadUrl;
    const qual = info.quality || info.qualityLabel || '360p';
    qualities.push({ label: qual, url, size: 0, ext: 'mp4', hasAudio: true, hasVideo: true });
  }

  if (info.audio || info.audioUrl) {
    qualities.push({
      label:    'Audio only (MP3)',
      url:      info.audio || info.audioUrl,
      size:     0,
      ext:      'mp3',
      hasAudio: true,
      hasVideo: false,
    });
  }

  if (qualities.length === 0) {
    throw new Error(
      'No downloadable formats found. The video may be age-restricted, private, or region-locked.'
    );
  }

  return {
    title,
    qualities,
    thumbnail: info.thumbnail || info.thumbnailUrl || '',
  };
}

// ── Stream helper ─────────────────────────────────────────────────────────────

/**
 * Stream a URL to a temp file and return bytes written.
 * FIX #4: Attach ALL event handlers BEFORE calling pipe() to prevent
 *         a race condition where 'finish' fires before the handler is registered
 *         on fast/small streams (common in container environments).
 */
async function streamToFile(url, dest) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout:      120_000,
    maxRedirects: 8,
    headers:      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });

  const writer = createWriteStream(dest);
  let bytes         = 0;
  let limitExceeded = false;

  return new Promise((resolve, reject) => {
    // Attach ALL handlers first, THEN pipe — prevents race on fast streams
    writer.on('finish', () => resolve(bytes));
    writer.on('error',  reject);
    res.data.on('error', reject);

    res.data.on('data', chunk => {
      bytes += chunk.length;
      if (!limitExceeded && bytes > MAX_BYTES) {
        limitExceeded = true;
        res.data.destroy();
        writer.destroy(new Error(`File too large (>${formatSize(MAX_BYTES)}). Try a lower quality.`));
      }
    });

    res.data.pipe(writer);
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

  // Always clear old pending state before starting fresh
  deletePending(jid);

  try {
    await sock.sendMessage(jid, { text: `🔍 *Fetching info...*` });

    let videoUrl    = '';
    let searchTitle = '';

    if (isYoutubeUrl(query)) {
      videoUrl = normalizeUrl(query);
    } else {
      await sock.sendMessage(jid, { text: `🔎 *Searching YouTube for:* _${query}_` });

      const results = await searchYouTube(query);

      // FIX #5: Guard against empty results array and missing top entry
      if (!results || results.length === 0) {
        throw new Error('Search returned no results.');
      }
      const top = results[0];
      if (!top || typeof top !== 'object') {
        throw new Error('Search returned an invalid result structure.');
      }

      videoUrl    = top.url    || '';
      searchTitle = top.title  || '';

      if (!videoUrl) throw new Error('Could not extract a valid video URL from the search result.');

      let infoLine = `🎬 Found: *${searchTitle}*`;
      if (top.duration) infoLine += `\n⏱️ ${top.duration}`;
      if (top.views)    infoLine += `  ·  👁️ ${formatViews(top.views)} views`;
      if (top.channel)  infoLine += `\n👤 ${top.channel}`;
      await sock.sendMessage(jid, { text: infoLine + `\n\n_Getting quality options..._` });
    }

    const { title, qualities, thumbnail } = await getDownloadInfo(videoUrl);
    const finalTitle = title || searchTitle || 'YouTube Video';

    setPending(jid, { url: videoUrl, title: finalTitle, qualities });

    // Build quality menu
    let menu  = `🎬 *${finalTitle}*\n`;
    menu     += `━━━━━━━━━━━━━━━━━━━━\n`;
    menu     += `📥 *Choose quality to download:*\n\n`;

    qualities.forEach((q, i) => {
      const icon = q.hasVideo ? '📹' : '🎵';
      const sz   = q.size > 0 ? ` (${formatSize(q.size)})` : '';
      menu += `  *${i + 1}.* ${icon} ${q.label}${sz}\n`;
    });

    menu += `\n_Reply:_ *!ytdl <number>*\n`;
    menu += `_e.g. !ytdl 1 to download option 1_`;

    // FIX #6: Explicit catch variable so it works on all Node versions (no bare catch)
    if (thumbnail) {
      try {
        const thumbRes = await axios.get(thumbnail, { responseType: 'arraybuffer', timeout: 10_000 });
        await sock.sendMessage(jid, {
          image:   Buffer.from(thumbRes.data),
          caption: menu,
        }, { quoted: msg });
        return;
      } catch (thumbErr) {
        // Thumbnail fetch failed — not fatal, fall through to text
        console.warn('[YT] Thumbnail fetch failed:', thumbErr.message);
      }
    }

    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('YouTube info error:', err.message);
    deletePending(jid);
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

  // FIX #3: parseInt with explicit radix 10
  const n = parseInt((args || '').trim(), 10);

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

    // Pre-flight size check
    if (chosen.size > 0 && chosen.size > MAX_BYTES) {
      await sock.sendMessage(jid, {
        text: `⚠️ *File too large:* ${formatSize(chosen.size)} (limit 50 MB).\n\nTry a lower quality.`,
      }, { quoted: msg });
      return;
    }

    if (!chosen.url) {
      throw new Error('No download URL available for this quality. Try !yt again.');
    }

    const ext  = chosen.ext || (chosen.hasVideo ? 'mp4' : 'mp3');
    tempPath   = join(TEMP_DIR, `yt_${Date.now()}.${ext}`);
    const bytes = await streamToFile(chosen.url, tempPath);

    if (!existsSync(tempPath) || statSync(tempPath).size === 0) {
      throw new Error('Download finished empty. The video link may have expired — try !yt again.');
    }
    if (bytes > MAX_BYTES) {
      throw new Error(`File too large (${formatSize(bytes)}). Try a lower quality.`);
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

    deletePending(jid);

  } catch (err) {
    console.error('YouTube download error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Download failed.\n_${err.message}_\n\nTry a different quality or a shorter video.`,
    }, { quoted: msg });
  } finally {
    // FIX #6: Explicit catch variable — no bare catch {}
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch (cleanupErr) {
        console.warn('[YT] Temp file cleanup failed:', cleanupErr.message);
      }
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

    // auto-tries primary then fallback
    const results = await searchYouTube(query.trim());
    const top5    = results.slice(0, 5);

    let out = `🎬 *YouTube Search:* _${query}_\n━━━━━━━━━━━━━━━━━━━━\n\n`;

    top5.forEach((r, i) => {
      out += `*${i + 1}.* 🎥 *${r.title || '(no title)'}*\n`;
      if (r.channel)  out += `   👤 ${r.channel}\n`;
      if (r.duration) out += `   ⏱️ ${r.duration}`;
      if (r.views)    out += `  ·  👁️ ${formatViews(r.views)} views`;
      if (r.duration || r.views) out += '\n';
      if (r.url)      out += `   🔗 ${r.url}\n`;
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
