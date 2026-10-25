/**
 * YouTube Feature — search + download (MP4 / MP3)
 *
 * Uses a provider chain for both search and downloads. Provider responses are
 * validated as media before being sent to WhatsApp.
 *
 * Commands:
 *   !yt  <url|query>  — fetch info + show format picker
 *   !ytdl 1           — download as MP4 video
 *   !ytdl 2           — download as MP3/M4A audio
 *   !yts <query>      — show top 5 search results
 */

import axios from 'axios';
import { ytSearchAPIs } from '../apis/config.js';

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const DAVID_API_BASE = 'https://apis.davidcyriltech.my.id';

// Per-chat pending state — ONLY the YouTube URL is stored, never the download URL
const pending = new Map();

// ── Downloader APIs ──────────────────────────────────────────────────────────

const BOTCAHX_YT = 'https://backend1.tioo.eu.org/api/downloader/youtube';
const DAVID_API_KEY = () => (process.env.DAVID_API_KEY || '').trim();
const GTECH_YT_API_KEY = () => (process.env.GTECH_YT_API_KEY || '').trim();

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

function parseJsonBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function findDownloadUrl(value, format, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDownloadUrl(item, format, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const preferred = format === 'mp4'
    ? ['mp4', 'video', 'video_url', 'videoUrl', 'download_url', 'downloadUrl', 'download', 'url', 'link', 'file']
    : ['mp3', 'm4a', 'audio', 'audio_url', 'audioUrl', 'download_url', 'downloadUrl', 'download', 'url', 'link', 'file'];
  for (const key of preferred) {
    const found = findDownloadUrl(value[key], format, depth + 1);
    if (found) return found;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (['title', 'name', 'author', 'channel', 'thumbnail', 'image', 'message', 'status', 'success'].includes(key.toLowerCase())) continue;
    const found = findDownloadUrl(candidate, format, depth + 1);
    if (found) return found;
  }
  return '';
}

function findTitle(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const title = findTitle(item, depth + 1);
      if (title) return title;
    }
    return '';
  }
  if (typeof value.title === 'string' && value.title.trim()) return value.title.trim();
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  for (const [key, child] of Object.entries(value)) {
    if (['thumbnail', 'image', 'url', 'download_url', 'downloadUrl'].includes(key.toLowerCase())) continue;
    const title = findTitle(child, depth + 1);
    if (title) return title;
  }
  return '';
}

function looksLikeErrorPage(buf) {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<html') || head.startsWith('<!doctype') ||
    head.startsWith('{') || head.startsWith('[') ||
    head.startsWith('upstream connect error');
}

function validateMediaBuffer(buf, format, contentType = '') {
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
  return validateMediaBuffer(Buffer.from(res.data), format, res.headers?.['content-type']);
}

function youtubeDownloadProviders(format) {
  const providers = [];

  if (format === 'mp4') {
    providers.push({
      name: 'EliteProTech YouTube MP4',
      url: 'https://eliteprotech-apis.zone.id/download/ytmp4',
      params: videoUrl => ({ url: videoUrl }),
    });
    providers.push({
      name: 'David Cyril YouTube MP4',
      url: `${DAVID_API_BASE}/download/ytmp4`,
      params: videoUrl => ({ url: videoUrl }),
      davidAuth: true,
    });
  } else if (GTECH_YT_API_KEY()) {
    providers.push({
      name: 'GTech YouTube audio',
      url: 'https://gtech-api-xtp1.onrender.com/api/audio/yt',
      params: videoUrl => ({ url: videoUrl, apikey: GTECH_YT_API_KEY() }),
    });
  }

  providers.push({
    name: 'David Cyril YouTube Downloader V3',
    url: `${DAVID_API_BASE}/download/ytv3`,
    params: (videoUrl) => ({ url: videoUrl, format }),
    davidAuth: true,
  });
  providers.push({
    name: 'David Cyril YouTube Generic',
    url: `${DAVID_API_BASE}/download/yt`,
    params: videoUrl => ({ url: videoUrl }),
    davidAuth: true,
  });

  providers.push({
    name: 'Botcahx YouTube',
    custom: async videoUrl => {
      const info = await botcahxYoutube(videoUrl);
      const media = await fetchMediaFile(info[format], format);
      return {
        ...media,
        title: info.title,
        thumbnail: info.thumbnail,
        quality: format === 'mp4' ? 'MP4' : media.mimetype === 'audio/mp4' ? 'M4A' : 'MP3',
      };
    },
  });

  return providers;
}

async function downloadFromProvider(provider, videoUrl, format) {
  if (provider.custom) return provider.custom(videoUrl);

  const davidKey = provider.davidAuth ? DAVID_API_KEY() : '';
  const params = {
    ...provider.params(videoUrl),
    ...(davidKey ? { apikey: davidKey } : {}),
  };
  const headers = davidKey ? { 'X-API-Key': davidKey } : undefined;
  const response = await axios.get(provider.url, {
    params,
    headers,
    responseType: 'arraybuffer',
    timeout: 25_000,
    maxContentLength: 50 * 1024 * 1024,
  });
  const raw = Buffer.from(response.data);
  const contentType = response.headers?.['content-type'] || '';
  const payload = parseJsonBuffer(raw);

  if (!payload) {
    const directUrl = raw.toString('utf8').trim();
    if (/^https?:\/\/\S+$/i.test(directUrl)) {
      const media = await fetchMediaFile(directUrl, format);
      return { ...media, title: '', quality: '' };
    }
    return {
      ...validateMediaBuffer(raw, format, contentType),
      title: '',
      quality: '',
    };
  }
  if (payload?.success === false || payload?.status === false || payload?.error) {
    throw new Error(payload?.message || payload?.error || 'Provider reported failure');
  }

  const downloadUrl = findDownloadUrl(payload, format);
  if (!downloadUrl) throw new Error('Provider response did not include a media URL');
  const media = await fetchMediaFile(downloadUrl, format);
  return {
    ...media,
    title: findTitle(payload),
    thumbnail: payload?.thumbnail || payload?.result?.thumbnail || '',
    quality: payload?.quality || payload?.result?.quality || '',
  };
}

async function fetchYoutubeMedia(videoUrl, format) {
  const failures = [];
  for (const provider of youtubeDownloadProviders(format)) {
    try {
      const result = await downloadFromProvider(provider, videoUrl, format);
      console.log(`[YT] ${provider.name} succeeded for ${format}`);
      return {
        ...result,
        quality: result.quality || (format === 'mp4' ? 'MP4' :
          result.mimetype === 'audio/mp4' ? 'M4A' : 'MP3'),
      };
    } catch (error) {
      failures.push(`${provider.name}: ${error.message}`);
      console.warn(`[YT] ${provider.name} failed: ${error.message}`);
    }
  }
  console.error(`[YT] All ${format} providers failed (${failures.length})`);
  throw new Error('The download services did not return a valid media file. Please retry in a few minutes.');
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isYoutubeUrl(s) { return YT_URL_RE.test(s || ''); }

function dedupeYoutubeResults(results) {
  const seen = new Set();
  return results.filter(result => {
    if (!result?.title || !result?.url) return false;
    const id = result.url.match(YT_URL_RE)?.[1] || result.url;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function searchWithApi(api, query) {
  try {
    const { data } = await axios.get(api.url, {
      params: api.params(query),
      timeout: 10_000,
    });
    const results = dedupeYoutubeResults(api.parse(data));
    if (!results.length) throw new Error('Provider returned no usable YouTube results');
    console.log(`[YT] search ${api.name} succeeded (${results.length} results)`);
    return results;
  } catch (error) {
    console.warn(`[YT] search ${api.name} failed: ${error.message}`);
    throw error;
  }
}

function extractInitialData(html) {
  const marker = /(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=)\s*(\{)/.exec(html);
  if (!marker) throw new Error('YouTube search page did not include initial result data');

  const start = marker.index + marker[0].lastIndexOf('{');
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      return JSON.parse(html.slice(start, index + 1));
    }
  }
  throw new Error('YouTube search page returned incomplete result data');
}

function readRendererText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map(run => run?.text || '').join('');
  return value.accessibility?.accessibilityData?.label || '';
}

function getYoutubeRenderers(root) {
  const queue = [root];
  const visited = new Set();
  const results = [];
  let cursor = 0;
  while (cursor < queue.length && visited.size < 60_000) {
    const value = queue[cursor++];
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) queue.push(child);
      continue;
    }
    const renderer = value.videoRenderer || value.gridVideoRenderer;
    if (renderer?.videoId) results.push(renderer);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return results;
}

async function searchYoutubeWeb(query) {
  const { data: html } = await axios.get('https://www.youtube.com/results', {
    params: { search_query: query },
    timeout: 15_000,
    maxContentLength: 4 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (typeof html !== 'string' || !html.includes('ytInitialData')) {
    throw new Error('YouTube returned an unexpected search page');
  }

  const renderers = getYoutubeRenderers(extractInitialData(html));
  const results = dedupeYoutubeResults(renderers.map(renderer => {
    const videoId = renderer.videoId;
    const thumbnails = renderer.thumbnail?.thumbnails || [];
    const owner = renderer.ownerText || renderer.shortBylineText || renderer.longBylineText;
    return {
      title: readRendererText(renderer.title),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      channel: readRendererText(owner),
      duration: readRendererText(renderer.lengthText),
      views: readRendererText(renderer.viewCountText),
      thumbnail: thumbnails.at(-1)?.url || '',
    };
  }).filter(result => result.title && result.url));

  if (!results.length) throw new Error('YouTube search page contained no usable videos');
  console.log(`[YT] YouTube webpage fallback succeeded (${results.length} results)`);
  return results;
}

async function searchYouTube(query) {
  const enabled = ytSearchAPIs.filter(a => a.enabled);
  if (enabled.length) {
    try {
      // Run independent providers together; Promise.any returns the first
      // provider that produces valid results, not merely the first HTTP 200.
      return await Promise.any(enabled.map(api => searchWithApi(api, query)));
    } catch {
      console.warn('[YT] all configured search APIs failed; trying YouTube directly');
    }
  }
  return searchYoutubeWeb(query);
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
      text: `❌ *YouTube search could not load results from the configured APIs or YouTube.*\nPlease try again shortly or send a direct YouTube link.`,
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
      text: `❌ *YouTube search could not load results from the configured APIs or YouTube.*\nPlease try again shortly.`,
    }, { quoted: msg });
  }
}