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
  if (typeof v === 'string' && /[kmb]|views?/i.test(v)) return v.trim();
  const n = typeof v === 'number' ? v : parseInt(v) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K views`;
  return `${n} views`;
}

const YOUTUBE_URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

function youtubeRows(data) {
  const preferred = new Set([
    'videos', 'video', 'results', 'items', 'data', 'result',
    'searchresults', 'search_results', 'contents',
  ]);
  const queue = [{ value: data, depth: 0 }];
  const visited = new Set();
  const arrays = [];

  while (queue.length && visited.size < 400 && arrays.length < 40) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > 8 || visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      if (value.length) arrays.push(value);
      continue;
    }

    const entries = Object.entries(value).sort(([left], [right]) => {
      const a = preferred.has(left.toLowerCase()) ? 0 : 1;
      const b = preferred.has(right.toLowerCase()) ? 0 : 1;
      return a - b;
    });
    for (const [, child] of entries) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }

  const score = rows => rows.reduce((total, row) => {
    if (!row || typeof row !== 'object') return total;
    const hasTitle = Boolean(row.title || row.name || row.videoTitle);
    const hasIdentity = Boolean(row.url || row.link || row.videoId || row.video_id || row.id || row.key);
    return total + (hasTitle && hasIdentity ? 1 : 0);
  }, 0);
  arrays.sort((left, right) => score(right) - score(left));
  if (arrays.length && score(arrays[0]) > 0) return arrays[0];
  if (data && typeof data === 'object' &&
      (data.title || data.name || data.videoTitle) &&
      (data.url || data.link || data.videoId || data.video_id || data.id)) {
    return [data];
  }
  return [];
}

function youtubeWatchUrl(rawUrl, id) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (url && YOUTUBE_URL_RE.test(url)) {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }
  const videoId = String(id || '').trim();
  return /^[A-Za-z0-9_-]{11}$/.test(videoId)
    ? `https://www.youtube.com/watch?v=${videoId}`
    : '';
}

function textValue(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value.simpleText === 'string') return value.simpleText.trim();
  if (typeof value.text === 'string') return value.text.trim();
  if (Array.isArray(value.runs)) return value.runs.map(run => run?.text || '').join('').trim();
  return '';
}

function parseYoutubeSearchResults(data) {
  if (data?.status === false || data?.success === false || data?.error) {
    throw new Error(data?.message || data?.error || 'YouTube search provider failed');
  }

  const rows = youtubeRows(data);
  const results = rows.map((row) => {
    const author = row?.author || row?.channel || row?.uploader || {};
    const rawThumbnail = row?.thumbnail || row?.thumbnailUrl || row?.thumbnail_url ||
      row?.image || '';
    const title = textValue(row?.title || row?.name || row?.videoTitle);
    const rawUrl = row?.url || row?.link || row?.videoUrl || row?.video_url ||
      row?.watchUrl || row?.permalink || '';
    const videoId = row?.videoId || row?.video_id || row?.id ||
      row?.key || row?.video?.id || '';
    return {
      title,
      url: youtubeWatchUrl(rawUrl, videoId),
      channel: typeof author === 'string'
        ? author
        : author?.name || row?.channelName || row?.uploaderName || '',
      duration: textValue(row?.duration?.timestamp || row?.duration?.text || row?.duration),
      views: fmtViews(row?.views ?? row?.viewCount ?? row?.view_count),
      thumbnail: typeof rawThumbnail === 'string' ? rawThumbnail : rawThumbnail?.url || '',
    };
  }).filter(result => result.title && result.url);

  if (!results.length) throw new Error(data?.message || 'No valid YouTube results');
  return results;
}

// ══════════════════════════════════════════════════════════
//   YouTube Search APIs
//   parse() must return: [{ title, url, channel, duration, views, thumbnail }]
// ══════════════════════════════════════════════════════════

export const ytSearchAPIs = [
  {
    // First-party provider supplied for !yt / !yts search.
    name:    'eliteprotech',
    url:     'https://eliteprotech-apis.zone.id/search/ytsearch',
    enabled: true,
    params:  (q) => ({ q }),
    parse:   parseYoutubeSearchResults,
  },
  {
    // Requires GTECH_YT_API_KEY; skipped when the key is not configured.
    name:    'gtech',
    url:     'https://gtech-api-xtp1.onrender.com/api/search/yt',
    enabled: Boolean((process.env.GTECH_YT_API_KEY || '').trim()),
    params:  (q) => ({
      query: q,
      apikey: (process.env.GTECH_YT_API_KEY || '').trim(),
    }),
    parse:   parseYoutubeSearchResults,
  },
  {
    // Public search fallback supplied for !yt / !yts.
    name:    'hector',
    url:     'https://hector-api.vercel.app/search/youtube',
    enabled: true,
    params:  (q) => ({ q }),
    parse:   parseYoutubeSearchResults,
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
