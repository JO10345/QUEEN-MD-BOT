/**
 * Cute extras: ship/love calculator, random fact, compliment, truth/dare,
 * dice roll, coin flip, 8-ball.
 */

import axios from 'axios';

// ─── Ship / Love ──────────────────────────────────────────────────────────────
function shipPercent(a, b) {
  // Deterministic-ish: hash both names so same pair gives same result
  const s = (a + '❤️' + b).toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 101; // 0 — 100
}

function shipBar(p) {
  const filled = Math.round(p / 10);
  return '💗'.repeat(filled) + '🤍'.repeat(10 - filled);
}

function shipVerdict(p) {
  if (p >= 90) return '💞 *Soulmates!* A match made in heaven.';
  if (p >= 75) return '💖 *Perfect match!* Wedding bells are ringing.';
  if (p >= 60) return '💕 *Great chemistry!* Worth a serious shot.';
  if (p >= 40) return '💛 *Friendly vibes.* Could grow into more.';
  if (p >= 20) return '🤔 *Hmm...* Mostly just friends.';
  return '💔 *Yikes.* Better off as strangers.';
}

export async function handleShip(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const parts = (args || '').split(/\s*[,&]\s*|\s+vs\s+|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:* !ship <name1> <name2>\nExamples:\n  !ship Alice Bob\n  !ship Romeo, Juliet`,
    }, { quoted: msg });
    return;
  }
  const [a, b] = parts;
  const p = shipPercent(a, b);
  const text =
    `💘 *Love Calculator* 💘\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `   *${a}*  ❤️  *${b}*\n\n` +
    `        *${p}%*\n` +
    `   ${shipBar(p)}\n\n` +
    `${shipVerdict(p)}`;
  await sock.sendMessage(jid, { text }, { quoted: msg });
}

// ─── Random Fact ──────────────────────────────────────────────────────────────
export async function handleFact(sock, msg) {
  const jid = msg.key.remoteJid;
  try {
    const res = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en', { timeout: 10_000 });
    const fact = res.data?.text || 'A fact escaped me. Try again!';
    await sock.sendMessage(jid, { text: `🧠 *Did You Know?*\n\n${fact}` }, { quoted: msg });
  } catch {
    const fallbacks = [
      'Honey never spoils — archaeologists have eaten 3000-year-old honey from Egyptian tombs.',
      'Octopuses have three hearts and blue blood.',
      'A day on Venus is longer than its year.',
      'Bananas are berries, but strawberries are not.',
      'Wombat poop is cube-shaped.',
    ];
    const fact = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    await sock.sendMessage(jid, { text: `🧠 *Did You Know?*\n\n${fact}` }, { quoted: msg });
  }
}

// ─── Compliment ───────────────────────────────────────────────────────────────
const COMPLIMENTS = [
  'Your smile is contagious — even pixels light up around you. ✨',
  'You have a brain that solves puzzles, a heart that solves problems. 💫',
  'You make ordinary moments feel cinematic. 🎬',
  'The world is 0.001% kinder because you exist in it. 🌍',
  'You are the plot twist nobody saw coming. 🌀',
  'Your vibe could power a small village. ⚡',
  'You bring energy that makes Mondays feel like Fridays. 🎉',
  'Your potential is a sleeping dragon — and it just yawned. 🐉',
  'You are proof that beautiful chaos exists. 🌪️',
  'Even your shadow walks proud. 🕶️',
];

export async function handleCompliment(sock, msg) {
  const jid = msg.key.remoteJid;
  const c   = COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
  await sock.sendMessage(jid, { text: `🌹 *A little something for you* 🌹\n\n${c}` }, { quoted: msg });
}

// ─── Truth / Dare ─────────────────────────────────────────────────────────────
const TRUTHS = [
  'What is the most embarrassing song on your playlist?',
  'What is one lie you have told that you got away with?',
  'Who was your first crush and why?',
  'What is your most irrational fear?',
  "What's the weirdest thing you've eaten?",
  'If your phone history was made public, what would surprise people the most?',
  'What is the silliest thing you cried about as an adult?',
  'What is one thing you have never told your parents?',
  "What's the worst gift you've ever received?",
  'Who in this chat would you swap lives with for a day?',
];

const DARES = [
  'Send the last selfie you took. 📸',
  'Voice-note your worst impression of a celebrity. 🎤',
  'Text your crush "I had a dream about you" — show the reply.',
  'Post a 🐧 emoji as your status for 1 hour.',
  "Send a screenshot of your most-used app's home screen.",
  'Read your last text aloud in a posh British accent. 🎩',
  'Do 10 jumping jacks and send a video. 🤸',
  'Send the 7th photo in your gallery (no skipping!).',
  'Compose a haiku about the person above you in the chat.',
  'Change your bio to "Bot-controlled human" for 24 hours. 🤖',
];

export async function handleTruth(sock, msg) {
  const jid = msg.key.remoteJid;
  const t = TRUTHS[Math.floor(Math.random() * TRUTHS.length)];
  await sock.sendMessage(jid, { text: `🎭 *Truth*\n\n${t}` }, { quoted: msg });
}

export async function handleDare(sock, msg) {
  const jid = msg.key.remoteJid;
  const d = DARES[Math.floor(Math.random() * DARES.length)];
  await sock.sendMessage(jid, { text: `🔥 *Dare*\n\n${d}` }, { quoted: msg });
}

// ─── Dice / Coin ──────────────────────────────────────────────────────────────
export async function handleDice(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const sides = Math.max(2, Math.min(1000, parseInt(args) || 6));
  const roll  = Math.floor(Math.random() * sides) + 1;
  const faces = ['⚀','⚁','⚂','⚃','⚄','⚅'];
  const face  = sides === 6 ? faces[roll - 1] : '🎲';
  await sock.sendMessage(jid, {
    text: `🎲 *Dice Roll*\n${face}  *${roll}* / ${sides}`,
  }, { quoted: msg });
}

export async function handleCoin(sock, msg) {
  const jid = msg.key.remoteJid;
  const r = Math.random() < 0.5 ? { face: '🪙 *HEADS*', emoji: '👑' } : { face: '🪙 *TAILS*', emoji: '🦅' };
  await sock.sendMessage(jid, { text: `${r.emoji} ${r.face}` }, { quoted: msg });
}

// ─── Magic 8-Ball ─────────────────────────────────────────────────────────────
const EIGHT_BALL = [
  'It is certain. ✨', 'Without a doubt. 💯', 'Yes, definitely. 👍', 'You may rely on it. 🤝',
  'As I see it, yes. 👀', 'Most likely. 🌟', 'Outlook good. ☀️', 'Signs point to yes. ➡️',
  'Reply hazy, try again. 🌫️', 'Ask again later. ⏳', 'Better not tell you now. 🤐',
  'Cannot predict now. 🔮', 'Concentrate and ask again. 🧘',
  "Don't count on it. 🚫", 'My reply is no. ❌', 'My sources say no. 📚',
  'Outlook not so good. 🌧️', 'Very doubtful. 😬',
];

export async function handle8ball(sock, msg, args) {
  const jid = msg.key.remoteJid;
  if (!args || !args.includes('?')) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:* !8ball <your question>?\n\nExample: *!8ball will I be rich?*`,
    }, { quoted: msg });
    return;
  }
  const ans = EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)];
  await sock.sendMessage(jid, {
    text: `🎱 *Magic 8-Ball*\n\n_"${args}"_\n\n${ans}`,
  }, { quoted: msg });
}

// ─── Hug / Pat (cute interaction) ─────────────────────────────────────────────
export async function handleHug(sock, msg, args) {
  const jid = msg.key.remoteJid;
  const target = (args || '').trim() || 'you';
  await sock.sendMessage(jid, {
    text: `🤗 *Sending warm hugs to ${target}* 🤗\n\n     (づ｡◕‿‿◕｡)づ ♡`,
  }, { quoted: msg });
}
