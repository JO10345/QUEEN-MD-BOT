import { evaluate, format } from 'mathjs';

export async function handleCalculator(sock, msg, expr) {
  const jid = msg.key.remoteJid;

  if (!expr || !expr.trim()) {
    await sock.sendMessage(jid, {
      text:
        `🧮 *Calculator Usage:*\n` +
        `!calc <expression>\n\n` +
        `*Examples:*\n` +
        `  !calc 2 + 2\n` +
        `  !calc 15% of 200\n` +
        `  !calc sqrt(144)\n` +
        `  !calc (5 * 3) / 2\n` +
        `  !calc sin(45 deg)\n` +
        `  !calc log(1000)`,
    }, { quoted: msg });
    return;
  }

  try {
    // Handle "X% of Y" as a convenience shorthand
    let cleanExpr = expr.trim().replace(/(\d+)%\s+of\s+(\d+)/gi, '($1/100)*$2');

    const result = evaluate(cleanExpr);
    const formatted = format(result, { precision: 10 });

    await sock.sendMessage(jid, {
      text:
        `🧮 *Calculator*\n` +
        `━━━━━━━━━━━━━━\n` +
        `📝 *Input:* ${expr.trim()}\n` +
        `✅ *Result:* ${formatted}`,
    }, { quoted: msg });

  } catch (err) {
    await sock.sendMessage(jid, {
      text:
        `❌ *Invalid expression:* "${expr.trim()}"\n\n` +
        `Try: !calc 2 + 2  or  !calc sqrt(16)`,
    });
  }
}
