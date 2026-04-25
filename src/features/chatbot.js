/**
 * Chatbot Feature — auto-replies to non-command messages using the AI API.
 * Independent toggles for PM and Group chats.
 *
 * Group rule: to avoid spam, the bot only replies in groups when it is
 * mentioned (@bot) or when someone replies to one of the bot's messages.
 * In PMs, it replies to every non-command text message.
 */

import axios from 'axios';

const AI_BASE = 'https://all-in-1-ais.officialhectormanuel.workers.dev';

let pmEnabled    = process.env.CHATBOT_PM_ENABLED    === 'true';
let groupEnabled = process.env.CHATBOT_GROUP_ENABLED === 'true';

const histories = new Map();   // sender -> [{role, content}]
const inflight  = new Set();   // senders currently being processed

export function isChatbotPmEnabled()    { return pmEnabled; }
export function isChatbotGroupEnabled() { return groupEnabled; }
export function setChatbotPm(v)    { pmEnabled    = Boolean(v); }
export function setChatbotGroup(v) { groupEnabled = Boolean(v); }

function bareJid(jid) {
  if (!jid) return '';
  return jid.split(':')[0].split('@')[0];
}

// The AI API echoes "Bot: ..." in its replies — strip it so history stays clean
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

    // Strip the @mention from the message so the AI doesn't see it
    cleanBody = body.replace(/@\d+/g, '').trim();
    if (!cleanBody) return false;
  }

  const sender = msg.key.participant || jid;

  // Prevent overlapping replies for the same sender (avoids confusion when
  // someone fires multiple messages quickly while the AI is still working)
  if (inflight.has(sender)) return false;
  inflight.add(sender);

  const model       = process.env.AI_MODEL              || 'gemini';
  const limit       = parseInt(process.env.AI_HISTORY_LIMIT || '6');
  const botName     = process.env.BOT_NAME              || 'Queen MD Bot';

  try {
    // Show typing indicator
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch {}

    // Build short context — only last 2 turns (4 entries) keeps the AI focused
    let history = histories.get(sender) || [];

    const recent = history.slice(-4); // last 2 user + 2 assistant turns
    const ctxLines = recent.map(h =>
      `${h.role === 'user' ? 'User' : 'Bot'}: ${h.content}`
    );
    ctxLines.push(`User: ${cleanBody}`);
    const query = ctxLines.join('\n');

    const res = await axios.get(`${AI_BASE}/`, {
      params:  { query, model },
      timeout: 30_000,
    });

    const rawReply = res.data?.message?.content;
    if (!rawReply) {
      console.error('Chatbot: empty AI response', JSON.stringify(res.data).slice(0, 200));
      await sock.sendMessage(jid, {
        text: '⚠️ AI gave an empty response. Try again.',
      }, { quoted: msg });
      return false;
    }

    const reply = cleanReply(rawReply);

    // Update history WITHOUT the "Bot:" prefix so context stays clean
    history.push({ role: 'user',      content: cleanBody });
    history.push({ role: 'assistant', content: reply });
    if (history.length > limit * 2) history = history.slice(-limit * 2);
    histories.set(sender, history);

    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch {}

    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    return true;
  } catch (err) {
    console.error('Chatbot error:', err.message);
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
