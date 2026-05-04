/**
 * Chatbot Feature — auto-replies to non-command messages using the AI API.
 * Independent toggles for PM and Group chats.
 *
 * Group rule: to avoid spam, the bot only replies in groups when it is
 * mentioned (@bot) or when someone replies to one of the bot's messages.
 * In PMs, it replies to every non-command text message.
 *
 * Default: PM ON, Group OFF (change with !chatbot pm on/off)
 */

import axios from 'axios';
import { getState, setState } from './state.js';

const AI_BASE = 'https://all-in-1-ais.officialhectormanuel.workers.dev';

// PM defaults ON, group defaults OFF
let pmEnabled    = getState('chatbot_pm',    process.env.CHATBOT_PM_ENABLED    !== 'false');
let groupEnabled = getState('chatbot_group', process.env.CHATBOT_GROUP_ENABLED === 'true');

const histories = new Map();
const inflight  = new Set();

export function isChatbotPmEnabled()    { return pmEnabled; }
export function isChatbotGroupEnabled() { return groupEnabled; }
export function setChatbotPm(v)    { pmEnabled    = Boolean(v); setState('chatbot_pm',    pmEnabled);    }
export function setChatbotGroup(v) { groupEnabled = Boolean(v); setState('chatbot_group', groupEnabled); }

function bareJid(jid) {
  if (!jid) return '';
  return jid.split(':')[0].split('@')[0];
}

function cleanReply(text) {
  if (!text) return '';
  return text
    .replace(/^\s*Bot\s*:\s*/i, '')
    .replace(/^\s*Assistant\s*:\s*/i, '')
    .trim();
}

/**
 * @returns {Promise<boolean>} true if the bot replied
 */
export async function handleChatbot(sock, msg, body, botJid) {
  const jid = msg.key.remoteJid;
  if (!jid) return false;

  // Skip broadcast / status
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return false;

  const isGroup = jid.endsWith('@g.us');
  const isPm    = jid.endsWith('@s.whatsapp.net');

  if (isGroup && !groupEnabled) return false;
  if (isPm    && !pmEnabled)    return false;
  if (!isGroup && !isPm)        return false;

  // In groups, only respond when mentioned or when replying to the bot
  let cleanBody = body;
  if (isGroup) {
    const ctxInfo    = msg.message?.extendedTextMessage?.contextInfo || {};
    const mentioned  = ctxInfo.mentionedJid || [];
    const repliedTo  = ctxInfo.participant || '';
    const botBare    = bareJid(botJid);

    const isMentioned  = botBare && mentioned.some(m => bareJid(m) === botBare);
    const isReplyToBot = botBare && bareJid(repliedTo) === botBare;

    if (!isMentioned && !isReplyToBot) return false;

    cleanBody = body.replace(/@\d+/g, '').trim();
    if (!cleanBody) return false;
  }

  // Require actual text content
  if (!cleanBody || cleanBody.length < 1) return false;

  const sender = msg.key.participant || jid;

  if (inflight.has(sender)) return false;
  inflight.add(sender);

  const model   = process.env.AI_MODEL          || 'gemini';
  const limit   = parseInt(process.env.AI_HISTORY_LIMIT || '6');
  const botName = process.env.BOT_NAME          || 'Queen MD Bot';

  try {
    // Show typing indicator
    try { await sock.sendPresenceUpdate('composing', jid); } catch {}

    let history = histories.get(sender) || [];
    const recent = history.slice(-4);
    const ctxLines = recent.map(h =>
      `${h.role === 'user' ? 'User' : 'Bot'}: ${h.content}`
    );
    ctxLines.push(`User: ${cleanBody}`);
    const query = ctxLines.join('\n');

    // Try primary AI, fallback to simple direct query on failure
    let rawReply;
    try {
      const res = await axios.get(`${AI_BASE}/`, {
        params:  { query, model },
        timeout: 30_000,
      });
      rawReply = res.data?.message?.content || res.data?.response || res.data?.text;
    } catch (apiErr) {
      // Fallback: try with just the plain message, no history context
      try {
        const res2 = await axios.get(`${AI_BASE}/`, {
          params:  { query: cleanBody, model },
          timeout: 25_000,
        });
        rawReply = res2.data?.message?.content || res2.data?.response || res2.data?.text;
      } catch {
        throw apiErr;
      }
    }

    if (!rawReply) {
      await sock.sendMessage(jid, {
        text: '⚠️ AI gave an empty response. Try again.',
      }, { quoted: msg });
      return false;
    }

    const reply = cleanReply(rawReply);

    history.push({ role: 'user',      content: cleanBody });
    history.push({ role: 'assistant', content: reply });
    if (history.length > limit * 2) history = history.slice(-limit * 2);
    histories.set(sender, history);

    try { await sock.sendPresenceUpdate('paused', jid); } catch {}

    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    return true;
  } catch (err) {
    try { await sock.sendPresenceUpdate('paused', jid); } catch {}
    try {
      await sock.sendMessage(jid, {
        text: `⚠️ ${botName} couldn't respond right now. Try again in a moment.`,
      }, { quoted: msg });
    } catch {}
    return false;
  } finally {
    inflight.delete(sender);
  }
}

export function clearChatbotHistory(sender) {
  if (sender) histories.delete(sender);
  else histories.clear();
}
