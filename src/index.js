import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  isJidStatusBroadcast,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import axios from 'axios';

// ── Existing features ────────────────────────────────────────────────────────
import { handleMusic }              from './features/music.js';
import { handleYouTube }            from './features/youtube.js';
import { handleWeather }            from './features/weather.js';
import { handleAI, clearAIHistory } from './features/ai.js';
import { findAutoreply }            from './features/autoreplies.js';
import {
  applyBotCustomization,
  setBotImage,
  setBotImageFromMessage,
  getBotInfoCard,
} from './features/customize.js';
import {
  handleAutoReact,
  isAutoReactPmEnabled,
  isAutoReactGroupEnabled,
  setAutoReactPm,
  setAutoReactGroup,
  setAutoReact,
} from './features/autoreact.js';
import {
  handleChatbot,
  isChatbotPmEnabled,
  isChatbotGroupEnabled,
  setChatbotPm,
  setChatbotGroup,
  clearChatbotHistory,
} from './features/chatbot.js';
import { handleUpdate } from './features/update.js';

// ── New features ─────────────────────────────────────────────────────────────
import { handleSticker }      from './features/sticker.js';
import { handleTranslate }    from './features/translate.js';
import { handleGroup }        from './features/group.js';
import { handleReminder }     from './features/reminder.js';
import { handleImagine }      from './features/imagine.js';
import { handleCalculator }   from './features/calculator.js';
import { handleCurrency }     from './features/currency.js';
import { handleNews }         from './features/news.js';
import { handleQuote, handleJoke } from './features/fun.js';
import {
  handlePoll,
  handleVote,
  handlePollResults,
  handleEndPoll,
} from './features/poll.js';
import {
  handleQuiz,
  handleAnswer,
  handleQuizStats,
  handleQuizTop,
  handleEndQuiz,
} from './features/quiz.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────
const PREFIX       = process.env.PREFIX       || '!';
const BOT_NAME     = process.env.BOT_NAME     || 'Queen MD Bot';
const OWNER_NUMBER = process.env.OWNER_NUMBER || '';
const DEBUG        = process.env.DEBUG === 'true';

const FEATURES = {
  music:     process.env.MUSIC_ENABLED     !== 'false',
  youtube:   process.env.YOUTUBE_ENABLED   !== 'false',
  weather:   process.env.WEATHER_ENABLED   !== 'false',
  ai:        process.env.AI_ENABLED        !== 'false',
  sticker:   process.env.STICKER_ENABLED   !== 'false',
  translate: process.env.TRANSLATE_ENABLED !== 'false',
  group:     process.env.GROUP_ENABLED     !== 'false',
  reminder:  process.env.REMINDER_ENABLED  !== 'false',
  imagine:   process.env.IMAGINE_ENABLED   !== 'false',
  calc:      process.env.CALC_ENABLED      !== 'false',
  currency:  process.env.CURRENCY_ENABLED  !== 'false',
  news:      process.env.NEWS_ENABLED      !== 'false',
  fun:       process.env.FUN_ENABLED       !== 'false',
  poll:      process.env.POLL_ENABLED      !== 'false',
  quiz:      process.env.QUIZ_ENABLED      !== 'false',
};

// ─── Directories ──────────────────────────────────────────────────────────────
const AUTH_DIR = join(__dirname, '../auth_info');
const TEMP_DIR = join(__dirname, '../temp');
if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Phone number resolution ──────────────────────────────────────────────────
let resolvedPhone = '';

async function resolvePhoneNumber() {
  if (resolvedPhone) return resolvedPhone;

  const fromEnv = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
  if (fromEnv) { resolvedPhone = fromEnv; return resolvedPhone; }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    console.log('\n┌──────────────────────────────────────────────┐');
    console.log('│       👑 Queen MD Bot — First Time Setup     │');
    console.log('├──────────────────────────────────────────────┤');
    console.log('│  Enter the number you want to link the bot   │');
    console.log('│  to. Country code + number, no + or spaces.  │');
    console.log('│  e.g.  2348012345678  /  447911123456        │');
    console.log('└──────────────────────────────────────────────┘');
    rl.question('\n  📱 Phone number: ', answer => {
      rl.close();
      resolvedPhone = answer.replace(/[^0-9]/g, '');
      resolve(resolvedPhone);
    });
  });
}

// ─── Extract text from any WhatsApp message format ───────────────────────────
function getBody(msg) {
  const m = msg?.message;
  if (!m) return '';
  const inner =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message  ||
    m.viewOnceMessageV2?.message ||
    m;

  return (
    inner.conversation                                            ||
    inner.extendedTextMessage?.text                              ||
    inner.imageMessage?.caption                                  ||
    inner.videoMessage?.caption                                  ||
    inner.documentMessage?.caption                               ||
    inner.buttonsResponseMessage?.selectedButtonId               ||
    inner.listResponseMessage?.singleSelectReply?.selectedRowId  ||
    inner.templateButtonReplyMessage?.selectedId                 ||
    ''
  ).trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isOwner(jid) {
  if (!OWNER_NUMBER) return false;
  return jid.replace(/[^0-9]/g, '').includes(OWNER_NUMBER.replace(/[^0-9]/g, ''));
}

function isGroupAdmin(meta, jid) {
  const num = jid.split('@')[0];
  return meta.participants.some(
    p => (p.id === jid || p.id.startsWith(num)) && p.admin
  );
}

// ─── Build help text ──────────────────────────────────────────────────────────
function buildHelpText() {
  const P = PREFIX;
  const lines = [
    `╔══════════════════════════╗\n`,
    `║    👑 *${BOT_NAME}*\n`,
    `╠══════════════════════════╣\n`,
    `║  🛠️ *Created by:* TECH\n`,
    `║  👤 *Owner:* fizu\n`,
    `╚══════════════════════════╝\n`,
    `━━━━━━━━━━━━━━━━━━━━━━━\n`,
  ];

  if (FEATURES.music)     lines.push(`🎵 *Music*\n${P}music <song> | ${P}mp3 <song>\n`);
  if (FEATURES.youtube)   lines.push(`📹 *YouTube*\n${P}yt <link or search>\n`);
  if (FEATURES.weather)   lines.push(`🌤️ *Weather*\n${P}weather <city> | ${P}w <city>\n`);
  if (FEATURES.ai)        lines.push(`🤖 *AI Chat*\n${P}ai <question> | ${P}ask | ${P}chat\n${P}clear — reset memory\n`);
  if (FEATURES.sticker)   lines.push(`🖼️ *Sticker*\n${P}sticker — send image with caption\n`);
  if (FEATURES.translate) lines.push(`🌐 *Translate*\n${P}translate <lang> <text>\n_e.g. ${P}translate es Hello_\n`);
  if (FEATURES.group)     lines.push(`👥 *Group (admin)*\n${P}kick | ${P}add | ${P}promote | ${P}demote\n${P}tagall | ${P}mute | ${P}unmute | ${P}groupinfo\n`);
  if (FEATURES.reminder)  lines.push(`⏰ *Reminder*\n${P}remind <time> <text>\n_e.g. ${P}remind 10m Check oven_\n`);
  if (FEATURES.imagine)   lines.push(`🎨 *AI Image*\n${P}imagine <description>\n`);
  if (FEATURES.calc)      lines.push(`🧮 *Calculator*\n${P}calc <expression>\n_e.g. ${P}calc 15% of 200_\n`);
  if (FEATURES.currency)  lines.push(`💱 *Currency*\n${P}convert <amount> <from> <to>\n_e.g. ${P}convert 100 USD NGN_\n`);
  if (FEATURES.news)      lines.push(`📰 *News*\n${P}news [country/topic]\n_e.g. ${P}news ng | ${P}news bitcoin_\n`);
  if (FEATURES.fun)       lines.push(`😄 *Fun*\n${P}quote — random quote\n${P}joke — random joke\n`);
  if (FEATURES.poll)      lines.push(`📊 *Poll*\n${P}poll Q | Opt1 | Opt2\n${P}vote <n> | ${P}pollresults | ${P}endpoll\n`);
  if (FEATURES.quiz)      lines.push(`🧠 *Quiz*\n${P}quiz [topic] — start a question\n${P}answer A/B/C/D — submit answer\n${P}quizstats | ${P}quiztop | ${P}endquiz\nTopics: general, science, history, sports, music, movies, geography, computers\n`);

  const arPm = isAutoReactPmEnabled()    ? '🟢' : '🔴';
  const arGr = isAutoReactGroupEnabled() ? '🟢' : '🔴';
  const cbPm = isChatbotPmEnabled()      ? '🟢' : '🔴';
  const cbGr = isChatbotGroupEnabled()   ? '🟢' : '🔴';

  lines.push(
    `ℹ️ *General*\n` +
    `${P}ping | ${P}botinfo | ${P}help\n\n` +
    `💬 *Auto-React*  PM:${arPm}  Group:${arGr}\n` +
    `${P}autoreact pm on/off\n${P}autoreact group on/off\n\n` +
    `🤖 *Chatbot (AI auto-reply)*  PM:${cbPm}  Group:${cbGr}\n` +
    `${P}chatbot pm on/off\n${P}chatbot group on/off\n${P}chatbot reset\n` +
    `_In groups, replies only when @mentioned or replied-to._\n\n` +
    `👑 *Owner Only*\n` +
    `${P}setppbot — change profile pic\n` +
    `${P}setbio <text> — change bio\n` +
    `${P}update — pull latest from GitHub\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Powered by ${BOT_NAME}_`
  );
  return lines.join('\n');
}

// ─── Send help menu ───────────────────────────────────────────────────────────
async function sendHelpMenu(sock, jid, msg) {
  const helpText    = buildHelpText();
  const botImageUrl = process.env.BOT_IMAGE_URL || '';

  if (botImageUrl) {
    try {
      const res = await axios.get(botImageUrl, { responseType: 'arraybuffer', timeout: 10_000 });
      await sock.sendMessage(jid, {
        image:   Buffer.from(res.data),
        caption: helpText,
      }, { quoted: msg });
      return;
    } catch { /* fall through to text */ }
  }
  await sock.sendMessage(jid, { text: helpText }, { quoted: msg });
}

// ─── Route a command ──────────────────────────────────────────────────────────
async function handleCommand(sock, msg, jid, sender, cmd, args, hasImg) {
  const owner = isOwner(sender);

  // ── General ──────────────────────────────────────────────────────────────
  switch (cmd) {

    case 'help':
    case 'commands':
    case 'menu':
      await sendHelpMenu(sock, jid, msg);
      return;

    case 'ping':
      await sock.sendMessage(jid, { text: `🏓 Pong! *${BOT_NAME}* is alive and online.` }, { quoted: msg });
      return;

    case 'botinfo':
    case 'info':
      await sock.sendMessage(jid, { text: getBotInfoCard() }, { quoted: msg });
      return;

    case 'clear':
    case 'reset':
      clearAIHistory(sender);
      await sock.sendMessage(jid, { text: '✅ AI memory cleared.' }, { quoted: msg });
      return;
  }

  // ── Music ─────────────────────────────────────────────────────────────────
  if (cmd === 'music' || cmd === 'mp3') {
    if (!FEATURES.music) { await sock.sendMessage(jid, { text: '❌ Music feature is disabled.' }); return; }
    if (!args)           { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}music <song name>*` }); return; }
    await handleMusic(sock, msg, args);
    return;
  }

  // ── YouTube ───────────────────────────────────────────────────────────────
  if (cmd === 'yt' || cmd === 'youtube') {
    if (!FEATURES.youtube) { await sock.sendMessage(jid, { text: '❌ YouTube feature is disabled.' }); return; }
    if (!args)             { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}yt <URL or search query>*` }); return; }
    await handleYouTube(sock, msg, args);
    return;
  }

  // ── Weather ───────────────────────────────────────────────────────────────
  if (cmd === 'weather' || cmd === 'w') {
    if (!FEATURES.weather) { await sock.sendMessage(jid, { text: '❌ Weather feature is disabled.' }); return; }
    if (!args)             { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}weather <city>*` }); return; }
    await handleWeather(sock, msg, args);
    return;
  }

  // ── AI Chat ───────────────────────────────────────────────────────────────
  if (cmd === 'ai' || cmd === 'ask' || cmd === 'chat') {
    if (!FEATURES.ai) { await sock.sendMessage(jid, { text: '❌ AI feature is disabled.' }); return; }
    if (!args)        { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}ai <your question>*` }); return; }
    await handleAI(sock, msg, args);
    return;
  }

  // ── Sticker ───────────────────────────────────────────────────────────────
  if (cmd === 'sticker' || cmd === 's') {
    if (!FEATURES.sticker) { await sock.sendMessage(jid, { text: '❌ Sticker feature is disabled.' }); return; }
    await handleSticker(sock, msg);
    return;
  }

  // ── Translate ─────────────────────────────────────────────────────────────
  if (cmd === 'translate' || cmd === 'tr') {
    if (!FEATURES.translate) { await sock.sendMessage(jid, { text: '❌ Translate feature is disabled.' }); return; }
    if (!args)               { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}translate <lang> <text>*\nExample: *${PREFIX}translate es Hello*` }); return; }
    await handleTranslate(sock, msg, args);
    return;
  }

  // ── Group Management ──────────────────────────────────────────────────────
  if (['kick','add','promote','demote','tagall','groupinfo','mute','unmute'].includes(cmd)) {
    if (!FEATURES.group) { await sock.sendMessage(jid, { text: '❌ Group feature is disabled.' }); return; }
    await handleGroup(sock, msg, cmd, args, OWNER_NUMBER);
    return;
  }

  // ── Reminder ──────────────────────────────────────────────────────────────
  if (cmd === 'remind' || cmd === 'reminder') {
    if (!FEATURES.reminder) { await sock.sendMessage(jid, { text: '❌ Reminder feature is disabled.' }); return; }
    if (!args)              { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}remind <time> <message>*\nExample: *${PREFIX}remind 10m Check oven*` }); return; }
    await handleReminder(sock, msg, args);
    return;
  }

  // ── AI Image Generation ───────────────────────────────────────────────────
  if (cmd === 'imagine' || cmd === 'image' || cmd === 'gen') {
    if (!FEATURES.imagine) { await sock.sendMessage(jid, { text: '❌ Image generation is disabled.' }); return; }
    await handleImagine(sock, msg, args);
    return;
  }

  // ── Calculator ────────────────────────────────────────────────────────────
  if (cmd === 'calc' || cmd === 'calculate' || cmd === 'math') {
    if (!FEATURES.calc) { await sock.sendMessage(jid, { text: '❌ Calculator is disabled.' }); return; }
    await handleCalculator(sock, msg, args);
    return;
  }

  // ── Currency Converter ────────────────────────────────────────────────────
  if (cmd === 'convert' || cmd === 'currency' || cmd === 'fx') {
    if (!FEATURES.currency) { await sock.sendMessage(jid, { text: '❌ Currency converter is disabled.' }); return; }
    if (!args)              { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}convert 100 USD NGN*` }); return; }
    await handleCurrency(sock, msg, args);
    return;
  }

  // ── News ──────────────────────────────────────────────────────────────────
  if (cmd === 'news' || cmd === 'headlines') {
    if (!FEATURES.news) { await sock.sendMessage(jid, { text: '❌ News feature is disabled.' }); return; }
    await handleNews(sock, msg, args);
    return;
  }

  // ── Quotes ────────────────────────────────────────────────────────────────
  if (cmd === 'quote' || cmd === 'q') {
    if (!FEATURES.fun) { await sock.sendMessage(jid, { text: '❌ Fun features are disabled.' }); return; }
    await handleQuote(sock, msg);
    return;
  }

  // ── Jokes ─────────────────────────────────────────────────────────────────
  if (cmd === 'joke' || cmd === 'j') {
    if (!FEATURES.fun) { await sock.sendMessage(jid, { text: '❌ Fun features are disabled.' }); return; }
    await handleJoke(sock, msg);
    return;
  }

  // ── Poll System ───────────────────────────────────────────────────────────
  if (cmd === 'poll') {
    if (!FEATURES.poll) { await sock.sendMessage(jid, { text: '❌ Poll feature is disabled.' }); return; }
    await handlePoll(sock, msg, args);
    return;
  }
  if (cmd === 'vote') {
    if (!FEATURES.poll) return;
    await handleVote(sock, msg, args);
    return;
  }
  if (cmd === 'pollresults' || cmd === 'results') {
    if (!FEATURES.poll) return;
    await handlePollResults(sock, msg);
    return;
  }
  if (cmd === 'endpoll') {
    if (!FEATURES.poll) return;
    await handleEndPoll(sock, msg, owner);
    return;
  }

  // ── Quiz ──────────────────────────────────────────────────────────────────
  if (cmd === 'quiz') {
    if (!FEATURES.quiz) { await sock.sendMessage(jid, { text: '❌ Quiz feature is disabled.' }); return; }
    await handleQuiz(sock, msg, args);
    return;
  }
  if (cmd === 'answer' || cmd === 'ans') {
    if (!FEATURES.quiz) return;
    await handleAnswer(sock, msg, args);
    return;
  }
  if (cmd === 'quizstats' || cmd === 'score') {
    if (!FEATURES.quiz) return;
    await handleQuizStats(sock, msg);
    return;
  }
  if (cmd === 'quiztop' || cmd === 'leaderboard') {
    if (!FEATURES.quiz) return;
    await handleQuizTop(sock, msg);
    return;
  }
  if (cmd === 'endquiz') {
    if (!FEATURES.quiz) return;
    await handleEndQuiz(sock, msg);
    return;
  }

  // ── Auto-React ────────────────────────────────────────────────────────────
  if (cmd === 'autoreact') {
    if (!owner) { await sock.sendMessage(jid, { text: '❌ Owner only.' }); return; }
    const parts = args.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const [a, b] = parts;
    const status = () =>
      `💬 *Auto-React Status*\n` +
      `   • PM:    ${isAutoReactPmEnabled()    ? '🟢 ON' : '🔴 OFF'}\n` +
      `   • Group: ${isAutoReactGroupEnabled() ? '🟢 ON' : '🔴 OFF'}\n\n` +
      `Toggle:\n` +
      `  ${PREFIX}autoreact on / off          (both)\n` +
      `  ${PREFIX}autoreact pm on / off       (DMs)\n` +
      `  ${PREFIX}autoreact group on / off    (groups)`;

    if (a === 'on')                       setAutoReact(true);
    else if (a === 'off')                 setAutoReact(false);
    else if (a === 'pm'    && b === 'on')  setAutoReactPm(true);
    else if (a === 'pm'    && b === 'off') setAutoReactPm(false);
    else if (a === 'group' && b === 'on')  setAutoReactGroup(true);
    else if (a === 'group' && b === 'off') setAutoReactGroup(false);
    else { await sock.sendMessage(jid, { text: status() }, { quoted: msg }); return; }

    await sock.sendMessage(jid, { text: '✅ Updated.\n\n' + status() }, { quoted: msg });
    return;
  }

  // ── Chatbot (AI auto-reply) ──────────────────────────────────────────────
  if (cmd === 'chatbot') {
    if (!owner) { await sock.sendMessage(jid, { text: '❌ Owner only.' }); return; }
    const parts = args.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const [a, b] = parts;
    const status = () =>
      `🤖 *Chatbot Status*\n` +
      `   • PM:    ${isChatbotPmEnabled()    ? '🟢 ON' : '🔴 OFF'}\n` +
      `   • Group: ${isChatbotGroupEnabled() ? '🟢 ON' : '🔴 OFF'}\n\n` +
      `_In groups, the bot only replies when mentioned (@bot) or when you reply to its message._\n\n` +
      `Toggle:\n` +
      `  ${PREFIX}chatbot on / off          (both)\n` +
      `  ${PREFIX}chatbot pm on / off       (DMs)\n` +
      `  ${PREFIX}chatbot group on / off    (groups)\n` +
      `  ${PREFIX}chatbot reset             (clear memory)`;

    if (a === 'on')                        { setChatbotPm(true);  setChatbotGroup(true);  }
    else if (a === 'off')                  { setChatbotPm(false); setChatbotGroup(false); }
    else if (a === 'pm'    && b === 'on')   setChatbotPm(true);
    else if (a === 'pm'    && b === 'off')  setChatbotPm(false);
    else if (a === 'group' && b === 'on')   setChatbotGroup(true);
    else if (a === 'group' && b === 'off')  setChatbotGroup(false);
    else if (a === 'reset' || a === 'clear') {
      clearChatbotHistory();
      await sock.sendMessage(jid, { text: '✅ Chatbot memory cleared.' }, { quoted: msg });
      return;
    }
    else { await sock.sendMessage(jid, { text: status() }, { quoted: msg }); return; }

    await sock.sendMessage(jid, { text: '✅ Updated.\n\n' + status() }, { quoted: msg });
    return;
  }

  // ── Update from GitHub ────────────────────────────────────────────────────
  if (cmd === 'update' || cmd === 'upgrade') {
    if (!owner) { await sock.sendMessage(jid, { text: '❌ Owner only.' }); return; }
    await handleUpdate(sock, msg);
    return;
  }

  // ── Owner: set profile picture ────────────────────────────────────────────
  if (cmd === 'setppbot') {
    if (!owner) { await sock.sendMessage(jid, { text: '❌ Owner only.' }); return; }
    let ok = false;
    if (hasImg) {
      await sock.sendMessage(jid, { text: '⏳ Updating...' });
      ok = await setBotImageFromMessage(sock, msg);
    } else if (args) {
      await sock.sendMessage(jid, { text: '⏳ Fetching image...' });
      ok = await setBotImage(sock, args.trim());
    } else {
      await sock.sendMessage(jid, { text: `Send *${PREFIX}setppbot* with an image, or *${PREFIX}setppbot <URL>*` });
      return;
    }
    await sock.sendMessage(jid, { text: ok ? '✅ Profile picture updated!' : '❌ Failed. Try a different image.' }, { quoted: msg });
    return;
  }

  // ── Owner: set bio ────────────────────────────────────────────────────────
  if (cmd === 'setbio') {
    if (!owner) { await sock.sendMessage(jid, { text: '❌ Owner only.' }); return; }
    if (!args)  { await sock.sendMessage(jid, { text: `Usage: *${PREFIX}setbio <text>*` }); return; }
    try {
      await sock.updateProfileStatus(args);
      await sock.sendMessage(jid, { text: `✅ Bio set to:\n"${args}"` }, { quoted: msg });
    } catch (e) {
      await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` });
    }
    return;
  }

  // Unknown — ignore silently
}

// ─── Main bot ─────────────────────────────────────────────────────────────────
async function startBot() {
  const phone = await resolvePhoneNumber();

  if (!phone || phone.length < 5) {
    console.error('\n❌ Invalid phone number. Set PHONE_NUMBER in .env and restart.\n');
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  console.log(`\n📡 Connecting with Baileys v${version.join('.')}...`);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    defaultQueryTimeoutMs: 60_000,
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Request pairing code ───────────────────────────────────────────────────
  if (!sock.authState.creds.registered) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const raw  = await sock.requestPairingCode(phone);
      const code = raw.match(/.{1,4}/g)?.join('-') ?? raw;
      console.log('\n╔══════════════════════════════════════════╗');
      console.log('║        🔑  YOUR PAIRING CODE             ║');
      console.log('╠══════════════════════════════════════════╣');
      console.log(`║   ➤  ${code.padEnd(36)}║`);
      console.log('╠══════════════════════════════════════════╣');
      console.log('║  1. Open WhatsApp on your phone          ║');
      console.log('║  2. Settings → Linked Devices            ║');
      console.log('║  3. Link a Device                        ║');
      console.log('║  4. "Link with phone number instead"     ║');
      console.log('║  5. Enter the code above  ✅             ║');
      console.log('╚══════════════════════════════════════════╝\n');
    } catch (err) {
      console.error('❌ Pairing code error:', err.message);
      process.exit(1);
    }
  } else {
    console.log('✅ Session found — reconnecting automatically...\n');
  }

  // ── Connection events ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const willRetry  = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️  Connection closed [${statusCode}]. Retrying: ${willRetry}`);
      if (willRetry) setTimeout(startBot, 5000);
      else { console.log('Logged out. Delete auth_info/ and restart.'); process.exit(0); }
    }
    if (connection === 'open') {
      console.log(`\n✅ ${BOT_NAME} is LIVE on WhatsApp!`);
      console.log(`   Commands start with: ${PREFIX}`);
      console.log(`   Send ${PREFIX}help to any chat to test`);
      console.log(`   Total features: 15 command groups loaded\n`);
      applyBotCustomization(sock).catch(() => {});
    }
  });

  // ── Message handler ────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!msg.message) continue;
        if (isJidBroadcast(jid) || isJidStatusBroadcast(jid)) continue;

        const fromMe = msg.key.fromMe;
        const sender = fromMe ? (sock.user?.id || jid) : (msg.key.participant || jid);

        // ── Auto-react fires first — before body check so it works on images,
        //    stickers, voice notes, and any media-only PM message too ──────────
        if (!fromMe) await handleAutoReact(sock, msg);

        const body = getBody(msg);
        if (!body) continue;

        const isCmd  = body.startsWith(PREFIX);
        const rawCmd = isCmd ? body.slice(PREFIX.length).split(/\s+/)[0] : '';
        const cmd    = rawCmd.toLowerCase();
        const args   = isCmd ? body.slice(PREFIX.length + rawCmd.length).trim() : '';
        const hasImg = !!(
          msg.message?.imageMessage ||
          msg.message?.viewOnceMessage?.message?.imageMessage
        );

        if (DEBUG) console.log(`[MSG] from=${sender} cmd="${cmd}" args="${args.slice(0,50)}"`);

        if (fromMe && !isCmd) continue;

        if (isCmd && cmd) {
          await handleCommand(sock, msg, jid, sender, cmd, args, hasImg);
        } else if (!isCmd && !fromMe) {
          // 1. Static autoreply patterns (hi, bye, etc.)
          const reply = findAutoreply(body, BOT_NAME);
          if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
          } else {
            // 2. AI chatbot (DMs always, groups only when mentioned/replied to)
            await handleChatbot(sock, msg, body, sock.user?.id || '');
          }
        }

      } catch (err) {
        console.error('❌ Message error:', err.message);
        if (DEBUG) console.error(err.stack);
      }
    }
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════╗');
console.log(`║  👑  ${BOT_NAME}`.padEnd(39) + '║');
console.log(`║  Prefix: ${PREFIX}  |  Debug: ${DEBUG ? 'ON' : 'OFF'}`.padEnd(39) + '║');
console.log(`║  Features: 15 command groups         ║`);
console.log('╚══════════════════════════════════════╝\n');

startBot().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
