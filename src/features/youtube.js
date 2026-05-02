/**
 * YouTube downloader — uses the EliteProTech API which returns a direct
 * H.264/AAC MP4 URL (itag 18, 360p) that WhatsApp can play natively.
 *
 * NO ffmpeg, NO transcoding, NO heavy memory use.
 *
 * APIs:
 *   GET /ytsearch?q=<query>            — search videos
 *   GET /ytv?url=<youtube-url>          — get direct MP4 download links
 *
 * The bot streams the file straight to disk, sends it, then deletes it.
 * Cap size at 50 MB so we never crash a small server.
 */

import axios from 'axios';
import { createWriteStream, statSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR  = join(__dirname, '../../temp');
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

const API_BASE = process.env.YTAPI_BASE || 'https://eliteprotech-apis.zone.id';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB ceiling for video sends
const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// ── Helpers ──────────────────────────────────────────────────────────────────
function isYoutubeUrl(s) { return YT_URL_RE.test(s || ''); }

async function searchFirst(query) {
  const { data } = await axios.get(`${API_BASE}/ytsearch`, {
    params:  { q: query },
    timeout: 20_000,
  });
  const v = data?.results?.videos?.[0];
  if (!v?.url) throw new Error('No search results found.');
  return v;
}

async function getMp4(url) {
  const { data } = await axios.get(`${API_BASE}/ytv`, {
    params:  { url },
    timeout: 30_000,
  });
  const formats = data?.data?.formats || [];
  if (formats.length === 0) throw new Error('No downloadable formats returned.');

  // Prefer itag 18 (360p mp4 with audio, H.264 + AAC — universal)
  let chosen = formats.find(f => f.itag === 18);

  // Otherwise: any mp4 with both audio & video, smallest first
  if (!chosen) {
    const mp4s = formats
      .filter(f => /mp4/i.test(f.mimeType || '') && f.hasAudio !== false && f.hasVideo !== false)
      .sort((a, b) => Number(a.contentLength || 0) - Number(b.contentLength || 0));
    chosen = mp4s[0] || formats[0];
  }

  return {
    url:      chosen.url,
    title:    data?.data?.title || 'video',
    size:     Number(chosen.contentLength || 0),
    quality:  chosen.qualityLabel || chosen.quality || '?',
  };
}

async function streamToFile(url, dest) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 120_000,
    maxRedirects: 5,
    maxContentLength: MAX_BYTES,
  });

  const writer = createWriteStream(dest);
  let bytes = 0;
  res.data.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      res.data.destroy();
      writer.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error',  reject);
    res.data.on('error', reject);
  });

  return bytes;
}

// ── Main entry ───────────────────────────────────────────────────────────────
export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:* !yt <link or search>\n\nExample: *!yt despacito*`,
    }, { quoted: msg });
    return;
  }

  let tempPath = '';
  try {
    await sock.sendMessage(jid, { text: `🔍 *Searching...*` });

    // 1. Resolve URL (search if needed)
    let videoUrl, title;
    if (isYoutubeUrl(query)) {
      videoUrl = query.trim();
      title    = 'YouTube Video';
    } else {
      const v = await searchFirst(query.trim());
      videoUrl = v.url;
      title    = v.title;
      await sock.sendMessage(jid, {
        text: `🎬 Found: *${title}*\n⏱️ ${v.duration || '?'}  ·  👁️ ${(v.views || 0).toLocaleString()} views\n\n_Downloading..._`,
      });
    }

    // 2. Get direct MP4 link
    const mp4 = await getMp4(videoUrl);
    title = mp4.title || title;

    // Pre-flight size check (saves a wasted download)
    if (mp4.size && mp4.size > MAX_BYTES) {
      await sock.sendMessage(jid, {
        text: `⚠️ *Too large:* ${(mp4.size / 1024 / 1024).toFixed(1)} MB (limit 50 MB).\n\nTry a shorter video.`,
      }, { quoted: msg });
      return;
    }

    // 3. Stream download to temp file
    tempPath = join(TEMP_DIR, `yt_${Date.now()}.mp4`);
    const bytes = await streamToFile(mp4.url, tempPath);
    if (!existsSync(tempPath) || statSync(tempPath).size === 0) {
      throw new Error('Download finished empty.');
    }
    if (bytes > MAX_BYTES) {
      throw new Error(`File grew past ${MAX_BYTES / 1024 / 1024} MB ceiling.`);
    }

    // 4. Send video — H.264/AAC plays natively in WhatsApp
    await sock.sendMessage(jid, {
      video:   { url: tempPath },
      caption: `🎬 *${title}*\n📺 ${mp4.quality}  ·  ${(bytes / 1024 / 1024).toFixed(1)} MB`,
      mimetype: 'video/mp4',
    }, { quoted: msg });

  } catch (err) {
    console.error('YouTube error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Couldn't download.\n_${err.message}_\n\nTip: try a shorter video or different search.`,
    }, { quoted: msg });
  } finally {
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}
