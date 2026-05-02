import axios from 'axios';

const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  ar: 'Arabic',  zh: 'Chinese', pt: 'Portuguese', hi: 'Hindi',
  ru: 'Russian', ja: 'Japanese', ko: 'Korean',  it: 'Italian',
  tr: 'Turkish', nl: 'Dutch',   pl: 'Polish',   sv: 'Swedish',
  yo: 'Yoruba',  ha: 'Hausa',   ig: 'Igbo',     sw: 'Swahili',
  af: 'Afrikaans',
};

export async function handleTranslate(sock, msg, args) {
  const jid = msg.key.remoteJid;

  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await sock.sendMessage(jid, {
      text:
        `❌ *Usage:* !translate <language code> <text>\n\n` +
        `*Examples:*\n` +
        `  !translate es Hello, how are you?\n` +
        `  !translate fr Good morning\n` +
        `  !translate yo I love you\n\n` +
        `*Common codes:* en, es, fr, de, ar, zh, pt, hi, yo, ha, ig, sw`,
    }, { quoted: msg });
    return;
  }

  const target = parts[0].toLowerCase();
  const text   = parts.slice(1).join(' ');

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
    const res  = await axios.get(url, { timeout: 12000 });
    const data = res.data;

    const translated  = data[0].map(s => s[0]).join('');
    const detectedRaw = data[2] || 'auto';
    const detectedName = LANG_NAMES[detectedRaw] || detectedRaw.toUpperCase();
    const targetName   = LANG_NAMES[target]       || target.toUpperCase();

    await sock.sendMessage(jid, {
      text:
        `🌐 *Translation*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📝 *Original* (${detectedName}):\n${text}\n\n` +
        `✅ *${targetName}:*\n${translated}`,
    }, { quoted: msg });

  } catch (err) {
    console.error('Translate error:', err.message);
    await sock.sendMessage(jid, {
      text:
        `❌ Translation failed.\n\n` +
        `Make sure the language code is valid.\n` +
        `Examples: *en, es, fr, de, ar, zh, pt, hi, yo, ha*`,
    });
  }
}
