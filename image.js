/**
 * !img / !image / !gimg — Web image search
 *
 * Scrapes Bing image search (no API key needed) for the user's query
 * and sends back a few images. Picks up to 4 random results from the
 * first page so each search feels different.
 */

import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function searchBing(query) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent':      UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15_000,
  });

  // Bing returns HTML containing `murl&quot;:&quot;<URL>&quot;` for each result
  const html = String(res.data);
  const matches = [...html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g)];

  const urls = matches
    .map(m => m[1])
    .filter(u => /\.(jpe?g|png|webp)(\?|$)/i.test(u));

  // dedupe
  return [...new Set(urls)];
}

async function downloadImage(url) {
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout:      15_000,
      headers:      { 'User-Agent': UA, 'Referer': 'https://www.bing.com/' },
      maxContentLength: 8 * 1024 * 1024,
    });
    const buf = Buffer.from(r.data);
    if (buf.length < 1000) return null;
    return buf;
  } catch {
    return null;
  }
}

export async function handleImage(sock, msg, query) {
  const jid = msg.key.remoteJid;

  if (!query || query.trim().length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:* !img <search>\n\nExamples:\n  !img sunset over Lagos\n  !img cute puppies`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: `🔍 Searching images for: *${query.trim()}*...` });

    const urls = await searchBing(query.trim());
    if (urls.length === 0) {
      await sock.sendMessage(jid, { text: `❌ No images found for *"${query}"*` });
      return;
    }

    // Shuffle and pick up to 4
    const shuffled = urls.sort(() => Math.random() - 0.5);
    const want     = Math.min(4, shuffled.length);

    let sent = 0;
    for (const url of shuffled) {
      if (sent >= want) break;
      const buf = await downloadImage(url);
      if (!buf) continue;
      try {
        await sock.sendMessage(jid, {
          image:   buf,
          caption: sent === 0 ? `🖼️ *${query.trim()}*\n_${sent + 1} of ${want}_` : `_${sent + 1} of ${want}_`,
        }, { quoted: sent === 0 ? msg : undefined });
        sent++;
      } catch {
        // Skip broken images, try next
      }
    }

    if (sent === 0) {
      await sock.sendMessage(jid, { text: `❌ Couldn't fetch any usable images. Try a different search.` });
    }
  } catch (err) {
    console.error('Image search error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Image search failed.\n_${err.message}_`,
    });
  }
}
