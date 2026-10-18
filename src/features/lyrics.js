/**
 * Lyrics Search
 *
 * API: https://api.botcahx.eu.org/api/search/lirik?lirik=<song>&apikey=GMauog6R
 *
 * Commands:
 *   !lyrics <song title>  — search and display song lyrics
 *   !lyric <song title>   — alias
 */

import axios from 'axios';

const BOTCAHX_KEY  = 'GMauog6R';
const LYRICS_API   = 'https://api.botcahx.eu.org/api/search/lirik';

export async function handleLyrics(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const query = (args || '').trim();

  if (!query) {
    return sock.sendMessage(jid, {
      text: `❌ *Usage:* !lyrics <song title>\n\nExample:\n!lyrics Jiwa yang bersedih`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, {
    text: `🎵 *Searching lyrics for:* _${query}_...`,
  }, { quoted: msg });

  try {
    // API uses + for spaces in the query
    const lirik = query.replace(/\s+/g, '+');

    const { data } = await axios.get(LYRICS_API, {
      params: { lirik, apikey: BOTCAHX_KEY },
      timeout: 15_000,
    });

    if (!data?.status) throw new Error(data?.message || 'API returned an error.');

    const r = data.result || data.data || data;

    const title  = r.title  || r.song  || r.name  || query;
    const artist = r.artist || r.singer || r.by   || '';
    const lyrics = r.lyrics || r.lirik  || r.content || '';

    if (!lyrics) throw new Error('No lyrics found for this song.');

    // Trim lyrics to WhatsApp message limit (~4000 chars)
    const MAX = 3800;
    const lyricsText = lyrics.length > MAX
      ? lyrics.slice(0, MAX) + '\n\n_...lyrics truncated_'
      : lyrics;

    let text = `🎵 *${title}*`;
    if (artist) text += `\n🎤 *Artist:* ${artist}`;
    text += `\n${'─'.repeat(30)}\n\n${lyricsText}`;
    text += `\n\n${'─'.repeat(30)}\n_Lyrics via ${title}_`;

    await sock.sendMessage(jid, { text }, { quoted: msg });

  } catch (err) {
    console.error('[LYRICS] error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Lyrics not found.*\n_${err.message}_\n\nTry a different song title or spelling.`,
    }, { quoted: msg });
  }
}
