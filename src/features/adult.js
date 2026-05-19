/**
 * Adult Content Downloader (18+ only)
 *
 * Supported: XVideos
 * API: https://api.botcahx.eu.org/api/download/xvideosdl?url=&apikey=GMauog6R
 *
 * Response: { status, result: { title, thumb, views, like_count, url } }
 *
 * Commands:
 *   !xvdl <xvideos url>  — triggers 18+ age verification, then downloads video
 *
 * Flow:
 *   1. User sends !xvdl <url>
 *   2. Bot sends age verification prompt
 *   3. User replies "yes" → downloads and sends video
 *   4. Any other reply   → cancelled
 */

import axios from 'axios';

const BOTCAHX_KEY = 'GMauog6R';
const XV_API      = 'https://api.botcahx.eu.org/api/download/xvideosdl';
const VERIFY_TTL  = 2 * 60 * 1000; // 2 minutes to confirm

// Pending verification: jid → { url, timestamp }
const pendingVerification = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isXVideosUrl(url) {
  return /xvideos\.com\/video\d+/i.test(url || '');
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Called when user sends !xvdl <url>
 */
export async function handleAdultDl(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const url = (args || '').trim();

  if (!url) {
    await sock.sendMessage(jid, {
      text:
        `❌ *Usage:* !xvdl <xvideos link>\n\n` +
        `Example:\n` +
        `!xvdl https://www.xvideos.com/video12345/title_here`,
    }, { quoted: msg });
    return;
  }

  if (!isXVideosUrl(url)) {
    await sock.sendMessage(jid, {
      text: `❌ *Invalid URL.*\nOnly XVideos links are supported.\n\nExample: https://www.xvideos.com/video12345/...`,
    }, { quoted: msg });
    return;
  }

  pendingVerification.set(jid, { url, timestamp: Date.now() });

  await sock.sendMessage(jid, {
    text:
      `🔞 *Adult Content — Age Verification Required*\n\n` +
      `This content is intended for adults only.\n\n` +
      `> By replying *yes* you confirm that:\n` +
      `> • You are *18 years of age or older*\n` +
      `> • Viewing adult content is legal in your region\n\n` +
      `Reply *yes* to continue, or anything else to cancel.\n` +
      `_(This prompt expires in 2 minutes)_`,
  }, { quoted: msg });
}

/**
 * Called on EVERY incoming message to catch the "yes" reply.
 * Returns true if the message was consumed by this handler.
 */
export async function handleAdultVerify(sock, msg) {
  const jid  = msg.key.remoteJid;
  const text = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ''
  ).trim().toLowerCase();

  const state = pendingVerification.get(jid);
  if (!state) return false;

  // Expired
  if (Date.now() - state.timestamp > VERIFY_TTL) {
    pendingVerification.delete(jid);
    if (text === 'yes') {
      await sock.sendMessage(jid, {
        text: `⏰ *Verification expired.* Please send *!xvdl <url>* again.`,
      }, { quoted: msg });
    }
    return false;
  }

  if (text === 'yes') {
    pendingVerification.delete(jid);
    await downloadAndSend(sock, msg, jid, state.url);
    return true;
  }

  pendingVerification.delete(jid);
  await sock.sendMessage(jid, {
    text: `❌ *Cancelled.* Age verification was not confirmed.`,
  }, { quoted: msg });
  return true;
}

// ── Download & send ───────────────────────────────────────────────────────────

async function downloadAndSend(sock, msg, jid, videoUrl) {
  try {
    await sock.sendMessage(jid, { text: `⬇️ *Fetching video info...*` });

    const { data } = await axios.get(XV_API, {
      params: { url: videoUrl, apikey: BOTCAHX_KEY },
      timeout: 30_000,
    });

    if (!data?.status) throw new Error(data?.message || 'API returned an error.');
    const r = data.result;
    if (!r?.url) throw new Error('No download URL from API.');

    await sock.sendMessage(jid, {
      text: `📥 *Downloading:* ${r.title || 'Video'}\n_Please wait..._`,
    });

    const res = await axios.get(r.url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers: {
        'Referer':    'https://www.xvideos.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const buf    = Buffer.from(res.data);
    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);

    if (buf.length > 50 * 1024 * 1024) {
      await sock.sendMessage(jid, {
        text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is 50 MB. Try a shorter video.`,
      }, { quoted: msg });
      return;
    }

    let caption = `🔞 *${r.title || 'Video'}*\n📦 ${sizeMb} MB`;
    if (r.views)      caption += `  ·  👁️ ${r.views}`;
    if (r.like_count) caption += `\n👍 ${r.like_count} likes`;

    await sock.sendMessage(jid, {
      video:    buf,
      caption,
      mimetype: 'video/mp4',
    }, { quoted: msg });

  } catch (err) {
    console.error('[XV] error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Download failed.*\n_${err.message}_\n\nMake sure the URL is a valid XVideos video link.`,
    }, { quoted: msg });
  }
}
