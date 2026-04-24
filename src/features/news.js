import axios from 'axios';

const GNEWS_BASE = 'https://gnews.io/api/v4';

const COUNTRY_CODES = {
  ng: 'Nigeria', gh: 'Ghana', za: 'South Africa', ke: 'Kenya',
  us: 'USA',     gb: 'UK',    au: 'Australia',     ca: 'Canada',
  in: 'India',   fr: 'France', de: 'Germany',      jp: 'Japan',
};

export async function handleNews(sock, msg, args) {
  const jid    = msg.key.remoteJid;
  const apiKey = process.env.NEWS_API_KEY || '';

  if (!apiKey) {
    await sock.sendMessage(jid, {
      text:
        `❌ *News feature needs setup*\n\n` +
        `The bot owner must add a free API key:\n` +
        `1. Go to https://gnews.io\n` +
        `2. Sign up for a free account\n` +
        `3. Copy your API key\n` +
        `4. Set NEWS_API_KEY=yourkey in .env`,
    });
    return;
  }

  const query = args.trim();
  let url;
  let headerLabel;

  if (!query) {
    url         = `${GNEWS_BASE}/top-headlines?lang=en&max=5&apikey=${apiKey}`;
    headerLabel = '🌍 Top Headlines';
  } else if (COUNTRY_CODES[query.toLowerCase()]) {
    const code  = query.toLowerCase();
    url         = `${GNEWS_BASE}/top-headlines?country=${code}&lang=en&max=5&apikey=${apiKey}`;
    headerLabel = `📰 Top Headlines — ${COUNTRY_CODES[code]}`;
  } else {
    url         = `${GNEWS_BASE}/search?q=${encodeURIComponent(query)}&lang=en&max=5&apikey=${apiKey}`;
    headerLabel = `🔍 News: "${query}"`;
  }

  try {
    await sock.sendMessage(jid, { react: { text: '📰', key: msg.key } });
    const res     = await axios.get(url, { timeout: 12000 });
    const articles = res.data?.articles;

    if (!articles || articles.length === 0) {
      await sock.sendMessage(jid, {
        text: `❌ No news found for "${query}". Try a different keyword.`,
      });
      return;
    }

    const lines = [`📰 *${headerLabel}*\n━━━━━━━━━━━━━━━━━━\n`];
    articles.forEach((a, i) => {
      const pub = a.source?.name || 'Unknown';
      lines.push(`*${i + 1}. ${a.title}*\n📡 ${pub}\n🔗 ${a.url}\n`);
    });

    lines.push(`_Powered by GNews · !news <country|keyword>_`);
    await sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });

  } catch (err) {
    console.error('News error:', err.message);
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      await sock.sendMessage(jid, { text: `❌ Invalid NEWS_API_KEY. Check your GNews key.` });
    } else {
      await sock.sendMessage(jid, { text: `❌ Could not fetch news. Try again later.` });
    }
  }
}
