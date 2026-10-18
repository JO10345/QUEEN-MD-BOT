/**
 * Facebook Video Downloader
 *
 * Uses Botcahx first when BOTCAHX_API_KEY is configured, then GTech and
 * David Cyril fallbacks. Provider response formats are normalized below.
 *
 * Response: { success: true, source, total, results: [{ quality, url }] }
 *
 * Commands:
 *   !fbdl <facebook link>  — fetch quality options
 *   !fbdl 1,2,3...         — download selected quality
 */

import axios from 'axios';

const FB_URL_RE = /facebook\.com\/(watch|video|reel|share)|fb\.watch/i;
const FB_APIS = [
  {
    name: 'botcahx',
    url: 'https://api.botcahx.eu.org/api/dowloader/fbdown',
    enabled: Boolean(process.env.BOTCAHX_API_KEY),
    params: url => ({ url, apikey: process.env.BOTCAHX_API_KEY }),
  },
  {
    name: 'gtech',
    url: 'https://gtech-api-xtp1.onrender.com/api/download/fb',
    enabled: true,
    params: url => ({ url, apikey: process.env.GTECH_FB_API_KEY || 'APIKEY' }),
  },
  {
    name: 'davidcyril',
    url: 'https://apis.davidcyriltech.my.id/facebook3',
    enabled: true,
    params: url => ({ url }),
  },
];

// Per-chat pending: jid → { title, options: [{ quality, url }] }
const pending = new Map();

function isFacebookUrl(url) { return FB_URL_RE.test(url || ''); }

function normalizeFacebookResponse(data) {
  if (data?.success === false || data?.status === false || data?.data?.status === false) {
    throw new Error(data?.message || data?.error || 'Provider returned an error.');
  }

  const title =
    data?.result?.url?.title ||
    data?.result?.title ||
    data?.data?.title ||
    data?.title ||
    'Facebook Video';

  const resultUrls = data?.result?.url?.urls;
  if (Array.isArray(resultUrls)) {
    const options = [];
    for (const item of resultUrls) {
      if (item?.hd) options.push({ quality: 'HD', url: item.hd });
      if (item?.sd) options.push({ quality: 'SD', url: item.sd });
    }
    if (options.length) return { title, options };
  }

  const rawResults =
    data?.data?.data ||
    data?.results ||
    data?.result ||
    data?.data ||
    [];
  const rows = Array.isArray(rawResults)
    ? rawResults
    : Object.entries(rawResults || {}).map(([quality, value]) => ({
      quality,
      url: typeof value === 'string' ? value : value?.url || value?.download || value?.download_url,
    }));

  const options = rows.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const links = [item.url, item.download, item.download_url, item.hd, item.sd].filter(
      value => typeof value === 'string' && /^https?:\/\//i.test(value),
    );
    return links.map((url, index) => ({
      quality: item.resolution || item.quality ||
        (url === item.hd ? 'HD' : url === item.sd ? 'SD' : `Option ${index + 1}`),
      url,
    }));
  });

  if (!options.length) throw new Error('Provider returned no usable download URLs.');
  return { title, options };
}

async function fetchFacebookOptions(input) {
  let lastError;
  for (const api of FB_APIS) {
    if (!api.enabled) continue;
    try {
      const { data } = await axios.get(api.url, {
        params: api.params(input),
        timeout: 35_000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const normalized = normalizeFacebookResponse(data);
      console.log(`[FB] Using ${api.name} provider (${normalized.options.length} options)`);
      return normalized;
    } catch (error) {
      console.warn(`[FB] ${api.name} provider failed: ${error.message}`);
      lastError = error;
    }
  }
  throw lastError || new Error('No Facebook download provider is enabled.');
}

export async function handleFbDl(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const input = (args || '').trim();

  // ── Quality selection (number input) ────────────────────────────────────────
  const numInput = parseInt(input, 10);
  if (!isNaN(numInput) && numInput >= 1) {
    const state = pending.get(jid);
    if (!state) {
      return sock.sendMessage(jid, {
        text: `❌ No pending download. Send *!fbdl <facebook link>* first.`,
      }, { quoted: msg });
    }

    const option = state.options[numInput - 1];
    if (!option) {
      return sock.sendMessage(jid, {
        text: `❌ Invalid option. Choose 1 to ${state.options.length}.`,
      }, { quoted: msg });
    }

    try {
      await sock.sendMessage(jid, {
        text: `⬇️ *Downloading* — ${option.quality}\n_Please wait..._`,
      });

      let res;
      let lastDownloadError;
      for (const downloadUrl of option.urls || [option.url]) {
        try {
          res = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            timeout: 120_000,
            maxContentLength: 150 * 1024 * 1024,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.facebook.com/',
            },
          });
          const candidate = Buffer.from(res.data);
          const head = candidate.slice(0, 300).toString('utf8').trimStart().toLowerCase();
          if (candidate.length < 10_000 || head.startsWith('<html') ||
              head.startsWith('<!doctype') || head.startsWith('{')) {
            throw new Error('CDN returned an error page instead of video data.');
          }
          break;
        } catch (error) {
          lastDownloadError = error;
          res = null;
        }
      }
      if (!res) throw lastDownloadError || new Error('Every download URL failed.');
      const buf    = Buffer.from(res.data);
      const sizeMb = (buf.length / 1024 / 1024).toFixed(1);

      if (buf.length > 50 * 1024 * 1024) {
        return sock.sendMessage(jid, {
          text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is ~50 MB. Try a lower quality.`,
        }, { quoted: msg });
      }

      pending.delete(jid);

      const contentType = res.headers['content-type'] || 'video/mp4';
      const isVideo = contentType.includes('video');
      const isAudio = contentType.includes('audio');

      if (isVideo || (!isAudio && buf.length > 1024)) {
        await sock.sendMessage(jid, {
          video:    buf,
          caption:  `📘 *${state.title}*\n📺 ${option.quality}  ·  📦 ${sizeMb} MB`,
          mimetype: 'video/mp4',
        }, { quoted: msg });
      } else {
        await sock.sendMessage(jid, {
          audio:    buf,
          mimetype: 'audio/mp4',
        }, { quoted: msg });
        await sock.sendMessage(jid, { text: `📘 *${state.title}*\n🎵 ${option.quality}` });
      }

    } catch (err) {
      console.error('[FB] download error:', err.message);
      await sock.sendMessage(jid, {
        text: `❌ *Download failed.*\n_${err.message}_\n\nTry another quality option.`,
      }, { quoted: msg });
    }
    return;
  }

  // ── New URL ──────────────────────────────────────────────────────────────────
  if (!input) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:*\n` +
        `• *!fbdl <facebook link>* — fetch options\n` +
        `• *!fbdl 1* — download first quality\n` +
        `• *!fbdl 2* — download second quality\n\n` +
        `Supported: facebook.com/watch · /video · /reel · /share · fb.watch`,
    }, { quoted: msg });
  }

  if (!isFacebookUrl(input)) {
    return sock.sendMessage(jid, {
      text: `❌ *Invalid URL.* Please send a Facebook video or reel link.`,
    }, { quoted: msg });
  }

  try {
    await sock.sendMessage(jid, { text: `🔍 *Fetching Facebook video info...*` });

    const { title, options } = await fetchFacebookOptions(input);
    pending.set(jid, { title, options });

    let menu = `📘 *${title}*\n━━━━━━━━━━━━━━━━━━━━\n📥 *Choose quality:*\n\n`;
    options.forEach((r, i) => {
      menu += `  *${i + 1}.* ${r.quality || `Option ${i + 1}`}\n`;
    });
    menu += `\n_Reply: !fbdl 1, !fbdl 2, etc._`;

    await sock.sendMessage(jid, { text: menu }, { quoted: msg });

  } catch (err) {
    console.error('[FB] info error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Couldn't fetch video info.*\n_${err.message}_\n\nMake sure the video is public.`,
    }, { quoted: msg });
  }
}
