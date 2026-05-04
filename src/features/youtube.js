/**
 * YouTube Downloader — uses two Hector Manuel APIs:
 *
 *   Search:   GET https://hector-api.vercel.app/search/youtube?q=<query>
 *   Download: GET https://yt-dl.officialhectormanuel.workers.dev/?url=<yt-url>
 *
 * Response shape (download API):
 *   { status, title, thumbnail, audio: <mp3-url>, videos: {144, 360, 480},
 *     available_qualities: ['360','480','144','mp3'] }
 *
 * Commands:
 *   !yt <url or search>   — fetch video info + quality menu
 *   !ytdl <quality>       — download selected quality (e.g. 360, 480, mp3)
 *   !yta <url or search>  — download audio (mp3) directly
 */

import axios from 'axios';
import { createWriteStream, statSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR  = join(__dirname, '../../temp');
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

const DOWNLOAD_API = 'https://yt-dl.officialhectormanuel.workers.dev/';
const SEARCH_API   = 'https://hector-api.vercel.app/search/youtube';
const MAX_BYTES    = 80 * 1024 * 1024; // 80 MB ceiling

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// Per-chat pending download session: jid -> { title, thumbnail, audio, videos, available_qualities }
const pending = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isYoutubeUrl(s) { return YT_URL_RE.test(s || ''); }

async function searchFirst(query) {
  const { data } = await axios.get(SEARCH_API, {
    params:  { q: query },
    timeout: 20_000,
  });
  if (!data?.status || !data?.result?.length) throw new Error('No search results found.');
  const v = data.result[0];
  if (!v?.link) throw new Error('Search returned no video link.');
  return v; // { title, channel, duration, imageUrl, link }
}

async function getVideoInfo(url) {
  const { data } = await axios.get(DOWNLOAD_API, {
    params:  { url },
    timeout: 30_000,
  });
  if (!data?.status) throw new Error(data?.error || 'Download API returned an error.');
  return data; // { title, thumbnail, audio, videos, available_qualities }
}

async function streamToFile(url, dest) {
  const res = await axios.get(url, {
    responseType:      'stream',
    timeout:           180_000,
    maxRedirects:      10,
    maxContentLength:  MAX_BYTES,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WhatsAppBot/1.0)',
    },
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

function buildQualityMenu(info) {
  const qs = info.available_qualities || Object.keys(info.videos || {});
  const lines = [
    `🎬 *${info.title}*`,
    ``,
    `📺 *Available Qualities:*`,
  ];

  const videoQualities = qs.filter(q => q !== 'mp3');
  const hasAudio = qs.includes('mp3') || !!info.audio;

  videoQualities.sort((a, b) => Number(a) - Number(b));

  for (const q of videoQualities) {
    lines.push(`  ▶️  *${q}p* — reply *!ytdl ${q}*`);
  }
  if (hasAudio) {
    lines.push(`  🎵  *MP3 Audio* — reply *!ytdl mp3*`);
  }

  lines.push(``, `_Session saved. Reply with your choice above._`);
  return lines.join('\n');
}

// ── Main entry: !yt <url or search> ──────────────────────────────────────────

export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:*\n  *!yt* <YouTube link or search term>\n  *!yta* <link or search> — audio only\n  *!ytdl* <quality> — after choosing a video`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: `🔍 *Searching...*` });

    // 1. Resolve URL
    let videoUrl, searchTitle, searchThumb;
    if (isYoutubeUrl(query.trim())) {
      videoUrl = query.trim();
    } else {
      const v = await searchFirst(query.trim());
      videoUrl    = v.link;
      searchTitle = v.title;
      searchThumb = v.imageUrl;
      await sock.sendMessage(jid, {
        text: `🎬 Found: *${v.title}*\n⏱️ ${v.duration || '?'}  ·  📺 ${v.channel || ''}`,
      });
    }

    // 2. Fetch quality info
    const info = await getVideoInfo(videoUrl);
    const title = info.title || searchTitle || 'YouTube Video';
    info.title = title;
    if (!info.thumbnail && searchThumb) info.thumbnail = searchThumb;

    // Save session for !ytdl
    pending.set(jid, info);

    // 3. Show quality menu
    const menu = buildQualityMenu(info);

    if (info.thumbnail) {
      try {
        const imgRes = await axios.get(info.thumbnail, { responseType: 'arraybuffer', timeout: 10_000 });
        await sock.sendMessage(jid, {
          image:   Buffer.from(imgRes.data),
          caption: menu,
        }, { quoted: msg });
        return;
      } catch { /* fall through to text */ }
    }

    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    await sock.sendMessage(jid, {
      text: `❌ Could not fetch video info.\n_${err.message}_\n\nTip: Try a different search term or URL.`,
    }, { quoted: msg });
  }
}

// ── Download entry: !ytdl <quality> ──────────────────────────────────────────

export async function handleYtDl(sock, msg, qualityArg) {
  const jid = msg.key.remoteJid;

  const session = pending.get(jid);
  if (!session) {
    await sock.sendMessage(jid, {
      text: `❌ No pending video. First use *!yt <link or search>* to pick a video.`,
    }, { quoted: msg });
    return;
  }

  const q = (qualityArg || '').toLowerCase().trim();
  if (!q) {
    await sock.sendMessage(jid, {
      text: buildQualityMenu(session),
    }, { quoted: msg });
    return;
  }

  // Resolve download URL
  let dlUrl, isAudio = false, label = q;
  if (q === 'mp3' || q === 'audio') {
    dlUrl   = session.audio;
    isAudio = true;
    label   = 'MP3 Audio';
    if (!dlUrl) {
      await sock.sendMessage(jid, { text: '❌ No audio stream available for this video.' }, { quoted: msg });
      return;
    }
  } else {
    const p = q.replace(/p$/, ''); // allow "360p" or "360"
    dlUrl = session.videos?.[p];
    label = `${p}p`;
    if (!dlUrl) {
      const available = Object.keys(session.videos || {}).join(', ') || '—';
      await sock.sendMessage(jid, {
        text: `❌ Quality *${q}* not available.\nAvailable: ${available}, mp3`,
      }, { quoted: msg });
      return;
    }
  }

  let tempPath = '';
  try {
    await sock.sendMessage(jid, {
      text: `⬇️ *Downloading ${label}...*\n🎬 ${session.title}`,
    });

    const ext      = isAudio ? 'mp3' : 'mp4';
    tempPath       = join(TEMP_DIR, `yt_${Date.now()}.${ext}`);
    const bytes    = await streamToFile(dlUrl, tempPath);

    if (!existsSync(tempPath) || statSync(tempPath).size === 0) {
      throw new Error('Download completed but file is empty.');
    }
    if (bytes > MAX_BYTES) {
      throw new Error(`File is too large (${(bytes / 1024 / 1024).toFixed(1)} MB). Limit is 80 MB.`);
    }

    const sizeMb = (statSync(tempPath).size / 1024 / 1024).toFixed(1);
    const caption = `${isAudio ? '🎵' : '🎬'} *${session.title}*\n📺 ${label}  ·  ${sizeMb} MB`;

    if (isAudio) {
      await sock.sendMessage(jid, {
        audio:    { url: tempPath },
        mimetype: 'audio/mpeg',
        caption,
        ptt: false,
      }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, {
        video:    { url: tempPath },
        caption,
        mimetype: 'video/mp4',
      }, { quoted: msg });
    }

    // Clear session after successful download
    pending.delete(jid);

  } catch (err) {
    await sock.sendMessage(jid, {
      text: `❌ Download failed: _${err.message}_`,
    }, { quoted: msg });
  } finally {
    if (tempPath && existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

// ── Audio shortcut: !yta <url or search> ─────────────────────────────────────

export async function handleYtAudio(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:* !yta <YouTube link or search term>`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: `🎵 *Finding audio...*` });

    let videoUrl, title;
    if (isYoutubeUrl(query.trim())) {
      videoUrl = query.trim();
      title    = 'YouTube Audio';
    } else {
      const v = await searchFirst(query.trim());
      videoUrl = v.link;
      title    = v.title;
      await sock.sendMessage(jid, { text: `🎵 Found: *${v.title}*\n⏱️ ${v.duration || '?'}` });
    }

    const info = await getVideoInfo(videoUrl);
    title = info.title || title;

    if (!info.audio) {
      await sock.sendMessage(jid, { text: '❌ No audio stream available for this video.' }, { quoted: msg });
      return;
    }

    await sock.sendMessage(jid, { text: `⬇️ *Downloading MP3...*\n🎵 ${title}` });

    const tempPath = join(TEMP_DIR, `yta_${Date.now()}.mp3`);
    let bytes;
    try {
      bytes = await streamToFile(info.audio, tempPath);
    } catch (dlErr) {
      throw new Error(`Audio download failed: ${dlErr.message}`);
    }

    if (!existsSync(tempPath) || statSync(tempPath).size === 0) {
      throw new Error('Download completed but file is empty.');
    }

    const sizeMb = (statSync(tempPath).size / 1024 / 1024).toFixed(1);

    await sock.sendMessage(jid, {
      audio:    { url: tempPath },
      mimetype: 'audio/mpeg',
      ptt:      false,
    }, { quoted: msg });

    await sock.sendMessage(jid, {
      text: `🎵 *${title}*\n📦 ${sizeMb} MB`,
    }, { quoted: msg });

    try { unlinkSync(tempPath); } catch {}

  } catch (err) {
    await sock.sendMessage(jid, {
      text: `❌ Could not download audio.\n_${err.message}_`,
    }, { quoted: msg });
  }
}
