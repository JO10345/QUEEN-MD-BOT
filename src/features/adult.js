/**
 * Adult Features (18+)
 *
 * Commands:
 *   !xvsearch <query>  — search XVideos, then pick a number to download
 *   !xvdl <num>        — download from last xvsearch results
 *   !xvdl <xv url>     — download directly by URL
 *   !xns <query>       — search XNXX, then pick a number to download
 *   !xnsdl <num>       — download from last xns results
 *
 * APIs (botcahx.eu.org):
 *   XV Search:   /api/search/xvideos?query=&apikey=
 *   XV Download: /api/download/xvideosdl?url=&apikey=
 *   XNXX Search: /api/search/xnxx?query=&apikey=
 */

import axios from 'axios';

const BOTCAHX_KEY   = 'GMauog6R';
const BASE          = 'https://api.botcahx.eu.org';
const XV_DL_API     = `${BASE}/api/download/xvideosdl`;
const XV_SEARCH_API = `${BASE}/api/search/xvideos`;
const XNXX_API      = `${BASE}/api/search/xnxx`;
const XNXX_DL_API   = `${BASE}/api/download/xnxxdl`;

// Full browser headers to pass 403 guards
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         `${BASE}/`,
  'Origin':          BASE,
  'sec-ch-ua':       '"Chromium";v="124", "Google Chrome";v="124"',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-origin',
};

const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer':    'https://www.xvideos.com/',
};

// Per-chat search result cache
const xvLastSearch   = new Map(); // jid → [{ title, duration, url }]
const xnxxLastSearch = new Map(); // jid → [{ title, duration, url }]

function isXVideosUrl(url) {
  return /xvideos\.com\//i.test(url || '');
}

// ── Core download worker (used by both !xvdl URL and !xvdl number) ─────────────

async function downloadAndSend(sock, msg, pageUrl, label) {
  const jid = msg.key.remoteJid;

  await sock.sendMessage(jid, { text: `🔞 ⬇️ *Fetching download link...*\n_${label}_` }, { quoted: msg });

  let directUrl, title, views, likes;
  try {
    const { data } = await axios.get(XV_DL_API, {
      params:  { url: pageUrl, apikey: BOTCAHX_KEY },
      headers: HEADERS,
      timeout: 30_000,
    });

    if (!data?.status) throw new Error(data?.message || 'API returned an error.');
    const r = data.result || data;
    directUrl = r?.url       || r?.downloadUrl || r?.link || null;
    title     = r?.title     || label;
    views     = r?.views     || '';
    likes     = r?.like_count || '';

    if (!directUrl) throw new Error('No download URL returned by API.');
  } catch (err) {
    console.error('[XV-DL] info error:', err.message);
    const is403 = err.response?.status === 403 || String(err.message).includes('403');
    return sock.sendMessage(jid, {
      text:
        `❌ *Could not get download link.*\n_${err.message}_\n\n` +
        (is403 ? `⚠️ Adult download API is temporarily blocked.\nTry again in a few minutes.` : ''),
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, { text: `📥 *Downloading:* _${title}_\n_Please wait..._` });

  try {
    const res = await axios.get(directUrl, {
      responseType: 'arraybuffer',
      timeout:      120_000,
      headers:      DOWNLOAD_HEADERS,
    });

    const buf    = Buffer.from(res.data);
    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);

    if (buf.length > 50 * 1024 * 1024) {
      return sock.sendMessage(jid, {
        text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is ~50 MB.\nTry a shorter video.`,
      }, { quoted: msg });
    }

    let caption = `🔞 *${title}*\n📦 ${sizeMb} MB`;
    if (views) caption += `  ·  👁️ ${views}`;
    if (likes) caption += `\n👍 ${likes} likes`;

    await sock.sendMessage(jid, { video: buf, caption, mimetype: 'video/mp4' }, { quoted: msg });

  } catch (err) {
    console.error('[XV-DL] download error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Download failed.*\n_${err.message}_`,
    }, { quoted: msg });
  }
}

// ── !xvsearch — search XVideos, show numbered list ──────────────────────────

export async function handleXvSearch(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const query = (args || '').trim();

  if (!query) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:* !xvsearch <term>\n\n` +
        `Example: !xvsearch japanese\n\n` +
        `After results appear, type *!xvdl <number>* to download.`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, { text: `🔞 🔍 *Searching XVideos:* _${query}_...` }, { quoted: msg });

  try {
    const { data } = await axios.get(XV_SEARCH_API, {
      params:  { query, apikey: BOTCAHX_KEY },
      headers: HEADERS,
      timeout: 20_000,
    });

    if (!data?.status) throw new Error(data?.message || 'API error.');
    const results = Array.isArray(data.result) ? data.result : [];
    if (!results.length) {
      return sock.sendMessage(jid, { text: `❌ No results for: *${query}*` }, { quoted: msg });
    }

    const top = results.slice(0, 8);

    // Cache for !xvdl <num>
    xvLastSearch.set(jid, top.map(v => ({
      title:    v.title    || 'Untitled',
      duration: v.duration || '',
      url:      v.url      || '',
    })));

    let text = `🔞 *XVideos Search Results*\nQuery: _${query}_\n\n`;
    top.forEach((v, i) => {
      const title    = v.title    || 'Untitled';
      const duration = v.duration || '';
      text += `*${i + 1}.* ${title}\n`;
      if (duration) text += `   ⏱️ ${duration}\n`;
      text += `\n`;
    });
    text += `📥 *To download, type:* !xvdl <number>\nExample: !xvdl 1`;

    await sock.sendMessage(jid, { text }, { quoted: msg });

  } catch (err) {
    console.error('[XV-SEARCH] error:', err.message);
    const is403 = err.response?.status === 403 || String(err.message).includes('403');
    await sock.sendMessage(jid, {
      text:
        `❌ *Search failed.*\n_${err.message}_\n\n` +
        (is403 ? `⚠️ Adult search API is temporarily unavailable. Try again later.` : ''),
    }, { quoted: msg });
  }
}

// ── !xvdl — download by number (from search) or by direct URL ────────────────

export async function handleAdultDl(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const input = (args || '').trim();

  if (!input) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:*\n` +
        `  !xvdl <number>   — download from last search\n` +
        `  !xvdl <xv url>   — download directly by URL\n\n` +
        `Search first: !xvsearch <term>`,
    }, { quoted: msg });
  }

  // Number → download from last search
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1) {
    const results = xvLastSearch.get(jid);
    if (!results?.length) {
      return sock.sendMessage(jid, {
        text: `❌ No recent search. Use *!xvsearch <term>* first.`,
      }, { quoted: msg });
    }
    const item = results[num - 1];
    if (!item) {
      return sock.sendMessage(jid, {
        text: `❌ Invalid number. Pick 1 to ${results.length}.`,
      }, { quoted: msg });
    }
    if (!item.url) {
      return sock.sendMessage(jid, { text: `❌ No URL for that result.` }, { quoted: msg });
    }
    return downloadAndSend(sock, msg, item.url, item.title);
  }

  // URL → direct download
  if (!isXVideosUrl(input)) {
    return sock.sendMessage(jid, {
      text: `❌ *Invalid input.*\nProvide a number from search results, or a valid XVideos URL.`,
    }, { quoted: msg });
  }

  return downloadAndSend(sock, msg, input, 'XVideos Video');
}

// ── !xns — search XNXX, show numbered list ───────────────────────────────────

export async function handleXnxxSearch(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const query = (args || '').trim();

  if (!query) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:* !xns <term>\n\n` +
        `Example: !xns japanese\n\n` +
        `After results appear, type *!xnsdl <number>* to download.`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, { text: `🔞 🔍 *Searching XNXX:* _${query}_...` }, { quoted: msg });

  try {
    const { data } = await axios.get(XNXX_API, {
      params:  { query, apikey: BOTCAHX_KEY },
      headers: HEADERS,
      timeout: 20_000,
    });

    if (!data?.status) throw new Error(data?.message || 'API error.');

    const results = Array.isArray(data.result)   ? data.result
                  : Array.isArray(data.results)  ? data.results
                  : Array.isArray(data.data)     ? data.data
                  : [];

    if (!results.length) {
      return sock.sendMessage(jid, { text: `❌ No results for: *${query}*` }, { quoted: msg });
    }

    const top = results.slice(0, 8);

    // Cache for !xnsdl <num>
    xnxxLastSearch.set(jid, top.map(v => ({
      title:    v.title    || v.name || v.t || 'Untitled',
      duration: v.duration || v.d   || '',
      views:    v.views    || v.nb_view || v.v || '',
      url:      v.url      || v.link || v.u || '',
    })));

    let text = `🔞 *XNXX Search Results*\nQuery: _${query}_\n\n`;
    top.forEach((v, i) => {
      const title    = v.title    || v.name || v.t || 'Untitled';
      const duration = v.duration || v.d   || '';
      const views    = v.views    || v.nb_view || v.v || '';
      const rating   = v.rating   || v.r   || '';
      text += `*${i + 1}.* ${title}\n`;
      if (duration) text += `   ⏱️ ${duration}`;
      if (views)    text += `  👁️ ${views}`;
      if (rating)   text += `  ⭐ ${rating}`;
      text += `\n\n`;
    });
    text += `📥 *To download, type:* !xnsdl <number>\nExample: !xnsdl 1`;

    await sock.sendMessage(jid, { text }, { quoted: msg });

  } catch (err) {
    console.error('[XNXX-SEARCH] error:', err.message);
    const is403 = err.response?.status === 403 || String(err.message).includes('403');
    await sock.sendMessage(jid, {
      text:
        `❌ *XNXX search failed.*\n_${err.message}_\n\n` +
        (is403 ? `⚠️ Adult search API is temporarily unavailable. Try again later.` : ''),
    }, { quoted: msg });
  }
}

// ── !xnsdl — download from XNXX search results ───────────────────────────────

export async function handleXnxxDl(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const input = (args || '').trim();
  const num   = parseInt(input, 10);

  if (!num || num < 1) {
    return sock.sendMessage(jid, {
      text: `❌ *Usage:* !xnsdl <number>\n\nSearch first: !xns <term>`,
    }, { quoted: msg });
  }

  const results = xnxxLastSearch.get(jid);
  if (!results?.length) {
    return sock.sendMessage(jid, {
      text: `❌ No recent XNXX search. Use *!xns <term>* first.`,
    }, { quoted: msg });
  }

  const item = results[num - 1];
  if (!item) {
    return sock.sendMessage(jid, {
      text: `❌ Invalid number. Pick 1 to ${results.length}.`,
    }, { quoted: msg });
  }

  if (!item.url) {
    return sock.sendMessage(jid, { text: `❌ No URL available for that result.` }, { quoted: msg });
  }

  await downloadXnxxAndSend(sock, msg, item.url, item.title);
}

async function downloadXnxxAndSend(sock, msg, pageUrl, label) {
  const jid = msg.key.remoteJid;
  await sock.sendMessage(jid, {
    text: `🔞 ⬇️ *Fetching XNXX download link...*\n_${label}_`,
  }, { quoted: msg });

  try {
    const { data } = await axios.get(XNXX_DL_API, {
      params: { url: pageUrl, apikey: BOTCAHX_KEY },
      headers: HEADERS,
      timeout: 30_000,
    });
    if (!data?.status) throw new Error(data?.message || 'XNXX API returned an error.');
    const result = data.result || data.data || data;
    const directUrl = result?.url || result?.downloadUrl || result?.download_url || result?.url_low;
    if (!directUrl) throw new Error('XNXX API returned no video URL.');

    await sock.sendMessage(jid, {
      text: `📥 *Downloading:* _${result.title || label}_\n_Please wait..._`,
    });
    const response = await axios.get(directUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      headers: DOWNLOAD_HEADERS,
    });
    const buffer = Buffer.from(response.data);
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
    await sock.sendMessage(jid, {
      video: buffer,
      caption: `🔞 *${result.title || label}*\n📦 ${sizeMb} MB\n🎞️ ${result.quality || ''}`,
      mimetype: 'video/mp4',
    }, { quoted: msg });
  } catch (error) {
    console.error('[XNXX-DL] error:', error.message);
    await sock.sendMessage(jid, {
      text: `❌ *XNXX download failed.*\n_${error.message}_`,
    }, { quoted: msg });
  }
}
