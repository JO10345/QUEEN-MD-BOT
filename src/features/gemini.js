/**
 * Gemini commands
 *
 * Text:
 *   !gemini <question>
 *   !gimini <question>
 *
 * Images:
 *   !gemini image <description>
 *   !gemini create <description>
 *   !gemini edit <instruction>  (reply to a photo)
 */

import axios from 'axios';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { handleAI } from './ai.js';

const DAVID_IMAGE_URL = 'https://apis.davidcyriltech.my.id/ai/writecream/image';
const GOOGLE_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GOOGLE_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const silentLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => silentLogger,
};

function unwrapMessage(message) {
  return message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message?.documentWithCaptionMessage?.message ||
    message ||
    {};
}

function contextInfo(msg) {
  const inner = unwrapMessage(msg?.message);
  return inner.extendedTextMessage?.contextInfo ||
    inner.imageMessage?.contextInfo ||
    inner.videoMessage?.contextInfo ||
    {};
}

function findImageSource(msg) {
  const current = unwrapMessage(msg?.message);
  if (current.imageMessage) return { msg, media: current.imageMessage };

  const ctx = contextInfo(msg);
  const quoted = ctx.quotedMessage;
  const quotedInner = unwrapMessage(quoted);
  if (!quotedInner.imageMessage) return null;

  return {
    media: quotedInner.imageMessage,
    msg: {
      key: {
        remoteJid: ctx.remoteJid || msg.key?.remoteJid,
        id: ctx.stanzaId || msg.key?.id,
        participant: ctx.participant,
        fromMe: false,
      },
      message: quoted,
    },
  };
}

async function downloadImageSource(source) {
  if (!source) return null;
  const buffer = await downloadMediaMessage(source.msg, 'buffer', {}, { logger: silentLogger });
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
    throw new Error('The tagged photo could not be downloaded.');
  }
  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error('The photo is larger than Gemini’s 8 MB inline limit.');
  }
  return { buffer, mimeType: source.media?.mimetype || 'image/jpeg' };
}

function imagePartFromResponse(data) {
  const parts = data?.candidates?.flatMap(candidate => candidate?.content?.parts || []) || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      return {
        buffer: Buffer.from(inline.data, 'base64'),
        mimeType: inline.mimeType || inline.mime_type || 'image/png',
      };
    }
  }
  return null;
}

async function generateWithGemini(prompt, source = null) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const parts = [{ text: prompt }];
  if (source) {
    parts.push({ inlineData: { mimeType: source.mimeType, data: source.buffer.toString('base64') } });
  }

  const { data } = await axios.post(
    `${GOOGLE_GENERATE_URL}/${GOOGLE_IMAGE_MODEL}:generateContent`,
    { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'] } },
    { params: { key: apiKey }, timeout: 120_000, headers: { 'Content-Type': 'application/json' } },
  );

  const image = imagePartFromResponse(data);
  if (!image?.buffer?.length) throw new Error('Gemini returned no edited image.');
  return image;
}

async function generateWithDavid(prompt) {
  const { data } = await axios.get(DAVID_IMAGE_URL, {
    params: { prompt, ratio: process.env.GEMINI_IMAGE_RATIO || '1:1' },
    timeout: 90_000,
    headers: { 'User-Agent': 'Queen-MD-Bot/3.2' },
  });
  if (data?.success === false || !data?.image_url) {
    throw new Error(data?.message || 'David image service returned no image.');
  }
  const image = await axios.get(data.image_url, {
    responseType: 'arraybuffer',
    timeout: 90_000,
    maxContentLength: 12 * 1024 * 1024,
  });
  const buffer = Buffer.from(image.data);
  if (buffer.length < 1000) throw new Error('Image service returned an empty image.');
  return { buffer, mimeType: image.headers['content-type'] || 'image/jpeg' };
}

async function handleGeminiImage(sock, msg, action, prompt) {
  const jid = msg.key.remoteJid;
  const source = action === 'edit' ? findImageSource(msg) : null;

  if (action === 'edit' && !source) {
    await sock.sendMessage(jid, {
      text: `🖼️ *How to edit a photo:*\nReply to a photo with *!gemini edit <instruction>*.\n\nExample: *!gemini edit make the background a sunset*`,
    }, { quoted: msg });
    return;
  }
  if (!prompt || prompt.trim().length < 3) {
    await sock.sendMessage(jid, { text: `❌ Usage: *!gemini ${action} <description/instruction>*` }, { quoted: msg });
    return;
  }

  const hasGeminiKey = Boolean((process.env.GEMINI_API_KEY || '').trim());
  if (action === 'edit' && !hasGeminiKey) {
    await sock.sendMessage(jid, {
      text: `⚠️ *Gemini photo editing is not configured yet.*\n\nAdd *GEMINI_API_KEY* to the bot's environment, then reply to a photo with:\n*!gemini edit <instruction>*\n\nText AI and new image creation do not require this key.`,
    }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, {
    text: action === 'edit' ? `🖌️ *Editing your photo with Gemini...*\n_Please wait..._` : `🎨 *Creating your image...*\n_Please wait..._`,
  }, { quoted: msg });

  try {
    const imageSource = source ? await downloadImageSource(source) : null;
    const result = hasGeminiKey
      ? await generateWithGemini(prompt.trim(), imageSource)
      : await generateWithDavid(prompt.trim());

    await sock.sendMessage(jid, {
      image: result.buffer,
      caption: action === 'edit' ? `🖌️ *Gemini photo edit*\n_${prompt.trim()}_` : `🎨 *AI image*\n_${prompt.trim()}_`,
      mimetype: result.mimeType,
    }, { quoted: msg });
  } catch (error) {
    console.error('[GEMINI IMAGE] error:', error.message);
    await sock.sendMessage(jid, { text: `❌ *Image request failed.*\n_${error.message}_` }, { quoted: msg });
  }
}

export async function handleGemini(sock, msg, text) {
  const input = (text || '').trim();
  const match = input.match(/^([a-z-]+)\s*(?:[:|-]\s*|\s+)?([\s\S]*)$/i);
  const action = match?.[1]?.toLowerCase() || '';
  const rest = (match?.[2] || '').trim();

  if (['image', 'create', 'generate', 'edit'].includes(action)) {
    return handleGeminiImage(sock, msg, action === 'generate' ? 'create' : action, rest);
  }
  return handleAI(sock, msg, input);
}