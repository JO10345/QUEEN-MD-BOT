import axios from 'axios';

const FALLBACK_QUOTES = [
  { content: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { content: 'In the middle of every difficulty lies opportunity.', author: 'Albert Einstein' },
  { content: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
  { content: 'Success is not final, failure is not fatal.', author: 'Winston Churchill' },
  { content: 'The future belongs to those who believe in the beauty of their dreams.', author: 'Eleanor Roosevelt' },
  { content: 'Life is what happens when you are busy making other plans.', author: 'John Lennon' },
  { content: 'Spread love everywhere you go.', author: 'Mother Teresa' },
  { content: 'When you reach the end of your rope, tie a knot in it and hang on.', author: 'Franklin D. Roosevelt' },
];

const FALLBACK_JOKES = [
  "Why don't scientists trust atoms? Because they make up everything! 😄",
  'I told my wife she was drawing her eyebrows too high. She looked surprised. 😂',
  'Why do programmers prefer dark mode? Because light attracts bugs! 🐛',
  'What do you call a fake noodle? An impasta! 🍝',
  'Why did the math book look so sad? Because it had too many problems. 📚',
  'I asked my dog what 2 minus 2 is. He said nothing. 🐕',
  'Why can\'t your nose be 12 inches long? Because then it would be a foot! 👃',
  'What do you call a bear with no teeth? A gummy bear! 🐻',
];

export async function handleQuote(sock, msg) {
  const jid = msg.key.remoteJid;
  try {
    const res   = await axios.get('https://api.quotable.io/random?maxLength=200', { timeout: 7000 });
    const quote = res.data;
    await sock.sendMessage(jid, {
      text:
        `💬 *Quote of the Moment*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `_"${quote.content}"_\n\n` +
        `— *${quote.author}*`,
    }, { quoted: msg });
  } catch {
    const q = FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)];
    await sock.sendMessage(jid, {
      text:
        `💬 *Quote of the Moment*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `_"${q.content}"_\n\n` +
        `— *${q.author}*`,
    }, { quoted: msg });
  }
}

export async function handleJoke(sock, msg) {
  const jid = msg.key.remoteJid;
  try {
    const res  = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 7000 });
    const joke = res.data;
    await sock.sendMessage(jid, {
      text:
        `😂 *Random Joke*\n` +
        `━━━━━━━━━━━━━━\n` +
        `${joke.setup}\n\n` +
        `👉 ${joke.punchline} 😄`,
    }, { quoted: msg });
  } catch {
    const joke = FALLBACK_JOKES[Math.floor(Math.random() * FALLBACK_JOKES.length)];
    await sock.sendMessage(jid, {
      text: `😂 *Random Joke*\n━━━━━━━━━━━━━━\n${joke}`,
    }, { quoted: msg });
  }
}
