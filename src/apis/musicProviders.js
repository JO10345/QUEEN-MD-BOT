/**
 * ╔══════════════════════════════════════════════════════╗
 * ║          Queen MD Bot — Music Provider System        ║
 * ╠══════════════════════════════════════════════════════╣
 * ║  Add or swap providers easily in your .env file:     ║
 * ║  MUSIC_PROVIDERS=ytdl,cobalt,custom                  ║
 * ║                                                      ║
 * ║  Built-in providers:                                 ║
 * ║    ytdl    — ytdl-core (default, no API key)         ║
 * ║    cobalt  — cobalt.tools (free, no API key)         ║
 * ║    custom  — your own API (set MUSIC_API_URL)        ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * To add a NEW provider:
 *  1. Create a function below following the same signature:
 *     async function myProvider(videoUrl) → returns Buffer
 *  2. Register it in the PROVIDERS map at the bottom
 *  3. Add its name to MUSIC_PROVIDERS in your .env
 */

import ytdl from '@distube/ytdl-core';
import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ─── Provider 1: ytdl-core ────────────────────────────────────────────────────
// Uses ytdl-core to extract the audio URL, then downloads via axios.
// Works most of the time. May fail if YouTube blocks requests.
async function providerYtdl(videoUrl) {
  const info   = await ytdl.getInfo(videoUrl);
  const format = ytdl.chooseFormat(info.formats, {
    filter:  'audioonly',
    quality: 'highestaudio',
  });
  if (!format?.url) throw new Error('[ytdl] No audio format found');

  const res = await axios.get(format.url, {
    responseType: 'arraybuffer',
    timeout: 90_000,
    headers: { 'User-Agent': UA },
  });
  const buf = Buffer.from(res.data);
  if (buf.length < 5000) throw new Error('[ytdl] Downloaded file too small');
  return buf;
}

// ─── Provider 2: cobalt.tools ─────────────────────────────────────────────────
// Free public API, no key required. Good fallback when ytdl is blocked.
// Docs: https://cobalt.tools
async function providerCobalt(videoUrl) {
  const apiUrl = process.env.COBALT_API_URL || 'https://api.cobalt.tools/';

  const res = await axios.post(
    apiUrl,
    { url: videoUrl, downloadMode: 'audio', audioFormat: 'mp3' },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'User-Agent':   UA,
      },
      timeout: 30_000,
    }
  );

  const { status, url } = res.data;
  if (!url || (status !== 'stream' && status !== 'redirect' && status !== 'tunnel')) {
    throw new Error(`[cobalt] Unexpected status: ${status}`);
  }

  const audioRes = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 90_000,
    headers: { 'User-Agent': UA },
  });
  const buf = Buffer.from(audioRes.data);
  if (buf.length < 5000) throw new Error('[cobalt] Downloaded file too small');
  return buf;
}

// ─── Provider 3: Custom API ───────────────────────────────────────────────────
// Point MUSIC_API_URL in .env to your own audio download endpoint.
// Your API must accept: GET /endpoint?url=<youtube_url>
// and return the raw audio binary (mp3/mp4/m4a).
async function providerCustom(videoUrl) {
  const apiUrl = process.env.MUSIC_API_URL;
  if (!apiUrl) throw new Error('[custom] MUSIC_API_URL is not set in .env');

  const res = await axios.get(apiUrl, {
    params: { url: videoUrl },
    responseType: 'arraybuffer',
    timeout: 90_000,
    headers: { 'User-Agent': UA },
  });
  const buf = Buffer.from(res.data);
  if (buf.length < 5000) throw new Error('[custom] Downloaded file too small');
  return buf;
}

// ─── Provider registry ────────────────────────────────────────────────────────
// Add new providers here — key = name used in MUSIC_PROVIDERS env var
const PROVIDERS = {
  ytdl:   providerYtdl,
  cobalt: providerCobalt,
  custom: providerCustom,
};

// ─── Main export: try each provider in order ──────────────────────────────────
/**
 * Download audio for a YouTube video URL.
 * Tries providers in the order set by MUSIC_PROVIDERS env var.
 * Falls back to next provider if one fails.
 *
 * @param {string} videoUrl  Full YouTube video URL
 * @returns {Promise<Buffer>} Raw audio buffer
 */
export async function downloadAudio(videoUrl) {
  const order = (process.env.MUSIC_PROVIDERS || 'ytdl,cobalt')
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(Boolean);

  const errors = [];

  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider) {
      console.warn(`⚠️  Unknown music provider: "${name}" — skipping`);
      continue;
    }

    try {
      console.log(`🎵 Trying music provider: ${name}`);
      const buf = await provider(videoUrl);
      console.log(`✅ Music downloaded via: ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
      return buf;
    } catch (err) {
      console.warn(`⚠️  Provider "${name}" failed: ${err.message}`);
      errors.push(`${name}: ${err.message}`);
    }
  }

  throw new Error(
    `All music providers failed:\n${errors.map(e => `  • ${e}`).join('\n')}`
  );
}
