/**
 * !update — fetches the latest version of the bot from a GitHub repo
 * and updates files in place. Owner only.
 *
 * Configure in .env:
 *   GITHUB_REPO=username/repository
 *   GITHUB_BRANCH=main          (optional, defaults to "main")
 *   GITHUB_TOKEN=ghp_xxx        (optional, only needed for private repos)
 *
 * Strategy:
 *   1. If a `.git` folder exists in the bot root, run `git pull`.
 *   2. Otherwise, download the tarball from GitHub, extract it,
 *      and copy the new files over (preserving auth_info/, .env, node_modules/).
 *   3. Restart the process so the new code takes effect.
 */

import axios from 'axios';
import {
  existsSync, mkdirSync, rmSync, copyFileSync,
  readdirSync, statSync, writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT  = join(__dirname, '../..');

// Files / folders that must NEVER be overwritten by an update
const PRESERVE = new Set([
  'auth_info',
  '.env',
  'node_modules',
  'temp',
  '.git',
  'package-lock.json',
]);

function copyRecursive(src, dest, count = { n: 0 }) {
  for (const entry of readdirSync(src)) {
    if (PRESERVE.has(entry)) continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
      copyRecursive(s, d, count);
    } else {
      copyFileSync(s, d);
      count.n++;
    }
  }
  return count.n;
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
    text: `⏳ Checking for updates from\n*${repo}* (branch: \`${branch}\`)...`,
  }, { quoted: msg });

  try {
    // ── Path 1: git pull (when a .git folder is present) ────────────────────
    if (existsSync(join(BOT_ROOT, '.git'))) {
      try {
        const out = execSync(
          `git -C "${BOT_ROOT}" pull origin ${branch}`,
          { encoding: 'utf8', timeout: 90_000 },
        );
        if (out.includes('Already up to date') || out.includes('Already up-to-date')) {
          await sock.sendMessage(jid, { text: '✅ Already up to date.' }, { quoted: msg });
          return;
        }
        await sock.sendMessage(jid, {
          text: `✅ *Updated via git!*\n\n\`\`\`${out.trim().slice(0, 600)}\`\`\`\n\n♻️ Restarting bot in 3s...`,
        }, { quoted: msg });
        setTimeout(() => process.exit(0), 3000);
        return;
      } catch {
        // git failed — fall through to tarball
      }
    }

    // ── Path 2: download tarball from GitHub ────────────────────────────────
    const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
    const tmpRoot   = join(BOT_ROOT, 'temp');
    const tarPath   = join(tmpRoot, 'update.tar.gz');
    const extractTo = join(tmpRoot, 'update');

    if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true });
    if (existsSync(extractTo)) rmSync(extractTo, { recursive: true, force: true });
    mkdirSync(extractTo, { recursive: true });

    const headers = {};
    if (token) headers.Authorization = `token ${token}`;

    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90_000,
      headers,
      maxRedirects: 5,
    });

    writeFileSync(tarPath, Buffer.from(res.data));
    execSync(`tar -xzf "${tarPath}" -C "${extractTo}" --strip-components=1`, { timeout: 60_000 });

    const fileCount = copyRecursive(extractTo, BOT_ROOT);

    // Cleanup
    try { rmSync(tarPath, { force: true }); } catch {}
    try { rmSync(extractTo, { recursive: true, force: true }); } catch {}

    await sock.sendMessage(jid, {
      text:
        `✅ *Update complete!*\n\n` +
        `📦 Repo: ${repo}\n` +
        `🌿 Branch: ${branch}\n` +
        `📝 Files updated: ${fileCount}\n\n` +
        `♻️ Restarting bot in 3s...\n` +
        `_If you started the bot manually, run \`node src/index.js\` again._`,
    }, { quoted: msg });

    setTimeout(() => process.exit(0), 3000);
  } catch (err) {
    console.error('Update error:', err);
    await sock.sendMessage(jid, {
      text: `❌ Update failed.\n_${err.message}_\n\nMake sure GITHUB_REPO and GITHUB_BRANCH are correct, and the repo is public (or set GITHUB_TOKEN).`,
    }, { quoted: msg });
  }
}
