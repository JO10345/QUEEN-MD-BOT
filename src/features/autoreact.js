/**
 * Auto-React Feature — reacts with a random emoji.
 * Independent toggles for PM (DMs) and Group chats.
 *
 * Owner commands:
 *   !autoreact          → show status
 *   !autoreact pm on/off
 *   !autoreact group on/off
 *   !autoreact on/off   → toggle BOTH
 */

let pmEnabled    = process.env.AUTOREACT_PM_ENABLED    !== 'false'; // default ON
let groupEnabled = process.env.AUTOREACT_GROUP_ENABLED === 'true';  // default OFF

const DEFAULT_EMOJIS = [
  '❤️', '👍', '😂', '😮', '😢', '😡',
  '🙏', '🔥', '🎉', '💯', '👏', '✅',
  '😍', '🤣', '💪', '⭐', '🥰', '😊',
];

function getReactEmojis() {
  const raw = (process.env.AUTOREACT_EMOJIS || '').trim();
  if (!raw) return DEFAULT_EMOJIS;
  return raw.split(',').map(e => e.trim()).filter(Boolean);
}

function randomEmoji() {
  const pool = getReactEmojis();
  return pool[Math.floor(Math.random() * pool.length)];
}

export function isAutoReactPmEnabled()    { return pmEnabled; }
export function isAutoReactGroupEnabled() { return groupEnabled; }
export function setAutoReactPm(v)    { pmEnabled    = Boolean(v); }
export function setAutoReactGroup(v) { groupEnabled = Boolean(v); }

// Backward-compat helpers (toggle both at once)
export function isAutoReactEnabled() { return pmEnabled || groupEnabled; }
export function setAutoReact(v) {
  pmEnabled    = Boolean(v);
  groupEnabled = Boolean(v);
}

/**
 * Send a reaction. Works for both DMs and groups.
 */
export async function handleAutoReact(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid) return false;

  const isGroup = jid.endsWith('@g.us');
  const isPm    = jid.endsWith('@s.whatsapp.net');

  if (isGroup && !groupEnabled) return false;
  if (isPm    && !pmEnabled)    return false;
  if (!isGroup && !isPm)        return false;

  if (!msg.key.id) return false;

  try {
    const reactKey = {
      remoteJid: msg.key.remoteJid,
      fromMe:    msg.key.fromMe ?? false,
      id:        msg.key.id,
    };
    if (msg.key.participant) reactKey.participant = msg.key.participant;

    await sock.sendMessage(jid, {
      react: { text: randomEmoji(), key: reactKey },
    });
    return true;
  } catch (err) {
    console.error('AutoReact error:', err.message);
    return false;
  }
}
