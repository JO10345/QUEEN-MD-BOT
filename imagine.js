/**
 * !imagine — AI image generation
 *
 * Primary:  Pollinations.ai (FREE, no API key required)
 * Fallback: OpenAI DALL-E 3 (only if IMAGINE_PROVIDER=openai and key is set)
 */

import axios from 'axios';

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

export async function handleImagine(sock, msg, prompt) {
  const jid = msg.key.remoteJid;

  if (!prompt || prompt.trim().length < 3) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:* !imagine <description>\n\nExamples:\n  !imagine a sunset over Lagos\n  !imagine a robot cooking jollof rice`,
    }, { quoted: msg });
    return;
  }

  const provider = (process.env.IMAGINE_PROVIDER || 'pollinations').toLowerCase();

  try {
    await sock.sendMessage(jid, {
      text: `🎨 Generating image for: _"${prompt.trim()}"_\nThis takes a few seconds...`,
    });

    try {
      await sock.sendMessage(jid, { react: { text: '🖌️', key: msg.key } });
    } catch {}

    let imgBuffer;

    if (provider === 'openai') {
      imgBuffer = await generateWithOpenAI(prompt);
    } else {
      imgBuffer = await generateWithPollinations(prompt);
    }

    await sock.sendMessage(jid, {
      image:   imgBuffer,
      caption: `🎨 *AI Image*\n_"${prompt.trim()}"_`,
    }, { quoted: msg });

  } catch (err) {
    console.error('Imagine error:', err.message);

    let errMsg = `❌ Could not generate image.\n`;
    if (err.message?.includes('content policy')) {
      errMsg += `Your prompt was rejected by the content filter. Try a different description.`;
    } else if (err.message?.includes('billing') || err.message?.includes('quota')) {
      errMsg += `API quota issue — please try again later.`;
    } else {
      errMsg += `Reason: ${err.message}\n\nPlease try again or use a simpler prompt.`;
    }
    await sock.sendMessage(jid, { text: errMsg });
  }
}

// ─── Pollinations (free, no key) ───────────────────────────────────────────────
async function generateWithPollinations(prompt) {
  const seed   = Math.floor(Math.random() * 1_000_000);
  const model  = process.env.POLLINATIONS_MODEL || 'flux';
  const width  = parseInt(process.env.POLLINATIONS_WIDTH  || '1024');
  const height = parseInt(process.env.POLLINATIONS_HEIGHT || '1024');

  const url =
    `${POLLINATIONS_BASE}/${encodeURIComponent(prompt.trim())}` +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=${model}`;

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout:      120_000,
    maxRedirects: 5,
  });

  const buf = Buffer.from(res.data);
  if (buf.length < 1000) throw new Error('Empty image returned from Pollinations');
  return buf;
}

// ─── OpenAI DALL-E 3 (paid fallback) ──────────────────────────────────────────
async function generateWithOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    throw new Error('OPENAI_API_KEY not set');
  }

  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey });

  const response = await openai.images.generate({
    model:           'dall-e-3',
    prompt:          prompt,
    n:               1,
    size:            '1024x1024',
    quality:         'standard',
    response_format: 'url',
  });

  const imageUrl = response.data[0]?.url;
  if (!imageUrl) throw new Error('No image URL returned from OpenAI');

  const imgRes = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout:      60_000,
  });
  return Buffer.from(imgRes.data);
}
