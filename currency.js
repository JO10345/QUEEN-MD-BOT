import axios from 'axios';

let rateCache     = null;
let rateCacheTime = 0;
const CACHE_TTL   = 60 * 60 * 1000; // 1 hour

async function getRates(base = 'USD') {
  const now = Date.now();
  if (rateCache && rateCache.base === base && now - rateCacheTime < CACHE_TTL) {
    return rateCache.rates;
  }

  const res  = await axios.get(`https://open.er-api.com/v6/latest/${base}`, { timeout: 10000 });
  const data = res.data;
  if (data.result !== 'success') throw new Error('Rate fetch failed');

  rateCache     = { base, rates: data.rates };
  rateCacheTime = now;
  return data.rates;
}

export async function handleCurrency(sock, msg, args) {
  const jid   = msg.key.remoteJid;
  const parts = args.trim().toUpperCase().split(/\s+/);

  // Formats: !convert 100 USD NGN  or  !convert 100 USD TO NGN
  const filtered = parts.filter(p => p !== 'TO');
  const amount   = parseFloat(filtered[0]);
  const from     = filtered[1];
  const to       = filtered[2];

  if (!amount || !from || !to || isNaN(amount)) {
    await sock.sendMessage(jid, {
      text:
        `💱 *Currency Converter*\n\n` +
        `*Usage:* !convert <amount> <from> <to>\n\n` +
        `*Examples:*\n` +
        `  !convert 100 USD NGN\n` +
        `  !convert 50 GBP EUR\n` +
        `  !convert 1000 NGN USD\n` +
        `  !convert 5 BTC USD\n\n` +
        `_Supports 160+ currencies. Rates update hourly._`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { react: { text: '💱', key: msg.key } });

    const rates    = await getRates(from);
    const toRate   = rates[to];

    if (!toRate) {
      await sock.sendMessage(jid, {
        text: `❌ Unknown currency code: *${to}*\nExamples: USD, NGN, GBP, EUR, JPY, KES, GHS`,
      });
      return;
    }

    const converted = (amount * toRate).toFixed(2);
    const rate1     = toRate.toFixed(4);

    await sock.sendMessage(jid, {
      text:
        `💱 *Currency Conversion*\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `💵 *${amount.toLocaleString()} ${from}*\n` +
        `     =\n` +
        `💰 *${parseFloat(converted).toLocaleString()} ${to}*\n\n` +
        `📊 Rate: 1 ${from} = ${rate1} ${to}\n` +
        `_Rates are approximate. Updated hourly._`,
    }, { quoted: msg });

  } catch (err) {
    console.error('Currency error:', err.message);
    if (err.message?.includes('Unknown')) {
      await sock.sendMessage(jid, { text: `❌ Unknown currency code: *${from}*` });
    } else {
      await sock.sendMessage(jid, {
        text: `❌ Could not fetch rates. Try again later.\n\n!convert 100 USD NGN`,
      });
    }
  }
}
