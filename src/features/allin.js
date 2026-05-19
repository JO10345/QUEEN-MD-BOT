/**
 * All-in-One Video Downloader
 *
 * API: https://api.botcahx.eu.org/api/dowloader/allin?url=&apikey=GMauog6R
 *
 * Supports: TikTok, Instagram, Twitter/X, Facebook, Pinterest, and more.
 *
 * Commands:
 *   !dl <video link>  — download video from any supported platform
 */

import axios from 'axios';

const BOTCAHX_KEY = 'GMauog6R';
const ALLIN_API   = 'https://api.botcahx.eu.org/api/dowloader/allin';
const MAX_MB      = 50;

// ── Platform detection ────────────────────────────────────────────────────────

function detectPlatform(url) {
  if (/tiktok\.com|vm\.tiktok/i.test(url))   return 'TikTok';
  if (/instagram\.com/i.test(url))            return 'Instagram';
  if (/twitter\.com|x\.com|t\.co/i.test(url)) return 'Twitter/X';
  if (/facebook\.com|fb\.watch/i.test(url))   return 'Facebook';
  if (/youtube\.com|youtu\.be/i.test(url))    return 'YouTube';
  if (/pinterest\.com|pin\.it/i.test(url))    return 'Pinterest';
  return 'Video';
}

function isUrl(s) { return /^https?:\/\//i.test(s || ''); }

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleAllInOne(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const url = (args || '').trim();

  if (!url || !isUrl(url)) {
    await sock.sendMessage(jid, {
      text:
        `❌ *Usage:* !dl <video link>\n\n` +
        `📱 *Supported platforms:*\n` +
        `  • TikTok\n` +
        `  • Instagram (Reels / Posts)\n` +
        `  • Twitter / X\n` +
        `  • Facebook\n` +
        `  • Pinterest\n` +
        `  • and more!\n\n` +
        `_Example:_ !dl https://www.tiktok.com/@user/video/123`,
    }, { quoted: msg });
    return;
  }

  const platform = detectPlatform(url);

  try {
    await sock.sendMessage(jid, {
      text: `🔍 *Fetching ${platform} video...*\n_Please wait..._`,
    });

    const { data } = await axios.get(ALLIN_API, {
      params: { url, apikey: BOTCAHX_KEY },
      timeout: 35_000,
    });

    if (!data || data.status === false) {
      throw new Error(data?.message || 'API returned an error. Try a different link.');
    }

    const r = data.result || data.data || data;

    // Try to extract a usable direct video URL from any response shape
    const dlUrl = (
      r?.url || r?.video || r?.videoUrl || r?.download ||
      r?.urls?.[0]?.url || r?.urls?.[0]?.hd || r?.urls?.[0]?.sd ||
      r?.medias?.[0]?.url || r?.nowm || r?.nwm ||
      r?.videos?.[0]?.url || r?.link || r?.src || r?.media || ''
    );

    if (!dlUrl || typeof dlUrl !== 'string') {
      await sock.sendMessage(jid, {
        text:
          `⚠️ *Got a response but couldn't find a download URL.*\n\n` +
          `This platform may need a different link format.\n` +
          `Try copying the direct video link instead of a share link.`,
      }, { quoted: msg });
      return;
    }

    await sock.sendMessage(jid, {
      text: `⬇️ *Downloading from ${platform}...*`,
    });

    const res = await axios.get(dlUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url },
    });

    const buf    = Buffer.from(res.data);
    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);

    if (buf.length > MAX_MB * 1024 * 1024) {
      await sock.sendMessage(jid, {
        text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is ${MAX_MB} MB.`,
      }, { quoted: msg });
      return;
    }

    const title  = r?.title || r?.desc || r?.caption || '';
    const author = r?.author || r?.nickname || r?.user?.nickname || '';

    let caption = title ? `📲 *${title.slice(0, 80)}*\n` : `📲 *${platform} Video*\n`;
    if (author) caption += `👤 ${author}\n`;
    caption += `🌐 ${platform}  ·  📦 ${sizeMb} MB`;

    const isAudio = dlUrl.includes('.mp3') || dlUrl.includes('audio');

    if (isAudio) {
      await sock.sendMessage(jid, {
        audio: buf, mimetype: 'audio/mpeg', ptt: false,
      }, { quoted: msg });
      await sock.sendMessage(jid, { text: caption });
    } else {
      await sock.sendMessage(jid, {
        video: buf, caption, mimetype: 'video/mp4',
      }, { quoted: msg });
    }

  } catch (err) {
    console.error('[ALLIN] error:', err.message);
    let errMsg = err.message;
    if (err.response?.status === 404) {
      errMsg = 'This URL format is not supported yet. Try a direct video link.';
    }
    await sock.sendMessage(jid, {
      text:
        `❌ *Download failed.*\n_${errMsg}_\n\n` +
        `💡 *Tips:*\n` +
        `• Make sure the post/video is public\n` +
        `• Use the direct video link, not a profile page\n` +
        `• For TikTok, use the full link (not short vm.tiktok link)`,
    }, { quoted: msg });
  }
}
