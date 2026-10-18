/**
 * Text-to-Image (Text Pro effects)
 *
 * APIs:
 *   Sky Text:    https://api.botcahx.eu.org/api/textpro/sky-text?text=<text>&apikey=GMauog6R
 *   Water Color: https://api.botcahx.eu.org/api/textpro/water-color?text=<text>&apikey=GMauog6R
 *
 * The API returns the image binary directly (not JSON with a URL).
 *
 * Command:
 *   !tximg sky <text>    — sky text effect
 *   !tximg water <text>  — water colour effect
 *   !tximg <text>        — default sky effect
 */

import axios from 'axios';

const BOTCAHX_KEY = 'GMauog6R';
const API_BASE    = 'https://api.botcahx.eu.org/api/textpro';

const STYLES = {
  sky:   { endpoint: 'sky-text',    label: '☁️ Sky Text' },
  water: { endpoint: 'water-color', label: '🎨 Water Colour' },
  wc:    { endpoint: 'water-color', label: '🎨 Water Colour' },
};

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://api.botcahx.eu.org/',
};

export async function handleTextImg(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const input = (args || '').trim();

  if (!input) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:*\n` +
        `  !tximg sky <text>    — ☁️ Sky text effect\n` +
        `  !tximg water <text>  — 🎨 Water colour effect\n` +
        `  !tximg <text>        — Default (sky)\n\n` +
        `Example: !tximg sky Queen MD`,
    }, { quoted: msg });
  }

  const parts    = input.split(/\s+/);
  const styleKey = STYLES[parts[0].toLowerCase()] ? parts[0].toLowerCase() : null;
  const style    = styleKey ? STYLES[styleKey] : STYLES.sky;
  const text     = styleKey ? parts.slice(1).join(' ') : input;

  if (!text.trim()) {
    return sock.sendMessage(jid, {
      text: `❌ Please provide text.\nExample: !tximg sky Queen MD`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, {
    text: `🖼️ *Generating ${style.label}...*`,
  }, { quoted: msg });

  try {
    const url = `${API_BASE}/${style.endpoint}`;

    // The API returns image binary directly — use arraybuffer
    const response = await axios.get(url, {
      params:       { text: text.trim(), apikey: BOTCAHX_KEY },
      headers:      BROWSER_HEADERS,
      responseType: 'arraybuffer',
      timeout:      30_000,
    });

    const contentType = response.headers['content-type'] || '';
    let buffer;

    if (contentType.includes('image')) {
      // Direct image binary response
      buffer = Buffer.from(response.data);
    } else {
      // Maybe JSON with a URL
      try {
        const json     = JSON.parse(Buffer.from(response.data).toString('utf-8'));
        const imageUrl = json.result || json.url || json.image || json.data?.url || null;

        if (!imageUrl) throw new Error(json.message || 'No image URL in response');

        const imgRes = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          headers:      BROWSER_HEADERS,
          timeout:      30_000,
        });
        buffer = Buffer.from(imgRes.data);
      } catch {
        throw new Error(`Unexpected response (${contentType})`);
      }
    }

    if (!buffer || buffer.length < 100) {
      throw new Error('Empty image received from API');
    }

    await sock.sendMessage(jid, {
      image:   buffer,
      caption: `${style.label}\n✏️ *${text}*`,
    }, { quoted: msg });

  } catch (err) {
    console.error('[TXIMG] error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Text image failed.*\n_${err.message}_\n\nThe text-image API may be temporarily unavailable.`,
    }, { quoted: msg });
  }
}
