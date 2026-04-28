/**
 * !yt / !youtube — YouTube video downloader
 *
 * Workflow:
 *  1. Resolve URL via yt-dl worker API.
 *  2. Download the best-fit progressive stream (≤ 360p preferred).
 *  3. Re-encode to H.264 + AAC with `+faststart` so WhatsApp can play it.
 *     YouTube increasingly serves AV1, which WhatsApp cannot decode — that's
 *     why downloads "succeed" but show "can't play this video".
 *  4. If ffmpeg is missing, send the file as a document so it still works
 *     in any external player.
 */

import ytSearch from 'yt-search';
import axios    from 'axios';
import { spawnSync } from 'child_process';
import {
  writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, statSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR  = join(__dirname, '../../temp');
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

const YTDL_API  = 'https://yt-dl.officialhectormanuel.workers.dev';
const YT_REGEX  = /(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))([\w-]{11})/;
const MAX_BYTES = 50 * 1024 * 1024;
const PREFERRED = ['360', '240', '480', '144', '720'];

function pickVideoQuality(videos, available) {
  const hasAvail = Array.isArray(available) && available.length > 0;
  for (const q of PREFERRED) {
    if (videos[q] && (!hasAvail || available.includes(q))) {
      return { url: videos[q], quality: q };
    }
  }
  const candidates = hasAvail ? available : Object.keys(videos);
  for (const q of candidates) {
    if (videos[q]) return { url: videos[q], quality: q };
  }
  return null;
}

function hasFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch { return false; }
}

function videoCodec(filePath) {
  try {
    const r = spawnSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  } catch { return ''; }
}

// Re-encode to H.264 + AAC with faststart. Returns true on success.
function transcodeToH264(inputPath, outputPath) {
  const r = spawnSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // ensure even dimensions
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-loglevel', 'error',
    outputPath,
  ], { encoding: 'utf8', timeout: 300_000 }); // up to 5 minutes
  return r.status === 0 && existsSync(outputPath) && statSync(outputPath).size > 1000;
}

// Just remux with faststart (no re-encode) — used when codec is already H.264
function remuxFaststart(inputPath, outputPath) {
  const r = spawnSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-loglevel', 'error',
    outputPath,
  ], { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 && existsSync(outputPath) && statSync(outputPath).size > 1000;
}

export async function handleYouTube(sock, msg, query) {
  const jid = msg.key.remoteJid;
  const ts  = Date.now();
  const rawPath  = join(TEMP_DIR, `yt_${ts}_raw.mp4`);
  const outPath  = join(TEMP_DIR, `yt_${ts}_out.mp4`);

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

    const res = await axios.get(`${YTDL_API}/`, {
      params:  { url: videoUrl },
      timeout: 30_000,
    });
    const data = res.data;
    if (!data?.status) throw new Error('API returned error status');
    title = data.title || title || 'video';

    const pick = pickVideoQuality(data.videos || {}, data.available_qualities || []);
    if (!pick) throw new Error('No downloadable video quality found');

    await sock.sendMessage(jid, {
      text: `📹 *${title}*\n🎞️ Quality: ${pick.quality}p\n📥 Downloading...`,
    });

    const dl = await axios.get(pick.url, {
      responseType:     'arraybuffer',
      timeout:          180_000,
      maxContentLength: MAX_BYTES,
      maxBodyLength:    MAX_BYTES,
      headers:          { 'User-Agent': 'Mozilla/5.0' },
    });

    const rawBuf = Buffer.from(dl.data);
    if (rawBuf.length < 1000) throw new Error('Downloaded file too small');
    writeFileSync(rawPath, rawBuf);

    let finalPath = rawPath;
    let processed = false;

    if (hasFfmpeg()) {
      const codec = videoCodec(rawPath);
      // WhatsApp only plays H.264. AV1, VP9, etc. must be re-encoded.
      if (codec && codec !== 'h264') {
        await sock.sendMessage(jid, {
          text: `⚙️ Converting *${codec.toUpperCase()}* → *H.264* for WhatsApp...\n_(this takes ~30s)_`,
        });
        if (transcodeToH264(rawPath, outPath)) {
          finalPath = outPath;
          processed = true;
        }
      } else {
        // Already H.264 — just fix moov atom position
        if (remuxFaststart(rawPath, outPath)) {
          finalPath = outPath;
          processed = true;
        }
      }
    }

    const fileSize = statSync(finalPath).size;
    const finalBuf = readFileSync(finalPath);

    if (!processed) {
      // ffmpeg missing — send as document so user can play it externally
      const safeName = title.replace(/[^\w\s.-]/g, '').slice(0, 60).trim() || 'video';
      await sock.sendMessage(jid, {
        document: finalBuf,
        mimetype: 'video/mp4',
        fileName: `${safeName}.mp4`,
        caption:  `📹 *${title}*\n_${pick.quality}p_\n\n_⚠️ Sent as file because ffmpeg is not installed. Install ffmpeg for inline playback._`,
      }, { quoted: msg });
    } else if (fileSize > MAX_BYTES) {
      await sock.sendMessage(jid, {
        text: `❌ Video is too large (${(fileSize / 1024 / 1024).toFixed(1)} MB).\nTry a shorter clip.`,
      });
    } else {
      await sock.sendMessage(jid, {
        video:    finalBuf,
        caption:  `📹 *${title}*\n_${pick.quality}p • Powered by Queen MD Bot_`,
        mimetype: 'video/mp4',
      }, { quoted: msg });
    }

  } catch (err) {
    console.error('YouTube error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Could not download video.\n_${err.message}_\n\nTry a shorter video or a direct YouTube link.`,
    });
  } finally {
    for (const p of [rawPath, outPath]) {
      try { if (existsSync(p)) unlinkSync(p); } catch {}
    }
  }
}
