/**
 * Chatbot Feature — auto-replies to non-command messages.
 *
 * - Shows typing indicator while AI works
 * - In groups: only replies when @mentioned or replied-to
 * - In PMs: replies to every non-command message
 * - Per-sender conversation history
 */

import { getState, setState } from './state.js';
import { getAssistantReply } from './ai-client.js';

let pmEnabled    = getState('chatbot_pm',    process.env.CHATBOT_PM_ENABLED    === 'true');
let groupEnabled = getState('chatbot_group', process.env.CHATBOT_GROUP_ENABLED === 'true');

const histories = new Map();
const inflight  = new Set();
const HISTORY_MAX_SENDERS = 200;

function pruneHistories() {
  if (histories.size > HISTORY_MAX_SENDERS) {
    const toDelete = histories.size - Math.floor(HISTORY_MAX_SENDERS * 0.75);
    let i = 0;
    for (const key of histories.keys()) {
      if (i++ >= toDelete) break;
      histories.delete(key);
    }
  }
}

export function isChatbotPmEnabled()    { return pmEnabled; }
export function isChatbotGroupEnabled() { return groupEnabled; }
export function setChatbotPm(v)    { pmEnabled    = Boolean(v); setState('chatbot_pm',    pmEnabled); }
export function setChatbotGroup(v) { groupEnabled = Boolean(v); setState('chatbot_group', groupEnabled); }

function bareJid(jid) {
  return (jid || '').split(':')[0].split('@')[0];
}

function cleanReply(text) {
  if (!text) return '';
  return text.replace(/^\s*(Bot|Assistant)\s*:\s*/i, '').trim();
}

async function startTyping(sock, jid) {
  try { await sock.sendPresenceUpdate('composing', jid); } catch {}
  const iv = setInterval(async () => {
    try { await sock.sendPresenceUpdate('composing', jid); } catch {}
  }, 8000);
  return async function stopTyping() {
    clearInterval(iv);
    try { await sock.sendPresenceUpdate('paused', jid); } catch {}
  };
}

function typingFinishDelay(text) {
  const ms = Math.min(Math.max((text || '').length * 30, 1500), 5000);
  return new Promise(r => setTimeout(r, ms));
}

export async function handleChatbot(sock, msg, body, botJid) {
  const jid = msg.key.remoteJid;
  if (!jid) return false;

  const isGroup = jid.endsWith('@g.us');
  const isPm    = jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@c.us') || jid.endsWith('@lid');

  if (isGroup && !groupEnabled) return false;
  if (isPm    && !pmEnabled)    return false;
  if (!isGroup && !isPm)        return false;

  let cleanBody = (body || '').trim();

  if (isGroup) {
    const ctx       = msg.message?.extendedTextMessage?.contextInfo || {};
    const mentioned = ctx.mentionedJid || [];
    const repliedTo = ctx.participant  || '';
    const botBare   = bareJid(botJid);

    const isMentioned  = botBare && mentioned.some(m => bareJid(m) === botBare);
    const isReplyToBot = botBare && bareJid(repliedTo) === botBare;

    if (!isMentioned && !isReplyToBot) return false;

    cleanBody = cleanBody.replace(/@\d+/g, '').trim();
    if (!cleanBody) return false;
  }

  const sender = msg.key.participant || jid;
  if (inflight.has(sender)) return false;
  inflight.add(sender);

  const histLimit = parseInt(process.env.AI_HISTORY_LIMIT || '6');
  const botName   = process.env.BOT_NAME || 'Queen MD Bot';
  let stopTyping = async () => {};

  try {
    stopTyping = await startTyping(sock, jid);
    let history = histories.get(sender) || [];
    const rawReply = await getAssistantReply({
      message: cleanBody,
      history,
      botName,
    });
    const reply = cleanReply(rawReply);

    history.push({ role: 'user', content: cleanBody });
    history.push({ role: 'assistant', content: reply });
    if (history.length > histLimit * 2) history = history.slice(-histLimit * 2);
    histories.set(sender, history);
    pruneHistories();

    await typingFinishDelay(reply);
    await stopTyping();
    await sendWithFallback(sock, jid, reply, msg);
    return true;

  } catch (err) {
    console.error('[CHATBOT] all APIs failed:', err.message);
    await stopTyping();
    await sendWithFallback(
      sock, jid,
      `⚠️ *${botName}* couldn't respond right now. All AI services are busy — try again in a moment.`,
      msg,
    );
    return false;
  } finally {
    inflight.delete(sender);
  }
}

async function sendWithFallback(sock, jid, text, quotedMsg) {
  try {
    await sock.sendMessage(jid, { text }, { quoted: quotedMsg });
  } catch (err) {
    console.error('[CHATBOT] send with quote failed, retrying without quote:', err.message);
    try {
      await sock.sendMessage(jid, { text });
    } catch (err2) {
      console.error('[CHATBOT] send without quote also failed:', err2.message);
    }
  }
}

export function clearChatbotHistory(sender) {
  if (sender) histories.delete(sender);
  else histories.clear();
}