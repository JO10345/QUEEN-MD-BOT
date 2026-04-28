/**
 * !update — fetches the latest version of the bot from a GitHub repo
 * and updates files in place. Owner only.
 *
 * Configure in .env:
 *   GITHUB_REPO=username/repository
 *   GITHUB_BRANCH=main          (optional, defaults to "main")
 *   GITHUB_TOKEN=ghp_xxx        (optional, only needed for private repos)
 *
 * Strategy (always tarball — git pull only updates changed files which
 * confused users who expected a full refresh):
 *   1. Download fresh tarball from GitHub.
 *   2. Extract to temp/update/.
 *   3. Auto-detect source root (handles repos that contain a `bot/` subdir).
 *   4. Copy ALL files using `cp -rT` (system command, never misses a file),
 *      preserving auth_info/, .env, node_modules/, package-lock.json.
 *   5. Restart so new code takes effect.
 */

import axios from 'axios';
import {
  existsSync, mkdirSync, rmSync, writeFileSync,
  readdirSync, statSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT  = join(__dirname, '../..');

// Files / folders that must NEVER be overwritten by an update
const PRESERVE = [
  'auth_info',
  '.env',
  'node_modules',
  'temp',
  '.git',
  'package-lock.json',
  'state.json',
];

/**
 * Recursively count files in a directory (excluding PRESERVE).
 */
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    if (PRESERVE.includes(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) n += countFiles(p);
    else n++;
  }
  return n;
}

/**
 * Pick the right source folder inside the extracted tarball.
 * Some users put the bot files at the repo root; others nest them
 * inside a `bot/` folder. Detect by looking for src/index.js.
 */
function detectSourceRoot(extracted) {
  if (existsSync(join(extracted, 'src', 'index.js'))) return extracted;
  if (existsSync(join(extracted, 'bot', 'src', 'index.js'))) return join(extracted, 'bot');
  // Last resort: scan one level deeper
  for (const entry of readdirSync(extracted)) {
    const p = join(extracted, entry);
    if (statSync(p).isDirectory() && existsSync(join(p, 'src', 'index.js'))) return p;
  }
  return extracted; // fallback
}

export async function handleUpdate(sock, msg) {
  const jid    = msg.key.remoteJid;
  const repo   = (process.env.GITHUB_REPO   || '').trim();
  const branch = (process.env.GITHUB_BRANCH || 'main').trim();
  const token  = (process.env.GITHUB_TOKEN  || '').trim();

  if (!repo) {
    await sock.sendMessage(jid, {
      text:
        '❌ *GITHUB_REPO* is not set in .env\n\n' +
        'Add this to your `.env` file:\n' +
        '```\nGITHUB_REPO=username/repository\nGITHUB_BRANCH=main\n```',
    }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, {
    text: `⏳ *Updating ${process.env.BOT_NAME || 'bot'}*\n\n📦 Repo: *${repo}*\n🌿 Branch: \`${branch}\`\n\n_Downloading fresh copy..._`,
  }, { quoted: msg });

  try {
    const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
    const tmpRoot   = join(BOT_ROOT, 'temp');
    const tarPath   = join(tmpRoot, 'update.tar.gz');
    const extractTo = join(tmpRoot, 'update');

    if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true });
    if (existsSync(extractTo)) rmSync(extractTo, { recursive: true, force: true });
    mkdirSync(extractTo, { recursive: true });

    const headers = { 'User-Agent': 'queen-md-bot' };
    if (token) headers.Authorization = `token ${token}`;

    // ── Download tarball ────────────────────────────────────────────────────
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      headers,
      maxRedirects: 5,
      maxContentLength: 200 * 1024 * 1024,
    });
    writeFileSync(tarPath, Buffer.from(res.data));

    // ── Extract (strip the GitHub auto-prefix dir) ──────────────────────────
    execSync(`tar -xzf "${tarPath}" -C "${extractTo}" --strip-components=1`, { timeout: 60_000 });

    // ── Detect where the actual bot files live in the repo ──────────────────
    const sourceRoot = detectSourceRoot(extractTo);
    const totalFiles = countFiles(sourceRoot);

    if (totalFiles === 0) {
      throw new Error('Repo appears empty or has no recognizable bot files.');
    }

    // ── Copy every entry except the PRESERVE list ───────────────────────────
    // Use system `cp -a` per entry — far more reliable than manual recursion,
    // preserves permissions, follows no symlinks weirdly, and never silently
    // skips files.
    let copied = 0;
    for (const entry of readdirSync(sourceRoot)) {
      if (PRESERVE.includes(entry)) continue;
      const src = join(sourceRoot, entry);
      const dst = join(BOT_ROOT, entry);
      try {
        // Remove existing dest first so we get a clean replace, then copy
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
        execSync(`cp -a "${src}" "${dst}"`, { timeout: 60_000 });
        copied++;
      } catch (e) {
        console.error(`Update: failed to copy ${entry}:`, e.message);
      }
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────
    try { rmSync(tarPath, { force: true }); } catch {}
    try { rmSync(extractTo, { recursive: true, force: true }); } catch {}

    // ── Report ──────────────────────────────────────────────────────────────
    await sock.sendMessage(jid, {
      text:
        `✅ *Update complete!*\n\n` +
        `📦 Repo: *${repo}*\n` +
        `🌿 Branch: \`${branch}\`\n` +
        `📁 Top-level items copied: *${copied}*\n` +
        `📝 Total files refreshed: *${totalFiles}*\n` +
        `💾 Preserved: \`auth_info\`, \`.env\`, \`node_modules\`, \`state.json\`\n\n` +
        `♻️ Restarting in 3s...\n\n` +
        `_If you started the bot manually, run \`node src/index.js\` again._\n` +
        `_If you use pm2/systemd, it will auto-restart._`,
    }, { quoted: msg });

    setTimeout(() => process.exit(0), 3000);
  } catch (err) {
    console.error('Update error:', err);
    await sock.sendMessage(jid, {
      text:
        `❌ *Update failed*\n\n_${err.message}_\n\n` +
        `Check that:\n` +
        `  • *GITHUB_REPO* is correct (\`username/repository\`)\n` +
        `  • Branch *${branch}* exists\n` +
        `  • Repo is public, OR set *GITHUB_TOKEN* in .env`,
    }, { quoted: msg });
  }
}
