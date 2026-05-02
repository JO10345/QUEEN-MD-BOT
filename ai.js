import axios from 'axios';

const AI_BASE    = 'https://all-in-1-ais.officialhectormanuel.workers.dev';
const histories  = new Map(); // sender → message history

export async function handleAI(sock, msg, text) {
  const jid     = msg.key.remoteJid;
  const sender  = msg.key.participant || jid;
  const botName = process.env.BOT_NAME || 'Queen MD Bot';
  const model   = process.env.AI_MODEL || 'gemini';
  const limit   = parseInt(process.env.AI_HISTORY_LIMIT || '10');

  try {
    // Build conversation context from history
    let history = histories.get(sender) || [];
    history.push({ role: 'user', content: text });
    if (history.length > limit) history = history.slice(-limit);

    // Build context string including recent history for the GET API
    let contextQuery = text;
    if (history.length > 1) {
      const ctx = history
        .slice(-5) // last 5 turns for context
        .map(h => `${h.role === 'user' ? 'User' : 'Bot'}: ${h.content}`)
        .join('\n');
      contextQuery = `${ctx}`;
    }

    await sock.sendMessage(jid, { react: { text: '🤔', key: msg.key } });

    const res = await axios.get(`${AI_BASE}/`, {
      params: {
        query: contextQuery,
        model: model,
      },
      timeout: 30000,
    });

    const reply = res.data?.message?.content;
    if (!reply) throw new Error('Empty response from AI');

    // Save assistant reply to history
    history.push({ role: 'assistant', content: reply });
    histories.set(sender, history);

    await sock.sendMessage(jid, {
      text: `🤖 *${botName}*\n\n${reply}`,
    }, { quoted: msg });

  } catch (err) {
    console.error('AI error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ AI is temporarily unavailable. Please try again.\n_${err.message}_`,
    });
  }
}

export function clearAIHistory(sender) {
  histories.delete(sender);
}
