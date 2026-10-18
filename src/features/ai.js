import { getAssistantReply } from './ai-client.js';

const histories = new Map(); // sender → message history

export async function handleAI(sock, msg, text) {
  const jid     = msg.key.remoteJid;
  const sender  = msg.key.participant || jid;
  const botName = process.env.BOT_NAME || 'Queen MD Bot';
  const limit   = parseInt(process.env.AI_HISTORY_LIMIT || '10');

  try {
    const history = histories.get(sender) || [];

    await sock.sendMessage(jid, { react: { text: '🤔', key: msg.key } });

    const reply = await getAssistantReply({
      message: text,
      history,
      botName,
    });

    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    histories.set(sender, history.slice(-limit));

    await sock.sendMessage(jid, {
      text: `🤖 *${botName}*\n\n${reply}`,
    }, { quoted: msg });

  } catch (err) {
    console.error('AI error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ AI is temporarily unavailable. Please try again later.`,
    }, { quoted: msg });
  }
}

export function clearAIHistory(sender) {
  histories.delete(sender);
}