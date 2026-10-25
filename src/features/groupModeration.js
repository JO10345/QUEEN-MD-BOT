/**
 * Per-group timed mutes and admin-managed auto-delete watch lists.
 * State is kept in the bot's project directory so settings survive restarts.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../group-moderation.json');
const MAX_TIMER_MS = 2_147_000_000;
const RETRY_UNMUTE_MS = 60_000;
const timers = new Map();

function normalizeJid(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const jid = value.trim();
  const at = jid.lastIndexOf('@');
  return at < 0 ? jid.split(':')[0] : `${jid.slice(0, at).split(':')[0]}${jid.slice(at)}`;
}

function normalizeAliases(values) {
  const aliases = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    if (typeof value === 'string') {
      const jid = normalizeJid(value);
      if (jid) aliases.add(jid);
    } else if (value && typeof value === 'object') {
      for (const key of ['id', 'phoneNumber', 'lid', 'jid']) {
        const jid = normalizeJid(value[key]);
        if (jid) aliases.add(jid);
      }
    }
  }
  return [...aliases];
}

function newState() {
  return { timedMutes: {}, watchedMembers: {} };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return newState();
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      timedMutes: parsed?.timedMutes && typeof parsed.timedMutes === 'object'
        ? parsed.timedMutes
        : {},
      watchedMembers: parsed?.watchedMembers && typeof parsed.watchedMembers === 'object'
        ? parsed.watchedMembers
        : {},
    };
  } catch (error) {
    console.warn(`[GroupModeration] Could not read saved group settings: ${error.message}`);
    return newState();
  }
}

const state = loadState();

function saveState() {
  const temporaryFile = `${STATE_FILE}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporaryFile, STATE_FILE);
}

function timerFor(sock, groupJid, until) {
  const existing = timers.get(groupJid);
  if (existing) clearTimeout(existing);

  const run = async () => {
    const current = state.timedMutes[groupJid];
    if (!current || current.until !== until) return;

    const remaining = until - Date.now();
    if (remaining > 0) {
      const timer = setTimeout(run, Math.min(remaining, MAX_TIMER_MS));
      timer.unref?.();
      timers.set(groupJid, timer);
      return;
    }

    try {
      await sock.groupSettingUpdate(groupJid, 'not_announcement');
      delete state.timedMutes[groupJid];
      timers.delete(groupJid);
      try {
        saveState();
      } catch (error) {
        console.error(`[GroupModeration] Could not save mute expiry for ${groupJid}: ${error.message}`);
      }
      try {
        await sock.sendMessage(groupJid, { text: '🔊 The timed mute has ended — everyone can send messages again.' });
      } catch {}
      console.log(`[GroupModeration] Timed mute expired for ${groupJid}`);
    } catch (error) {
      console.warn(`[GroupModeration] Could not unmute ${groupJid}; retrying: ${error.message}`);
      const retry = setTimeout(run, RETRY_UNMUTE_MS);
      retry.unref?.();
      timers.set(groupJid, retry);
    }
  };

  const timer = setTimeout(run, Math.min(Math.max(0, until - Date.now()), MAX_TIMER_MS));
  timer.unref?.();
  timers.set(groupJid, timer);
}

export function setTimedGroupMute(sock, groupJid, durationMs) {
  const previous = timers.get(groupJid);
  if (previous) clearTimeout(previous);
  timers.delete(groupJid);

  if (durationMs > 0) {
    const until = Date.now() + durationMs;
    state.timedMutes[groupJid] = { until };
    saveState();
    timerFor(sock, groupJid, until);
    return until;
  }

  delete state.timedMutes[groupJid];
  saveState();
  return null;
}

export function clearTimedGroupMute(groupJid) {
  const timer = timers.get(groupJid);
  if (timer) clearTimeout(timer);
  timers.delete(groupJid);
  delete state.timedMutes[groupJid];
  saveState();
}

export function restoreTimedGroupMutes(sock) {
  for (const [groupJid, record] of Object.entries(state.timedMutes)) {
    const until = Number(record?.until);
    if (!Number.isFinite(until)) {
      delete state.timedMutes[groupJid];
      continue;
    }
    timerFor(sock, groupJid, until);
  }
  saveState();
}

export function addWatchedMember(groupJid, target) {
  const aliases = normalizeAliases(target);
  if (!groupJid || !aliases.length) throw new Error('No valid group member ID was provided');

  const entries = state.watchedMembers[groupJid] || [];
  const alreadyWatched = entries.some(entry =>
    normalizeAliases(entry).some(alias => aliases.includes(alias)),
  );
  if (!alreadyWatched) entries.push(aliases);
  state.watchedMembers[groupJid] = entries;
  saveState();
  return { added: !alreadyWatched, count: entries.length };
}

export function removeWatchedMember(groupJid, target) {
  const aliases = normalizeAliases(target);
  const entries = state.watchedMembers[groupJid] || [];
  const remaining = entries.filter(entry =>
    !normalizeAliases(entry).some(alias => aliases.includes(alias)),
  );
  const removed = entries.length - remaining.length;
  if (remaining.length) state.watchedMembers[groupJid] = remaining;
  else delete state.watchedMembers[groupJid];
  saveState();
  return { removed, count: remaining.length };
}

export function getWatchedMembers(groupJid) {
  return (state.watchedMembers[groupJid] || []).map(entry => [...entry]);
}

export function isWatchedGroupMessage(groupJid, msg) {
  if (!groupJid?.endsWith('@g.us') || msg.key?.fromMe) return false;
  const senderAliases = normalizeAliases([
    msg.key?.participant,
    msg.key?.participantAlt,
  ]);
  if (!senderAliases.length) return false;
  return (state.watchedMembers[groupJid] || []).some(entry =>
    normalizeAliases(entry).some(alias => senderAliases.includes(alias)),
  );
}

export async function deleteWatchedMessage(sock, msg) {
  const groupJid = msg.key?.remoteJid;
  if (!isWatchedGroupMessage(groupJid, msg)) return false;
  try {
    await sock.sendMessage(groupJid, { delete: msg.key });
    console.log(`[GroupModeration] Deleted watched-member message in ${groupJid}`);
  } catch (error) {
    console.warn(`[GroupModeration] Could not delete watched-member message in ${groupJid}: ${error.message}`);
  }
  return true;
}
