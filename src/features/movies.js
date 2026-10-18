import axios from 'axios';

const API = 'https://apis.davidcyriltech.my.id';
const MAX_RESULTS = 8;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const movieSearches = new Map();

const clean = (value) => String(value || '').replace(/[\r\n]/g, ' ').trim();

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function movieResults(data) {
  const rows = data?.results || data?.result || data?.data || [];
  return asArray(rows)
    .map((row) => ({
      title: row?.title || row?.name || 'Untitled movie',
      url: row?.url || row?.link || row?.href || '',
      thumbnail: row?.thumbnail || row?.image || row?.poster || '',
      date: row?.date || row?.year || '',
    }))
    .filter((row) => row.url);
}

function movieDownloadLinks(info) {
  const links = [];
  for (const group of asArray(info?.download_groups)) {
    for (const link of asArray(group?.links)) {
      if (link?.url) links.push({ label: link.label || group.section_title || 'Download', url: link.url });
    }
  }
  for (const link of asArray(info?.downloads || info?.download_links || info?.downloadLinks)) {
    const url = typeof link === 'string' ? link : link?.url || link?.link;
    if (url) links.push({ label: link?.label || 'Download', url });
  }
  return [...new Map(links.map((link) => [link.url, link])).values()];
}

function safeFileName(title) {
  return clean(title || 'movie')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 100) || 'movie';
}

function mediaType(contentType = '') {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return type && type !== 'text/html' && type !== 'application/xhtml+xml' &&
    type !== 'application/json' && type !== 'text/plain';
}

async function fetchMovieFile(url, depth = 0) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 180_000,
    maxContentLength: MAX_UPLOAD_BYTES,
    maxBodyLength: MAX_UPLOAD_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
  });

  const contentType = response.headers?.['content-type'] || '';
  const buffer = Buffer.from(response.data);
  if (mediaType(contentType) || contentType === 'application/octet-stream') {
    return { buffer, contentType: contentType || 'application/octet-stream' };
  }

  // Some providers return a short landing page before the real file URL.
  // Follow one level of absolute links rather than sending HTML as a movie.
  if (depth < 1 && buffer.length < 2 * 1024 * 1024) {
    const html = buffer.toString('utf8');
    const candidates = [...html.matchAll(/https?:\/\/[^"'\\\s<>]+/gi)]
      .map((match) => match[0].replace(/&amp;/g, '&'))
      .filter((candidate) => /\.(?:mp4|mkv|avi|mov|webm)(?:[?#]|$)/i.test(candidate));
    for (const candidate of [...new Set(candidates)]) {
      try {
        return await fetchMovieFile(candidate, depth + 1);
      } catch {}
    }
  }
  throw new Error('The provider returned a web page instead of a movie file.');
}

async function downloadMovie(sock, msg, result) {
  const jid = msg.key.remoteJid;
  const status = await axios.get(`${API}/xprimehub/info`, {
    params: { url: result.url },
    timeout: 45_000,
  });
  if (!status.data?.success) throw new Error(status.data?.message || 'Movie details unavailable');

  const info = status.data;
  const links = movieDownloadLinks(info);
  if (!links.length) throw new Error('No download link was returned for this movie.');

  const title = info.title || result.title;
  await sock.sendMessage(jid, {
    text: `🎬 *${clean(title)}*\n📥 _Fetching the movie file..._`,
  }, { quoted: msg });

  let lastError = null;
  for (const link of links) {
    try {
      const { buffer, contentType } = await fetchMovieFile(link.url);
      if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('Movie exceeds the upload safety limit.');
      const extension = /\.mkv/i.test(info?.info?.format || '') ? 'mkv' : 'mp4';
      return sock.sendMessage(jid, {
        document: buffer,
        mimetype: contentType || (extension === 'mkv' ? 'video/x-matroska' : 'video/mp4'),
        fileName: `${safeFileName(title)}.${extension}`,
        caption: `✅ ${clean(title)}\n📦 ${(buffer.length / 1024 / 1024).toFixed(1)} MB`,
      }, { quoted: msg });
    } catch (error) {
      lastError = error;
      console.warn(`[Movie] ${link.label} failed: ${error.message}`);
    }
  }

  const fallback = links[0]?.url;
  throw new Error(`${lastError?.message || 'All movie download links failed'}\n\nDirect link: ${fallback}`);
}

export async function handleMovie(sock, msg, query) {
  const jid = msg.key.remoteJid;
  const input = String(query || '').trim();
  if (!input) {
    return sock.sendMessage(jid, {
      text: 'Usage: *!mov <movie name>*\nReply with *!mov 1* to download another result from your last search.',
    }, { quoted: msg });
  }

  let result;
  if (/^\d+$/.test(input) && movieSearches.has(jid)) {
    result = movieSearches.get(jid)[Number(input) - 1];
    if (!result) {
      return sock.sendMessage(jid, { text: '❌ That movie number is not in your last search results.' }, { quoted: msg });
    }
  } else {
    await sock.sendMessage(jid, { text: `🔍 *Searching XPrimeHub for:* _${clean(input)}_...` }, { quoted: msg });
    const response = await axios.get(`${API}/xprimehub/search`, {
      params: { q: input, limit: MAX_RESULTS },
      timeout: 45_000,
    });
    if (!response.data?.success) {
      return sock.sendMessage(jid, {
        text: `❌ Movie search failed: ${clean(response.data?.message || 'No results found')}`,
      }, { quoted: msg });
    }
    const results = movieResults(response.data).slice(0, MAX_RESULTS);
    if (!results.length) {
      return sock.sendMessage(jid, { text: `❌ No movies found for *${clean(input)}*.` }, { quoted: msg });
    }
    movieSearches.set(jid, results);
    const list = results.map((item, index) =>
      `${index + 1}. *${clean(item.title)}*\n   🔗 ${item.url}`
    ).join('\n\n');
    await sock.sendMessage(jid, {
      text: `🎬 *Movie results for:* _${clean(input)}_\n\n${list}\n\n_Starting download of result 1. Send ${process.env.PREFIX || '!'}mov 2-8 to choose another._`,
    }, { quoted: msg });
    result = results[0];
  }

  try {
    return await downloadMovie(sock, msg, result);
  } catch (error) {
    console.error('[Movie] error:', error.message);
    return sock.sendMessage(jid, {
      text: `❌ *Movie download failed:*\n${error.message}`,
    }, { quoted: msg });
  }
}