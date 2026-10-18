import axios from 'axios';

const API = 'https://apis.davidcyriltech.my.id';
const DAVID_API_KEY = (process.env.DAVID_API_KEY || '').trim();
const clean = (v) => String(v || '').replace(/[\r\n]/g, ' ').trim();
const pendingSpotify = new Map();
const pendingSoundCloud = new Map();
const SPOTIFY_SELECTION_TTL_MS = 10 * 60 * 1000;
const SOUNDCLOUD_SELECTION_TTL_MS = 10 * 60 * 1000;

function davidApiHeaders() {
  if (!DAVID_API_KEY) throw new Error('DAVID_API_KEY is not set in the bot environment.');
  return { 'X-API-Key': DAVID_API_KEY, 'User-Agent': 'Queen-MD-Bot/3.1', Accept: 'image/*' };
}

async function requestDavidImage(endpoint, prompt) {
  const response = await axios.get(`${API}${endpoint}`, {
    params: { prompt },
    headers: davidApiHeaders(),
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: 35 * 1024 * 1024,
  });
  const buffer = Buffer.from(response.data);
  const contentType = String(response.headers?.['content-type'] || '').split(';')[0].toLowerCase();
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isGif = buffer.subarray(0, 3).toString() === 'GIF';
  const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WEBP';

  if (contentType.includes('json') || contentType.startsWith('text/')) {
    let detail = 'The provider returned a non-image response.';
    try {
      const payload = JSON.parse(buffer.toString('utf8'));
      detail = payload?.message || payload?.error || detail;
    } catch {}
    throw new Error(detail);
  }
  if (buffer.length < 1000 || (!contentType.startsWith('image/') && !isPng && !isJpeg && !isGif && !isWebp)) {
    throw new Error('The provider did not return a valid image.');
  }
  const mimetype = contentType.startsWith('image/') ? contentType
    : isPng ? 'image/png'
    : isGif ? 'image/gif'
    : isWebp ? 'image/webp'
    : 'image/jpeg';
  return { buffer, mimetype };
}

async function handleDavidImage(sock, msg, prompt, endpoint, label) {
  const jid = msg.key.remoteJid;
  const input = String(prompt || '').trim();
  if (input.length < 3) {
    return sock.sendMessage(jid, {
      text: `Usage: *!${label.toLowerCase()} <image prompt>*`,
    }, { quoted: msg });
  }
  try {
    const { buffer, mimetype } = await requestDavidImage(endpoint, input);
    return sock.sendMessage(jid, {
      image: buffer,
      mimetype,
      caption: `✨ ${label}: ${input.slice(0, 900)}`,
    }, { quoted: msg });
  } catch (error) {
    const keyHint = /DAVID_API_KEY/.test(error.message) || [401, 403].includes(error.response?.status)
      ? '\nCheck that DAVID_API_KEY is set correctly in the bot environment.'
      : '';
    return sock.sendMessage(jid, {
      text: `❌ ${label} failed: ${error.message}${keyHint}`,
    }, { quoted: msg });
  }
}

function normalizeSpotifyResults(data) {
  if (data?.status === false || data?.success === false) {
    throw new Error(data?.message || 'Spotify search provider failed');
  }
  const rows = Array.isArray(data?.result) ? data.result :
    Array.isArray(data?.results) ? data.results :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.result?.tracks?.items) ? data.result.tracks.items :
    Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
  const seen = new Set();
  return rows.map((row) => {
    const track = row?.track || row;
    const artists = Array.isArray(track?.artists)
      ? track.artists.map(artist => artist?.name).filter(Boolean).join(', ')
      : track?.artist?.name || track?.artist || '';
    return {
      title: track?.title || track?.name || 'Unknown title',
      artist: artists,
      duration: track?.duration || track?.duration_ms || '',
      url: track?.spotifyUrl || track?.url || track?.link || track?.external_urls?.spotify ||
        (track?.id ? `https://open.spotify.com/track/${track.id}` : ''),
    };
  }).filter((track) => {
    if (!track.url || seen.has(track.url)) return false;
    seen.add(track.url);
    return true;
  }).slice(0, 10);
}

async function searchSpotify(query) {
  const providers = [
    {
      name: 'nexray',
      url: 'https://api.nexray.eu.cc/search/spotify',
      params: { q: query },
      headers: undefined,
    },
    {
      name: 'davidcyril',
      url: `${API}/spotify-v2`,
      params: { query, ...(DAVID_API_KEY ? { apikey: DAVID_API_KEY } : {}) },
      headers: DAVID_API_KEY ? { 'X-API-Key': DAVID_API_KEY } : undefined,
    },
  ];
  let lastError;
  for (const provider of providers) {
    try {
      const { data } = await axios.get(provider.url, {
        params: provider.params,
        headers: provider.headers,
        timeout: 30_000,
      });
      const results = normalizeSpotifyResults(data);
      if (!results.length) throw new Error(data?.message || 'No Spotify results');
      return results;
    } catch (error) {
      lastError = error;
      console.warn(`[Spotify] search ${provider.name} failed: ${error.message}`);
    }
  }
  throw lastError || new Error('Spotify search providers failed');
}

function audioMimeFromBuffer(buffer, responseType) {
  const mime = String(responseType || '').split(';')[0].toLowerCase();
  if (mime.startsWith('audio/')) return mime;
  const ftyp = buffer.indexOf(Buffer.from('ftyp'));
  if (ftyp >= 0 && ftyp <= 64) return 'audio/mp4';
  if (buffer.subarray(0, 3).toString() === 'ID3' ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  return 'audio/mpeg';
}

function isAudioFile(buffer, contentType) {
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  const head = buffer.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<html') || head.startsWith('<!doctype') || head.startsWith('{')) return false;
  return mime.startsWith('audio/') ||
    buffer.subarray(0, 3).toString() === 'ID3' ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ||
    (buffer.indexOf(Buffer.from('ftyp')) >= 0 && buffer.indexOf(Buffer.from('ftyp')) <= 64) ||
    buffer.subarray(0, 4).toString() === 'OggS' ||
    buffer.subarray(0, 4).toString() === 'fLaC';
}

function parseJsonBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function findDownloadUrl(value, depth = 0) {
  if (!value || depth > 5) return '';
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDownloadUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of [
    'download_url', 'downloadUrl', 'audio_url', 'audioUrl',
    'stream_url', 'streamUrl', 'download', 'audio', 'url',
  ]) {
    const candidate = value[key];
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate;
    const nested = findDownloadUrl(candidate, depth + 1);
    if (nested) return nested;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (['title', 'artist', 'name', 'message', 'status', 'success'].includes(key)) continue;
    const nested = findDownloadUrl(candidate, depth + 1);
    if (nested) return nested;
  }
  return '';
}

export async function handleSpotify(sock, msg, query) {
  const jid = msg.key.remoteJid;
  const input = String(query || '').trim();
  if (!input) {
    return sock.sendMessage(jid, {
      text: 'Usage: *!sp <song or artist>*\nThen choose a result with *!sp 1*, *!sp 2*, etc.',
    }, { quoted: msg });
  }

  const selection = input.match(/^(\d{1,2})$/);
  let selected = null;
  let link = '';

  if (selection) {
    const pending = pendingSpotify.get(jid);
    if (!pending || Date.now() - pending.ts > SPOTIFY_SELECTION_TTL_MS) {
      pendingSpotify.delete(jid);
      return sock.sendMessage(jid, {
        text: '❌ No recent Spotify results. Search first with *!sp <song or artist>*.',
      }, { quoted: msg });
    }
    selected = pending.results[Number(selection[1]) - 1];
    if (!selected) {
      return sock.sendMessage(jid, {
        text: `❌ Choose a result from *1* to *${pending.results.length}*.`,
      }, { quoted: msg });
    }
    link = selected.url;
  } else if (/^https?:\/\/open\.spotify\.com\//i.test(input)) {
    link = input;
  } else {
    try {
      const results = await searchSpotify(input);
      pendingSpotify.set(jid, { results, ts: Date.now() });
      const lines = results.map((track, index) =>
        `*${index + 1}.* ${clean(track.title)}${track.artist ? ` — ${clean(track.artist)}` : ''}` +
        (track.duration ? `\n   ⏱️ ${clean(track.duration)}` : '')
      ).join('\n\n');
      return sock.sendMessage(jid, {
        text: `🎧 *Spotify results for:* _${clean(input)}_\n\n${lines}\n\n_Reply with *!sp 1* to download a result. List expires in 10 minutes._`,
      }, { quoted: msg });
    } catch (error) {
      console.error('[Spotify] search failed:', error.message);
      return sock.sendMessage(jid, {
        text: '❌ Spotify search is temporarily unavailable. Please try again shortly.',
      }, { quoted: msg });
    }
  }

  const downloadingTitle = selected
    ? `${selected.title}${selected.artist ? ` — ${selected.artist}` : ''}`
    : 'Spotify track';
  await sock.sendMessage(jid, {
    text: `⬇️ *Downloading:* ${clean(downloadingTitle)}`,
  }, { quoted: msg });

  let lastError = null;
  const downloaders = [
    {
      name: 'Nexray Spotify',
      url: 'https://api.nexray.eu.cc/downloader/spotify',
      params: { url: link },
    },
    {
      name: 'David spotifydl2',
      url: `${API}/spotifydl2`,
      params: { url: link, ...(DAVID_API_KEY ? { apikey: DAVID_API_KEY } : {}) },
      headers: DAVID_API_KEY ? { 'X-API-Key': DAVID_API_KEY } : undefined,
    },
    {
      name: 'David spotifydl',
      url: `${API}/spotifydl`,
      params: { url: link, ...(DAVID_API_KEY ? { apikey: DAVID_API_KEY } : {}) },
      headers: DAVID_API_KEY ? { 'X-API-Key': DAVID_API_KEY } : undefined,
    },
  ];
  for (const provider of downloaders) {
    try {
      const response = await axios.get(provider.url, {
        params: provider.params,
        headers: provider.headers,
        timeout: 45_000,
        maxContentLength: 50 * 1024 * 1024,
      });
      let data = response.data;
      let directAudio = null;
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        const raw = Buffer.from(data);
        if (isAudioFile(raw, response.headers?.['content-type'])) directAudio = raw;
        else data = parseJsonBuffer(raw) || {};
      } else if (typeof data === 'string') {
        data = parseJsonBuffer(Buffer.from(data)) || data;
      }
      if (data?.success === false || data?.status === false) {
        throw new Error(data?.message || 'Spotify downloader failed');
      }
      let buffer = directAudio;
      let audioContentType = directAudio ? response.headers?.['content-type'] : '';
      if (!buffer) {
        const downloadUrl = findDownloadUrl(data);
        if (!downloadUrl) throw new Error(data?.message || 'No audio link returned');
        const audio = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 120_000,
          maxContentLength: 50 * 1024 * 1024,
          maxBodyLength: 50 * 1024 * 1024,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        buffer = Buffer.from(audio.data);
        audioContentType = audio.headers?.['content-type'];
      }
      if (buffer.length < 5_000 || !isAudioFile(buffer, audioContentType)) {
        throw new Error(`${provider.name} did not return a valid audio file`);
      }
      const title = data?.title || data?.result?.title || data?.data?.title ||
        selected?.title || 'Spotify track';
      await sock.sendMessage(jid, {
        audio: buffer,
        mimetype: audioMimeFromBuffer(buffer, audioContentType),
        ptt: false,
      }, { quoted: msg });
      await sock.sendMessage(jid, {
        text: `✅ *${clean(title)}* downloaded from Spotify.`,
      }, { quoted: msg });
      pendingSpotify.delete(jid);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[Spotify] ${provider.name} failed: ${error.message}`);
    }
  }

  const keyHint = /api key|required|missing_api_key/i.test(lastError?.message || '')
    ? '\nCheck that *DAVID_API_KEY* is configured in the bot environment.'
    : '';
  return sock.sendMessage(jid, {
    text: `❌ Spotify download failed. The downloader did not return a valid audio file.${keyHint}`,
  }, { quoted: msg });
}

async function downloadSoundCloudTrack(sock, msg, track) {
  const jid = msg.key.remoteJid;
  await sock.sendMessage(jid, {
    text: `⬇️ *Downloading:* ${clean(track.title || 'SoundCloud track')}`,
  }, { quoted: msg });

  try {
    const response = await axios.get('https://api.nexray.eu.cc/downloader/soundcloud', {
      params: { url: track.url },
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: 50 * 1024 * 1024,
    });
    let buffer = Buffer.from(response.data);
    let contentType = response.headers?.['content-type'] || '';

    if (!isAudioFile(buffer, contentType)) {
      const payload = parseJsonBuffer(buffer);
      if (!payload) throw new Error('SoundCloud provider returned an invalid response');
      if (payload?.success === false || payload?.status === false) {
        throw new Error(payload?.message || payload?.error || 'SoundCloud download provider failed');
      }
      const downloadUrl = findDownloadUrl(payload);
      if (!downloadUrl) {
        throw new Error(payload?.message || payload?.error || 'SoundCloud provider returned no audio link');
      }
      const audio = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      buffer = Buffer.from(audio.data);
      contentType = audio.headers?.['content-type'] || '';
    }

    if (buffer.length < 5_000 || !isAudioFile(buffer, contentType)) {
      throw new Error('SoundCloud provider did not return a valid audio file');
    }
    await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: audioMimeFromBuffer(buffer, contentType),
      ptt: false,
    }, { quoted: msg });
    await sock.sendMessage(jid, {
      text: `✅ *${clean(track.title || 'SoundCloud track')}* downloaded.`,
    }, { quoted: msg });
    pendingSoundCloud.delete(jid);
  } catch (error) {
    console.warn(`[SoundCloud] download failed: ${error.message}`);
    await sock.sendMessage(jid, {
      text: `❌ SoundCloud download failed: ${clean(error.message || 'The provider returned no audio file.')}`,
    }, { quoted: msg });
  }
}

export async function handleSoundCloudSearch(sock, msg, query) {
  const jid = msg.key.remoteJid;
  const input = String(query || '').trim();
  const selection = input.match(/^(\d{1,2})$/);
  if (!input || (input.length < 2 && !selection)) {
    return sock.sendMessage(jid, {
      text: 'Usage: *!soundcloud <song, artist, or keyword>*',
    }, { quoted: msg });
  }
  if (selection) {
    const pending = pendingSoundCloud.get(jid);
    if (!pending || Date.now() - pending.ts > SOUNDCLOUD_SELECTION_TTL_MS) {
      pendingSoundCloud.delete(jid);
      return sock.sendMessage(jid, {
        text: '❌ No recent SoundCloud results. Search first with *!soundcloud <song or artist>*.',
      }, { quoted: msg });
    }
    const track = pending.results[Number(selection[1]) - 1];
    if (!track) {
      return sock.sendMessage(jid, {
        text: `❌ Choose a SoundCloud result from *1* to *${pending.results.length}*.`,
      }, { quoted: msg });
    }
    return downloadSoundCloudTrack(sock, msg, track);
  }
  if (/^https?:\/\/(?:www\.|m\.)?soundcloud\.com\//i.test(input)) {
    return downloadSoundCloudTrack(sock, msg, { title: 'SoundCloud track', url: input });
  }
  if (!DAVID_API_KEY) {
    return sock.sendMessage(jid, {
      text: '❌ SoundCloud search needs DAVID_API_KEY set in the bot environment.',
    }, { quoted: msg });
  }

  try {
    const { data } = await axios.get(`${API}/search/soundcloud`, {
      params: { text: input },
      headers: { 'X-API-Key': DAVID_API_KEY },
      timeout: 30_000,
    });
    if (data?.status === false || data?.success === false) {
      throw new Error(data?.message || 'SoundCloud search failed');
    }

    const rows = [
      data?.results,
      data?.result,
      data?.data,
      data?.tracks,
      data?.result?.tracks,
      data?.result?.items,
      data?.data?.results,
      data?.data?.tracks,
      data?.data?.items,
    ].find(Array.isArray) || [];
    const tracks = rows.slice(0, 5).map((track) => {
      const user = track?.user || track?.artist || {};
      return {
        title: track?.title || track?.name || 'Untitled track',
        artist: typeof user === 'string' ? user
          : Array.isArray(user) ? user.map(item => item?.username || item?.name).filter(Boolean).join(', ')
          : (user?.username || user?.name || ''),
        url: track?.permalink_url || track?.url || track?.link || track?.permalink || '',
        duration: track?.duration || '',
      };
    }).filter(track => track.url);

    if (!tracks.length) {
      throw new Error(data?.message || 'No playable SoundCloud links were returned');
    }
    pendingSoundCloud.set(jid, { results: tracks, ts: Date.now() });
    const list = tracks.map((track, index) =>
      `${index + 1}. *${clean(track.title)}*${track.artist ? ` — ${clean(track.artist)}` : ''}` +
      `${track.duration ? `\n   ⏱️ ${track.duration}` : ''}\n   🔗 ${track.url}`
    ).join('\n\n');
    return sock.sendMessage(jid, {
      text: `☁️ *SoundCloud results for:* _${clean(input)}_\n\n${list}\n\n_Reply with *!soundcloud 1*, *!soundcloud 2*, etc. to download a result. List expires in 10 minutes._`,
    }, { quoted: msg });
  } catch (error) {
    console.warn(`[SoundCloud] search failed: ${error.message}`);
    const keyHint = [401, 403].includes(error.response?.status)
      ? '\nCheck that DAVID_API_KEY is set correctly in the bot environment.'
      : '';
    return sock.sendMessage(jid, {
      text: `❌ SoundCloud search failed: ${error.message}${keyHint}`,
    }, { quoted: msg });
  }
}

export async function handleFlux(sock, msg, prompt) {
  return handleDavidImage(sock, msg, prompt, '/flux', 'Flux');
}

export async function handleAnimate(sock, msg, prompt) {
  return handleDavidImage(sock, msg, prompt, '/animagine', 'Animate');
}

export async function handleTts(sock, msg, text) {
  const jid = msg.key.remoteJid;
  if (!text) return sock.sendMessage(jid, { text: 'Usage: *!tts <text>*' }, { quoted: msg });
  try {
    const res = await axios.get(`${API}/tools/speechma`, {
      params: { text, voice: process.env.TTS_VOICE || 'Andrew' },
      responseType: 'arraybuffer', timeout: 120_000,
    });
    return sock.sendMessage(jid, { audio: Buffer.from(res.data), mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
  } catch (e) {
    return sock.sendMessage(jid, { text: `❌ TTS failed: ${e.message}` }, { quoted: msg });
  }
}

export async function handleChannelReact(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const parts = String(args || '').trim().split(/\s+/);
  const link = parts.shift();
  if (!link) return sock.sendMessage(jid, { text: 'Usage: *!channelreact <WhatsApp channel message link> [emoji1,emoji2]*' }, { quoted: msg });
  try {
    const emojis = (parts.join(' ') || '👍,❤️,🔥').split(/[,\s]+/).filter(Boolean);
    const { data } = await axios.post(`${API}/api/socialboost/wamessagereact`,
      { link, emojis, targetBots: 20 }, { timeout: 120_000 });
    return sock.sendMessage(jid, { text: `✅ Channel reaction request sent.\n${clean(data?.message || 'Processing started.')}` }, { quoted: msg });
  } catch (e) {
    return sock.sendMessage(jid, { text: `❌ Channel react failed: ${e.message}` }, { quoted: msg });
  }
}

export async function handleTikBoost(sock, msg, args) {
  const jid = msg.key.remoteJid;
  if (!args) return sock.sendMessage(jid, { text: 'Usage: *!tikbost <TikTok video link>*' }, { quoted: msg });
  try {
    const { data } = await axios.get(`${API}/api/tiktok/boost`, {
      params: { url: args.trim(), type: 'video_views' }, timeout: 120_000,
    });
    return sock.sendMessage(jid, { text: `✅ TikTok boost request sent.\n${clean(data?.message || data?.status || 'Processing started.')}` }, { quoted: msg });
  } catch (e) {
    return sock.sendMessage(jid, { text: `❌ TikTok boost failed: ${e.message}` }, { quoted: msg });
  }
}