/**
 * !imagine — AI Image Generation
 *
 * Provider 1 (default): ZonerAI by EliteProtech
 *   https://eliteprotech-apis.zone.id/zonerai?prompt=
 *   Returns raw JPEG binary directly — no API key needed.
 *
 * Provider 2 (fallback): Pollinations.ai (FREE, no key)
 *   https://image.pollinations.ai/prompt/<prompt>
 *
 * Provider 3 (optional): OpenAI DALL-E 3
 *   Set IMAGINE_PROVIDER=openai and OPENAI_API_KEY in .env
 *
 * Usage:
 *   !imagine <description>
 *   !gen <description>
 *
 * Switch provider via .env:
 *   IMAGINE_PROVIDER=zonerai     ← default
 *   IMAGINE_PROVIDER=pollinations
 *   IMAGINE_PROVIDER=openai
 */

import axios from 'axios';

const ZONERAI_URL       = 'https://eliteprotech-apis.zone.id/zonerai';
const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

export async function handleImagine(sock, msg, prompt) {
  const jid = msg.key.remoteJid;

  if (!prompt || prompt.trim().length < 3) {
    await sock.sendMessage(jid, {
      text:
        `❌ *Usage:* !imagine <description>\n\n` +
        `🎨 *Examples:*\n` +
        `  • !imagine a sunset over Lagos\n` +
        `  • !imagine a robot cooking jollof rice\n` +
        `  • !imagine futuristic city at night, neon lights\n` +
        `  • !imagine cute anime girl with blue eyes`,
    }, { quoted: msg });
    return;
  }

  const provider = (process.env.IMAGINE_PROVIDER || 'zonerai').toLowerCase();
  const cleanPrompt = prompt.trim();

  try {
    await sock.sendMessage(jid, {
      text: `🎨 *Generating image...*\n📝 _${cleanPrompt}_\n\n_Please wait..._`,
    });

    try { await sock.sendMessage(jid, { react: { text: '🖌️', key: msg.key } }); } catch {}

    let imgBuffer;

    if (provider === 'openai') {
      imgBuffer = await generateWithOpenAI(cleanPrompt);
    } else if (provider === 'pollinations') {
      imgBuffer = await generateWithPollinations(cleanPrompt);
    } else {
      // ZonerAI primary, Pollinations fallback
      try {
        imgBuffer = await generateWithZonerAI(cleanPrompt);
      } catch (e) {
        console.warn('[IMAGINE] ZonerAI failed, trying Pollinations:', e.message);
        imgBuffer = await generateWithPollinations(cleanPrompt);
      }
    }

    await sock.sendMessage(jid, {
      image:   imgBuffer,
      caption: `🎨 *AI Image*\n_"${cleanPrompt.slice(0, 100)}${cleanPrompt.length > 100 ? '...' : ''}"_`,
    }, { quoted: msg });

  } catch (err) {
    console.error('[IMAGINE] error:', err.message);

    let errMsg = `❌ *Could not generate image.*\n`;
    if (err.message?.includes('content policy')) {
      errMsg += `Your prompt was rejected by the content filter. Try a different description.`;
    } else if (err.message?.includes('billing') || err.message?.includes('quota')) {
      errMsg += `API quota issue — please try again later.`;
    } else {
      errMsg += `_${err.message}_\n\nPlease try again or use a simpler prompt.`;
    }
    await sock.sendMessage(jid, { text: errMsg }, { quoted: msg });
  }
}

// ── ZonerAI (EliteProtech) — returns raw JPEG ─────────────────────────────────

async function generateWithZonerAI(prompt) {
  const res = await axios.get(ZONERAI_URL, {
    params: { prompt },
    responseType: 'arraybuffer',
    timeout: 60_000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' },
  });

  const buf = Buffer.from(res.data);
  const magic = buf.slice(0, 4).toString('hex');
  const isImage = magic.startsWith('ffd8') || magic.startsWith('8950') || magic.startsWith('4749');

  if (!isImage || buf.length < 1000) {
    const text = buf.toString('utf-8');
    let errMsg = 'ZonerAI returned an invalid image.';
    try { errMsg = JSON.parse(text)?.message || errMsg; } catch {}
    throw new Error(errMsg);
  }

  return buf;
}

// ── Pollinations.ai (free fallback) ──────────────────────────────────────────

async function generateWithPollinations(prompt) {
  const seed   = Math.floor(Math.random() * 1_000_000);
  const model  = process.env.POLLINATIONS_MODEL  || 'flux';
  const width  = parseInt(process.env.POLLINATIONS_WIDTH  || '1024');
  const height = parseInt(process.env.POLLINATIONS_HEIGHT || '1024');

  const url =
    `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=${model}`;

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout:      120_000,
    maxRedirects: 5,
  });

  const buf = Buffer.from(res.data);
  if (buf.length < 1000) throw new Error('Empty image returned from Pollinations.');
  return buf;
}

// ── OpenAI DALL-E 3 (optional) ────────────────────────────────────────────────

async function generateWithOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    throw new Error('OPENAI_API_KEY not set in .env');
  }

  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });

  const response = await openai.images.generate({
    model:           'dall-e-3',
    prompt,
    n:               1,
    size:            '1024x1024',
    quality:         'standard',
    response_format: 'url',
  });

  const imageUrl = response.data[0]?.url;
  if (!imageUrl) throw new Error('No image URL returned from OpenAI.');

  const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60_000 });
  return Buffer.from(imgRes.data);
}
