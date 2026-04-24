import axios from 'axios';

export async function handleWeather(sock, msg, city) {
  const jid = msg.key.remoteJid;

  try {
    const encodedCity = encodeURIComponent(city.trim());
    const response = await axios.get(`https://wttr.in/${encodedCity}?format=4`, {
      headers: { 'User-Agent': 'curl/7.68.0' },
      timeout: 8000,
    });

    const weather = response.data.trim();

    await sock.sendMessage(jid, {
      text: `🌤️ *Weather Report*\n\n${weather}\n\n_Send *!weather <city>* to check any city_`
    }, { quoted: msg });

  } catch (err) {
    console.error('Weather error:', err.message);
    await sock.sendMessage(jid, {
      text: `❌ Could not get weather for *"${city}"*\n\nCheck the city name and try again.\nExample: *!weather Lagos*`
    });
  }
}
