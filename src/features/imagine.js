import OpenAI from 'openai';
import axios  from 'axios';

export async function handleImagine(sock, msg, prompt) {
  const jid = msg.key.remoteJid;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    await sock.sendMessage(jid, {
      text: `❌ Image generation is not configured.\n\nThe bot owner needs to set an OpenAI API key.`,
    });
    return;
  }

  if (!prompt || prompt.trim().length < 3) {
    await sock.sendMessage(jid, {
      text: `❌ *Usage:* !imagine <description>\n\nExamples:\n  !imagine a sunset over Lagos\n  !imagine a robot cooking jollof rice`,
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, { text: `🎨 Generating image for: _"${prompt}"_...\nThis may take a few seconds...` });
    await sock.sendMessage(jid, { react: { text: '🖌️', key: msg.key } });

    const openai = new OpenAI({ apiKey });

    const response = await openai.images.generate({
      model:           'dall-e-3',
      prompt:          prompt,
      n:               1,
      size:            '1024x1024',
      quality:         'standard',
      response_format: 'url',
    });

    const imageUrl = response.data[0]?.url;
    if (!imageUrl) throw new Error('No image URL returned');

    const imgRes    = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const imgBuffer = Buffer.from(imgRes.data);

    await sock.sendMessage(jid, {
      image:   imgBuffer,
      caption: `🎨 *AI Image*\n_"${prompt}"_`,
    }, { quoted: msg });

  } catch (err) {
    console.error('Imagine error:', err.message);

    let errMsg = `❌ Could not generate image.\n`;
    if (err.message?.includes('content policy')) {
      errMsg += `Your prompt was rejected by the content policy. Try a different description.`;
    } else if (err.message?.includes('billing')) {
      errMsg += `OpenAI billing issue — check your API key plan.`;
    } else {
      errMsg += `Please try again later.`;
    }
    await sock.sendMessage(jid, { text: errMsg });
  }
}
