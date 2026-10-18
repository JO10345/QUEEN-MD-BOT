/**
 * TikTok Downloader
 *
 * Providers:
 *   David Cyril tiktokv2, tiktokv4, and tiktokv3 fallbacks.
 *   TikWM /api fallback.
 *
 * Commands:
 *   !tiktok <url>  — download TikTok video without watermark
 *   !tt <url>      — alias
 */

import axios from 'axios';

const TT_APIS = [
  process.env.TIKTOK_API_URL,
  'https://apis.davidcyriltech.my.id/download/tiktokv2',
  'https://apis.davidcyriltech.my.id/download/tiktokv4',
  'https://apis.davidcyriltech.my.id/download/tiktokv3',
  'https://tikwm.com/api/',
].filter((value, index, values) => value && values.indexOf(value) === index);

function firstString(...values) {
  return values.find(value => typeof value === 'string' && /^https?:\/\//i.test(value));
}

function getDownloadUrl(result) {
  if (!result) return null;
  const preferredKeys = [
    'nowm', 'no_watermark', 'noWatermark', 'nowatermark',
    'hdplay', 'hdPlay', 'video_no_watermark', 'videoUrl',
    'download_url', 'downloadUrl', 'video', 'play', 'url',
  ];
  for (const key of preferredKeys) {
    const url = firstString(result?.[key]);
    if (url) return url;
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      const url = getDownloadUrl(item);
      if (url) return url;
    }
  }
  for (const value of Object.values(result)) {
    if (value && typeof value === 'object') {
      const url = getDownloadUrl(value);
      if (url) return url;
    }
  }
  return null;
}

function extractResult(data) {
  return data?.result ?? data?.results ?? data?.data ?? data?.response ?? data;
}

async function findTikTokDownload(url) {
  const errors = [];
  for (const endpoint of TT_APIS) {
    try {
      const { data } = await axios.get(endpoint, {
        params: { url },
        timeout: 30_000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (data?.success === false || data?.status === false) {
        throw new Error(data?.message || 'API returned an error');
      }
      const result = extractResult(data);
      const videoUrl = getDownloadUrl(result);
      if (videoUrl) return { result, videoUrl, endpoint };
      throw new Error('API returned no video URL');
    } catch (error) {
      const provider = endpoint.includes('tikwm.com') ? 'tikwm' : (endpoint.split('/').pop() || 'provider');
      errors.push(`${provider}: ${error?.message || error}`);
      console.warn(`[TIKTOK] ${endpoint} failed: ${error?.message || error}`);
    }
  }
  throw new Error(`TikTok providers failed (${errors.join(' | ')})`);
}

export async function handleTiktok(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const url = (args || '').trim();

  if (!url) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:* !tiktok <tiktok link>\n\n` +
        `Example:\n` +
        `!tiktok https://vt.tiktok.com/ZSeJ7P56G/\n\n` +
        `Supports: TikTok videos (no watermark)`,
    }, { quoted: msg });
  }

  if (!/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) {
    return sock.sendMessage(jid, {
      text: `❌ *Invalid URL.*\nPlease send a valid TikTok link.\n\nExample: https://vt.tiktok.com/ZSeJ7P56G/`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, { text: `⬇️ *Downloading TikTok video...*\n_Please wait..._` }, { quoted: msg });

  try {
    const { result: r, videoUrl, endpoint } = await findTikTokDownload(url);
    console.log(`[TIKTOK] using ${endpoint}`);
    const title = r.title || r.desc || r.description || r.caption || 'TikTok Video';
    const author = r.author?.nickname || r.author?.unique_id || r.author?.uniqueId ||
      r.nickname || r.username || '';
    const likes = r.digg_count || r.like_count || r.likes || r.stats?.likes || '';
    const plays = r.play_count || r.plays || r.stats?.plays || '';
    const duration = r.duration || r.video?.duration || '';

    await sock.sendMessage(jid, { text: `📥 *Found!* Downloading...` });
    const res = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const buf = Buffer.from(res.data);
    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);
    if (buf.length > 50 * 1024 * 1024) {
      return sock.sendMessage(jid, {
        text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is ~50 MB.`,
      }, { quoted: msg });
    }

    let caption = `🎵 *${title}*`;
    if (author) caption += `\n👤 @${author}`;
    if (duration) caption += `  ⏱️ ${duration}s`;
    if (plays) caption += `\n▶️ ${plays} plays`;
    if (likes) caption += `  ❤️ ${likes} likes`;
    caption += `\n📦 ${sizeMb} MB  ·  _No watermark_ ✅`;

    await sock.sendMessage(jid, {
      video: buf,
      caption,
      mimetype: 'video/mp4',
    }, { quoted: msg });
  } catch (err) {
    console.error('[TIKTOK] error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Download failed.*\n_${err.message}_\n\nMake sure the link is a valid TikTok URL and try again.`,
    }, { quoted: msg });
  }
}