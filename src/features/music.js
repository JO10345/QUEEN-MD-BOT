/**
 * Music download — !music <song name or YouTube URL>
 *
 * Search : yt-search npm package (no API key needed)
 * Audio  : hector-yt-dl API → Nexray ytplay API fallback
 *
 * To swap the download API, edit src/apis/config.js → ytMp3APIs
 */

import ytSearch from 'yt-search';
import axios    from 'axios';
import { ytMp3APIs, dedicatedMusicAPIs } from '../apis/config.js';

const YT_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))([\w-]{11})/;
const DAVID_API_KEY = (process.env.DAVID_API_KEY || '').trim();

function davidHeaders() {
  if (!DAVID_API_KEY) {
    throw new Error('DAVID_API_KEY is not configured in the bot environment.');
  }
  return { 'X-API-Key': DAVID_API_KEY };
}

function audioMime(buffer, contentType) {
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  if (mime.startsWith('audio/')) return mime;
  if (buffer.subarray(0, 3).toString() === 'ID3' ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.indexOf(Buffer.from('ftyp')) >= 0) return 'audio/mp4';
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  return 'audio/mpeg';
}

function isAudioBuffer(buffer, contentType) {
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  const head = buffer.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<html') || head.startsWith('<!doctype') || head.startsWith('{')) return false;
  return mime.startsWith('audio/') ||
    buffer.subarray(0, 3).toString() === 'ID3' ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ||
    buffer.indexOf(Buffer.from('ftyp')) >= 0 ||
    buffer.subarray(0, 4).toString() === 'OggS' ||
    buffer.subarray(0, 4).toString() === 'fLaC';
}

async function downloadFromApi(api, input, headers) {
  const { data } = await axios.get(api.url, {
    params: api.params(input),
    headers,
    timeout: 30_000,
  });
  const parsed = api.parse(data);
  const response = await axios.get(parsed.downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const buf = Buffer.from(response.data);
  if (buf.length < 5_000 || !isAudioBuffer(buf, response.headers?.['content-type'])) {
    throw new Error('The provider did not return a valid audio file');
  }
  return {
    buf,
    title: parsed.title || '',
    mimetype: audioMime(buf, response.headers?.['content-type']),
  };
}

async function downloadAudio(videoUrl, command = 'mp3', fallbackUrl = videoUrl, searchQuery = videoUrl) {
  if (command !== 'mp3') {
    const api = dedicatedMusicAPIs[command];
    try {
      return await downloadFromApi(api, videoUrl, api.requiresApiKey ? davidHeaders() : undefined);
    } catch (e) {
      console.warn(`[Music] ${api.name} failed: ${e.message}`);
      if (command === 'music') {
        const backup = dedicatedMusicAPIs.musicNexray;
        try {
          const result = await downloadFromApi(backup, searchQuery);
          console.log(`[Music] Fallback succeeded via ${backup.name}`);
          return result;
        } catch (fallbackError) {
          console.warn(`[Music] ${backup.name} failed: ${fallbackError.message}`);
          throw new Error(`David music API and Nexray fallback failed: ${fallbackError.message}`);
        }
      }
      if (command === 'song') {
        const backup = dedicatedMusicAPIs.botcahx;
        return downloadFromApi(backup, fallbackUrl);
      }
      throw e;
    }
  }

  for (const api of ytMp3APIs.filter(a => a.enabled)) {
    try {
      const result = await downloadFromApi(
        api,
        api.input === 'query' ? searchQuery : videoUrl,
      );
      const { buf, title } = result;
      console.log(`[Music] Downloaded via ${api.name} (${(buf.length / 1024).toFixed(0)} KB)`);
      return result;
    } catch (e) {
      console.warn(`[Music] ${api.name} failed: ${e.message}`);
    }
  }

  // Do not use the legacy YouTube metadata handshake here. YouTube bot
  // detection frequently blocks it; direct-download APIs are the supported path.
  throw new Error('All configured audio download providers failed.');
}

export async function handleMusic(sock, msg, query, command = 'mp3') {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ Usage: *!${command} <song name or YouTube link>*\nExample: *!${command} shape of you*`,
    }, { quoted: msg });
    return;
  }

  try {
    let videoUrl = '';
    let title = query;

    if (YT_REGEX.test(query)) {
      videoUrl = query.trim();
    } else {
      await sock.sendMessage(jid, { text: `🔍 *Searching for:* _${query}_...` });
      const results = await ytSearch(query);
      const video = results.videos[0];
      if (!video) {
        await sock.sendMessage(jid, {
          text: `❌ No results found for *"${query}"*\nTry a different song name.`,
        }, { quoted: msg });
        return;
      }
      videoUrl = video.url;
      title = video.title;
    }

    await sock.sendMessage(jid, {
      text: `🎵 *${title}*\n📥 _Downloading audio..._`,
    }, { quoted: msg });

    const apiInput = command === 'mp3' ? videoUrl : query;
    const { buf, title: dlTitle, mimetype } = await downloadAudio(apiInput, command, videoUrl, query);
    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);

    if (buf.length > 50 * 1024 * 1024) {
      await sock.sendMessage(jid, {
        text: `⚠️ *File too large* (${sizeMb} MB). WhatsApp limit is 50 MB.\nTry a shorter track.`,
      }, { quoted: msg });
      return;
    }

    await sock.sendMessage(jid, {
      audio: buf,
      mimetype: mimetype || 'audio/mpeg',
      ptt: false,
    }, { quoted: msg });

    await sock.sendMessage(jid, {
      text: `✅ *${dlTitle || title}*\n📦 ${sizeMb} MB  ·  🎶 _Enjoy!_`,
    });

  } catch (err) {
    console.error('[Music] error:', err.message);
    const keyHint = err.message?.includes('DAVID_API_KEY') ||
      [401, 403].includes(err.response?.status)
      ? '\n\nCheck that DAVID_API_KEY is set correctly in the bot environment.'
      : '';
    await sock.sendMessage(jid, {
      text:
        `❌ *Could not download audio for:* _${query}_\n\n` +
        `Try:\n• A different song name\n• A direct YouTube link${keyHint}`,
    }, { quoted: msg });
  }
}