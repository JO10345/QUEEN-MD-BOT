/**
 * Facebook Video Downloader
 *
 * API: https://api.botcahx.eu.org/api/dowloader/fbdown2?url=&apikey=GMauog6R
 *
 * Response: { status, result: { status, url: { title, isHdAvailable, urls: [{ hd, sd }] } } }
 *
 * Commands:
 *   !fbdl <facebook link>  — fetch HD/SD options
 *   !fbdl 1               — download HD
 *   !fbdl 2               — download SD
 */

import axios from 'axios';

const BOTCAHX_KEY = 'GMauog6R';
const FB_API      = 'https://api.botcahx.eu.org/api/dowloader/fbdown2';

const FB_URL_RE = /facebook\.com\/(watch|video|reel|share\/v)|fb\.watch/i;

// Per-chat pending: jid → { hd, sd, title }
const pending = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFacebookUrl(url) { return FB_URL_RE.test(url || ''); }

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleFbDl(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const input = (args || '').trim();

  // ── Quality selection ──
  if (input === '1' || input === '2') {
    const state = pending.get(jid);
    if (!state) {
      await sock.sendMessage(jid, {
        text: `❌ No pending download. Send *!fbdl <facebook link>* first.`,
      }, { quoted: msg });
      return;
    }

    const isHD    = input === '1';
    const dlUrl   = isHD ? state.hd : state.sd;
    const quality = isHD ? 'HD' : 'SD';

    if (!dlUrl) {
      await sock.sendMessage(jid, {
        text: `❌ *${quality}* quality is not available for this video. Try the other option.`,
      }, { quoted: msg });
      return;
    }

    try {
      await sock.sendMessage(jid, {
        text: `⬇️ *Downloading Facebook video*\n📺 Quality: *${quality}*\n\n_Please wait..._`,
      });

      const res = await axios.get(dlUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.facebook.com/' },
      });

      const buf    = Buffer.from(res.data);
      const sizeMb = (buf.length / 1024 / 1024).toFixed(1);

      if (buf.length > 50 * 1024 * 1024) {
        await sock.sendMessage(jid, {
          text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is 50 MB. Try SD instead.`,
        }, { quoted: msg });
        return;
      }

      pending.delete(jid);

      await sock.sendMessage(jid, {
        video:    buf,
        caption:  `📘 *${state.title}*\n📺 ${quality}  ·  📦 ${sizeMb} MB`,
        mimetype: 'video/mp4',
      }, { quoted: msg });

    } catch (err) {
      console.error('[FB] download error:', err.message);
      await sock.sendMessage(jid, {
        text: `❌ *Download failed.*\n_${err.message}_`,
      }, { quoted: msg });
    }
    return;
  }

  // ── New URL ──
  if (!input) {
    await sock.sendMessage(jid, {
      text:
        `❌ *Usage:*\n` +
        `• *!fbdl <facebook video link>* — get options\n` +
        `• *!fbdl 1* — HD quality\n` +
        `• *!fbdl 2* — SD quality\n\n` +
        `Supported links:\n` +
        `  facebook.com/watch/...\n` +
        `  facebook.com/video/...\n` +
        `  facebook.com/reel/...\n` +
        `  fb.watch/...`,
    }, { quoted: msg });
    return;
  }

  if (!isFacebookUrl(input)) {
    await sock.sendMessage(jid, {
      text: `❌ *Invalid URL.* Please send a Facebook video or reel link.`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: `🔍 *Fetching Facebook video info...*` });

    const { data } = await axios.get(FB_API, {
      params: { url: input, apikey: BOTCAHX_KEY },
      timeout: 30_000,
    });

    if (!data?.status) throw new Error(data?.message || 'API returned an error.');
    const r = data.result;
    if (!r || r.status !== 'success') throw new Error(r?.message || 'Could not fetch video info.');

    const urlData = r.url;
    const urls    = urlData?.urls?.[0] || {};

    const info = {
      title:     urlData?.title || 'Facebook Video',
      isHdAvail: urlData?.isHdAvailable || false,
      hd:        urls.hd || '',
      sd:        urls.sd || urls.hd || '',
    };

    pending.set(jid, info);

    const menu =
      `📘 *${info.title}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📥 *Choose quality:*\n\n` +
      `  *1.* 📹 HD Quality${info.isHdAvail ? ' ✅' : ''}\n` +
      `  *2.* 📹 SD Quality\n\n` +
      `_Reply:_ *!fbdl 1* or *!fbdl 2*`;

    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('[FB] info error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Couldn't fetch video info.*\n_${err.message}_\n\nMake sure the video is public.`,
    }, { quoted: msg });
  }
}
