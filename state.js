/**
 * Tiny JSON-file persistence for runtime toggles so they survive restarts.
 * File: bot/state.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '../../state.json');

let cache = null;

function load() {
  if (cache) return cache;
  if (!existsSync(STATE_FILE)) {
    cache = {};
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(cache || {}, null, 2));
  } catch (err) {
    console.error('state.save error:', err.message);
  }
}

export function getState(key, fallback) {
  const s = load();
  return key in s ? s[key] : fallback;
}

export function setState(key, value) {
  const s = load();
  s[key] = value;
  save();
}
