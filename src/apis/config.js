/**
 * ══════════════════════════════════════════════════════════
 *   Queen MD Bot — Centralized API Configuration
 * ══════════════════════════════════════════════════════════
 *
 *  ➤ To swap a broken API:
 *      • Set its `enabled: false`  — it will be skipped
 *      • Or change its `url`       — new URL is used immediately
 *      • The bot tries each API in order and falls back automatically
 *
 *  ➤ API groups: ytSearch, ytMp3, ytMp4
 *    Each entry must have:  name, url, enabled, params(query), parse(data)
 * ══════════════════════════════════════════════════════════
 */

// ── Shared helpers ─────────────────────────────────────────────────────────────

export function fmtViews(v) {
  if (!v && v !== 0) return '';
  const n = typeof v === 'number' ? v : parseInt(v) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K views`;
  return `${n} views`;
}

// ══════════════════════════════════════════════════════════
//   YouTube Search APIs
//   parse() must return: [{ title, url, channel, duration, views, thumbnail }]
// ══════════════════════════════════════════════════════════

export const ytSearchAPIs = [
  {
    // Primary — endpoint confirmed with ?q=<search query>.
    name:    'eliteprotech',
    url:     'https://eliteprotech-apis.zone.id/search/ytsearch',
    enabled: true,
    params:  (q) => ({ q }),
    parse:   (data) => {
      if (data?.success === false || data?.status === false) {
        throw new Error(data?.error || data?.message || 'eliteprotech search failed');
      }
      const results = data?.results?.videos || data?.result?.videos || data?.results;
      if (!Array.isArray(results) || !results.length) throw new Error('No results');
      return results.map(r => ({
        title:     r.title     || '',
        url:       r.url       || (r.id ? `https://youtube.com/watch?v=${r.id}` : ''),
        channel:   r.author?.name || '',
        duration:  r.duration  || '',
        views:     fmtViews(r.views),
        thumbnail: r.thumbnail || '',
      }));
    },
  },
  {
    // Fallback — requires BOTCAHX_API_KEY in the host environment.
    name:    'botcahx',
    url:     'https://api.botcahx.eu.org/api/search/yts',
    enabled: true,
    params:  (q) => ({
      query: q,
      ...(process.env.BOTCAHX_API_KEY ? { apikey: process.env.BOTCAHX_API_KEY } : {}),
    }),
    parse:   (data) => {
      if (!data?.status) throw new Error(data?.message || 'botcahx search failed');
      const results = data?.result;
      if (!Array.isArray(results) || !results.length) throw new Error('No results');
      return results.map(r => ({
        title:     r.title        || '',
        url:       r.url          || (r.videoId ? `https://youtube.com/watch?v=${r.videoId}` : ''),
        channel:   r.author?.name || '',
        duration:  r.duration     || '',
        views:     fmtViews(r.views),
        thumbnail: r.thumbnail    || '',
      }));
    },
  },
  {
    // Fallback 2 — hector (disable if captcha appears)
    name:    'hector',
    url:     'https://hector-api.vercel.app/search/youtube',
    enabled: true,
    params:  (q) => ({ q }),
    parse:   (data) => {
      if (!data?.status) throw new Error('hector search failed');
      const results = data?.result;
      if (!Array.isArray(results) || !results.length) throw new Error('No results');
      return results.map(r => ({
        title:     r.title    || '',
        url:       r.link     || '',
        channel:   r.channel  || '',
        duration:  r.duration || '',
        views:     '',
        thumbnail: r.imageUrl || '',
      }));
    },
  },
];

// ══════════════════════════════════════════════════════════
//   YouTube MP3 Download APIs
//   parse() must return: { downloadUrl, title }
// ══════════════════════════════════════════════════════════

export const ytMp3APIs = [
  {
    name:    'eliteprotech',
    url:     'https://eliteprotech-apis.zone.id/ytmp3',
    enabled: false, // ← captcha wall — re-enable if it clears
    params:  (url) => ({ url }),
    parse:   (data) => {
      if (!data?.status) throw new Error(data?.message || 'eliteprotech mp3 failed');
      const dl = data?.result?.download;
      if (!dl) throw new Error('No download URL');
      return { downloadUrl: dl, title: data.result?.title || '' };
    },
  },
  {
    name:    'hector-yt-dl',
    url:     'https://yt-dl.officialhectormanuel.workers.dev/',
    enabled: true,
    params:  (url) => ({ url }),
    parse:   (data) => {
      if (!data?.status) throw new Error('hector-yt-dl mp3 failed');
      const dl = data?.audio;
      if (!dl) throw new Error('No audio URL');
      return { downloadUrl: dl, title: data.title || '' };
    },
  },
  {
    // Search-based backup for the `!mp3` command. It accepts either a song
    // name or a YouTube URL and returns a direct audio download URL.
    name:    'nexray-ytplay',
    url:     'https://api.nexray.eu.cc/downloader/ytplay',
    enabled: true,
    input:   'query',
    params:  (query) => ({ q: query }),
    parse:   (data) => {
      if (data?.status === false || data?.success === false) {
        throw new Error(data?.message || 'nexray ytplay failed');
      }
      const r = data?.result || data?.data || data || {};
      const downloadUrl = r.download_url || r.downloadUrl || r.audio?.url ||
        (typeof r.audio === 'string' ? r.audio : '') || r.url || data?.download_url;
      if (!downloadUrl) throw new Error(data?.message || 'No Nexray audio URL');
      return { downloadUrl, title: r.title || data?.title || '' };
    },
  },
];

// Dedicated APIs keep !music and !song independent from the original !mp3
// provider chain.
export const dedicatedMusicAPIs = {
  music: {
    name: 'davidcyril-play',
    url: 'https://apis.davidcyriltech.my.id/play',
    requiresApiKey: true,
    params: (query) => ({ query }),
    parse: (data) => {
      if (data?.status === false || data?.success === false) {
        throw new Error(data?.message || 'play music failed');
      }
      const r = data?.result || data?.data || data || {};
      const downloadUrl = r.download_url || r.downloadUrl || r.audio?.download_url ||
        r.audio?.url || (typeof r.audio === 'string' ? r.audio : '') ||
        r.url || data?.download_url || data?.url;
      if (!downloadUrl) throw new Error(data?.message || 'No audio URL');
      return { downloadUrl, title: r.title || r.name || data?.title || '' };
    },
  },
  musicNexray: {
    name: 'nexray-ytplay',
    url: 'https://api.nexray.eu.cc/downloader/ytplay',
    params: (query) => ({ q: query }),
    parse: (data) => {
      if (data?.status === false || data?.success === false) {
        throw new Error(data?.message || 'Nexray ytplay failed');
      }
      const r = data?.result || data?.data || data || {};
      const downloadUrl = r.download_url || r.downloadUrl || r.audio?.url ||
        (typeof r.audio === 'string' ? r.audio : '') || r.url || data?.download_url;
      if (!downloadUrl) throw new Error(data?.message || 'No Nexray audio URL');
      return { downloadUrl, title: r.title || data?.title || '' };
    },
  },
  song: {
    name: 'davidcyril-song',
    url: 'https://apis.davidcyriltech.my.id/song',
    requiresApiKey: true,
    params: (query) => ({ query }),
    parse: (data) => {
      if (data?.status === false || data?.success === false) {
        throw new Error(data?.message || 'song download failed');
      }
      const r = data?.result || data?.data || data || {};
      const downloadUrl = r.audio?.download_url || r.audio?.downloadUrl || r.audio?.url ||
        (typeof r.audio === 'string' ? r.audio : '') ||
        r.download_url || r.downloadUrl || r.download || r.url;
      if (!downloadUrl) throw new Error(data?.message || 'No audio URL');
      return { downloadUrl, title: r.title || r.name || data?.title || '' };
    },
  },
  botcahx: {
    name: 'botcahx-youtube',
    url: 'https://api.botcahx.eu.org/api/dowloader/yt',
    params: (url) => ({
      url,
      ...(process.env.BOTCAHX_API_KEY ? { apikey: process.env.BOTCAHX_API_KEY } : {}),
    }),
    parse: (data) => {
      const r = data?.result || data?.data || data;
      const downloadUrl = r?.audio || r?.audioUrl || r?.download ||
        r?.downloadUrl || r?.mp3 || r?.url;
      if (!downloadUrl) throw new Error(data?.message || 'No botcahx audio URL');
      return { downloadUrl, title: r?.title || r?.judul || '' };
    },
  },
};

// ══════════════════════════════════════════════════════════
//   YouTube MP4 Download APIs
//   parse() must return: { downloadUrl, title }
// ══════════════════════════════════════════════════════════

export const ytMp4APIs = [
  {
    // ✅ Primary — clean, no auth, returns title + thumbnail too
    name:    'davidcyril',
    url:     'https://apis.davidcyriltech.my.id/youtube/mp4',
    enabled: true,
    params:  (url) => ({ url }),
    parse:   (data) => {
      if (!data?.status) throw new Error(data?.message || 'davidcyril mp4 failed');
      const dl = data?.result?.url;
      if (!dl) throw new Error('No download URL');
      return {
        downloadUrl: dl,
        title:       data.result?.title     || '',
        thumbnail:   data.result?.thumbnail || '',
      };
    },
  },
  {
    // Disabled — captcha wall
    name:    'eliteprotech',
    url:     'https://eliteprotech-apis.zone.id/ytmp4',
    enabled: false,
    params:  (url) => ({ url }),
    parse:   (data) => {
      if (!data?.status) throw new Error(data?.message || 'eliteprotech mp4 failed');
      const dl = data?.result?.url;
      if (!dl) throw new Error('No download URL');
      return { downloadUrl: dl, title: data.result?.title || '', thumbnail: '' };
    },
  },
];
