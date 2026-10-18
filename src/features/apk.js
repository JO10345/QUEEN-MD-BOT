/**
 * APK Search + Download
 * API: https://eliteprotech-apis.zone.id/apk?q=<query>
 *
 * Response shape:
 *   { status, query, total, count, results: [
 *     { id, name, package, uname, size, icon, file: { vername, filesize, path }, stats, developer }
 *   ]}
 *
 * Commands:
 *   !apk <query>    — search and list results
 *   !apkdl <num>    — download APK from last search (if < 95 MB)
 */

import axios from 'axios';

const APK_API  = 'https://eliteprotech-apis.zone.id/apk';
const MAX_SIZE = 95 * 1024 * 1024; // 95 MB — WhatsApp limit is ~100 MB

// Per-chat last search results: jid → [{ name, version, filesize, downloadUrl, package }]
const lastSearch = new Map();

function formatMB(bytes) {
  return bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : 'Unknown';
}

export async function handleApkSearch(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const query = (args || '').trim();

  if (!query) {
    return sock.sendMessage(jid, {
      text:
        `❌ *Usage:*\n` +
        `  !apk <app name>    — search APK\n` +
        `  !apkdl <number>    — download from results\n\n` +
        `Example: !apk WhatsApp`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, {
    text: `🔍 *Searching APK for:* _${query}_...`,
  }, { quoted: msg });

  try {
    const { data } = await axios.get(APK_API, {
      params:  { q: query },
      timeout: 20_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const results = Array.isArray(data?.results) ? data.results : [];

    if (!results.length) {
      return sock.sendMessage(jid, {
        text: `❌ *No APK found for:* _${query}_`,
      }, { quoted: msg });
    }

    const top = results.slice(0, 6);

    // Store for !apkdl
    lastSearch.set(jid, top.map(app => ({
      name:        app.name || 'Unknown',
      version:     app.file?.vername || 'Unknown',
      filesize:    app.file?.filesize || app.size || 0,
      downloadUrl: app.file?.path    || app.file?.path_alt || '',
      package:     app.package || '',
      developer:   app.developer?.name || '',
    })));

    let text = `📦 *APK Search Results*\nQuery: _${query}_  ·  Total: ${data.total || results.length}\n\n`;

    top.forEach((app, i) => {
      const name      = app.name || 'Unknown App';
      const version   = app.file?.vername || 'N/A';
      const filesize  = app.file?.filesize || app.size || 0;
      const sizeMB    = formatMB(filesize);
      const dev       = app.developer?.name || '';
      const rating    = app.stats?.rating?.avg || app.stats?.prating?.avg || '';
      const canDl     = filesize > 0 && filesize < MAX_SIZE && app.file?.path;

      text += `*${i + 1}. ${name}*\n`;
      if (dev)     text += `   👨‍💻 ${dev}\n`;
      text += `   📌 v${version}  ·  📦 ${sizeMB}\n`;
      if (rating)  text += `   ⭐ ${parseFloat(rating).toFixed(1)}/5\n`;
      text += `   📥 ${canDl ? 'Send *!apkdl ' + (i + 1) + '* to download' : '⚠️ Too large / unavailable'}\n\n`;
    });

    text += `_Use !apkdl <number> to download (max ~95 MB)_`;

    await sock.sendMessage(jid, { text }, { quoted: msg });

  } catch (err) {
    console.error('[APK] search error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *APK search failed.*\n_${err.message}_`,
    }, { quoted: msg });
  }
}

export async function handleApkDownload(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const num = parseInt((args || '').trim(), 10);

  const results = lastSearch.get(jid);
  if (!results?.length) {
    return sock.sendMessage(jid, {
      text: `❌ No recent search found. Use *!apk <query>* first.`,
    }, { quoted: msg });
  }

  if (!num || num < 1 || num > results.length) {
    return sock.sendMessage(jid, {
      text: `❌ *Usage:* !apkdl <number>\n\nPick a number from 1 to ${results.length}`,
    }, { quoted: msg });
  }

  const app = results[num - 1];

  if (!app.downloadUrl) {
    return sock.sendMessage(jid, {
      text: `❌ *No download URL* available for *${app.name}*.`,
    }, { quoted: msg });
  }

  if (app.filesize > MAX_SIZE) {
    return sock.sendMessage(jid, {
      text:
        `⚠️ *${app.name}* is *${formatMB(app.filesize)}* — too large for WhatsApp (limit ~95 MB).\n\n` +
        `📦 Package: \`${app.package}\`\n` +
        `🔗 Download manually from Google Play or APKPure.`,
    }, { quoted: msg });
  }

  await sock.sendMessage(jid, {
    text: `⬇️ *Downloading ${app.name} v${app.version}* (${formatMB(app.filesize)})\n_Please wait..._`,
  }, { quoted: msg });

  try {
    const res = await axios.get(app.downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer':    'https://aptoide.com/',
      },
    });

    const buffer  = Buffer.from(res.data);
    const sizeMB  = formatMB(buffer.length);
    const fileName = `${app.package || app.name.replace(/\s+/g, '_')}_${app.version}.apk`;

    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: 'application/vnd.android.package-archive',
      fileName,
      caption:  `📦 *${app.name}*\n📌 v${app.version}  ·  📦 ${sizeMB}\n👨‍💻 ${app.developer}`,
    }, { quoted: msg });

  } catch (err) {
    console.error('[APK] download error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ *Download failed.*\n_${err.message}_`,
    }, { quoted: msg });
  }
}
