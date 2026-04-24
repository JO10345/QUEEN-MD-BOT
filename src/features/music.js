import ytSearch from 'yt-search';
import axios    from 'axios';

const YTDL_API = 'https://yt-dl.officialhectormanuel.workers.dev';
const YT_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))([\w-]{11})/;

async function getAudioFromAPI(videoUrl) {
  const res  = await axios.get(`${YTDL_API}/`, {
    params:  { url: videoUrl },
    timeout: 20000,
  });

  const data = res.data;
  if (!data?.status || !data?.audio) throw new Error('No audio URL returned');

  const audioRes = await axios.get(data.audio, {
    responseType: 'arraybuffer',
    timeout:      120000,
    headers:      { 'User-Agent': 'Mozilla/5.0' },
  });

  const buf = Buffer.from(audioRes.data);
  if (buf.length < 5000) throw new Error('Downloaded audio too small');
  return { buf, title: data.title };
}

export async function handleMusic(sock, msg, query) {
  const jid = msg.key.remoteJid;

  try {
    let videoUrl = '';
    let title    = query;

    if (YT_REGEX.test(query)) {
      videoUrl = query;
    } else {
      await sock.sendMessage(jid, { text: `🔍 Searching for: *${query}*...` });
      const results = await ytSearch(query);
      const video   = results.videos[0];
      if (!video) {
        await sock.sendMessage(jid, {
          text: `❌ No results found for *"${query}"*\nTry a different song name.`,
        });
        return;
      }
      videoUrl = video.url;
      title    = video.title;
    }

    await sock.sendMessage(jid, {
      text: `🎵 *${title}*\n📥 Downloading audio...`,
    });

    const { buf, title: apiTitle } = await getAudioFromAPI(videoUrl);

    await sock.sendMessage(jid, {
      audio:    buf,
      mimetype: 'audio/mpeg',
      ptt:      false,
    }, { quoted: msg });

    await sock.sendMessage(jid, {
      text: `✅ *${apiTitle || title}*\n_Enjoy the music!_ 🎶`,
    });

  } catch (err) {
    console.error('Music error:', err.message);
    await sock.sendMessage(jid, {
      text:
        `❌ Could not download *"${query}"*\n\n` +
        `Try:\n• A different song name\n• A direct YouTube link`,
    });
  }
}
