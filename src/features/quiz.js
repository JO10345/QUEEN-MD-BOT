/**
 * Quiz Feature
 * !quiz          — start a random quiz question
 * !quiz <topic>  — quiz on a topic (general, science, history, sports, music)
 * !answer <A/B/C/D> — answer the current question
 * !quizstats     — show your quiz score
 * !quiztop       — leaderboard (group)
 * !endquiz       — stop active quiz session
 */

import axios from 'axios';
import he from 'he';
const decode = (str) => he.decode(str);

// ── In-memory state ────────────────────────────────────────────────────────────
const activeQuestions = new Map(); // jid → { question, options, correct, sender, timeout }
const userStats       = new Map(); // sender → { correct, total }

const CATEGORY_IDS = {
  general:   9,
  science:   17,
  history:   23,
  sports:    21,
  music:     12,
  movies:    11,
  geography: 22,
  computers: 18,
};

const ANSWER_LABELS = ['A', 'B', 'C', 'D'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getStats(sender) {
  return userStats.get(sender) || { correct: 0, total: 0 };
}

function updateStats(sender, isCorrect) {
  const s = getStats(sender);
  userStats.set(sender, {
    correct: s.correct + (isCorrect ? 1 : 0),
    total:   s.total + 1,
  });
}

// ── Fetch from Open Trivia DB (free, no key) ──────────────────────────────────
async function fetchQuestion(topic) {
  const categoryId = CATEGORY_IDS[topic?.toLowerCase()] || CATEGORY_IDS.general;
  const url = `https://opentdb.com/api.php?amount=1&type=multiple&category=${categoryId}`;

  try {
    const res  = await axios.get(url, { timeout: 10000 });
    const data = res.data;
    if (data.response_code !== 0 || !data.results?.length) return null;

    const raw = data.results[0];
    const question  = decode(raw.question);
    const correct   = decode(raw.correct_answer);
    const incorrect = raw.incorrect_answers.map(decode);
    const allOptions = shuffle([correct, ...incorrect]);

    return { question, correct, options: allOptions, category: raw.category, difficulty: raw.difficulty };
  } catch {
    return null;
  }
}

// ── Fallback questions if API is down ─────────────────────────────────────────
const FALLBACK_QUESTIONS = [
  {
    question:   'What is the capital of Nigeria?',
    correct:    'Abuja',
    options:    shuffle(['Abuja', 'Lagos', 'Kano', 'Port Harcourt']),
    category:   'General Knowledge',
    difficulty: 'easy',
  },
  {
    question:   'How many sides does a hexagon have?',
    correct:    '6',
    options:    shuffle(['6', '5', '7', '8']),
    category:   'Mathematics',
    difficulty: 'easy',
  },
  {
    question:   'Which planet is closest to the Sun?',
    correct:    'Mercury',
    options:    shuffle(['Mercury', 'Venus', 'Earth', 'Mars']),
    category:   'Science',
    difficulty: 'easy',
  },
  {
    question:   'What is the chemical symbol for gold?',
    correct:    'Au',
    options:    shuffle(['Au', 'Ag', 'Fe', 'Cu']),
    category:   'Science',
    difficulty: 'medium',
  },
  {
    question:   'Who wrote the play "Romeo and Juliet"?',
    correct:    'William Shakespeare',
    options:    shuffle(['William Shakespeare', 'Charles Dickens', 'Jane Austen', 'Mark Twain']),
    category:   'Literature',
    difficulty: 'easy',
  },
  {
    question:   'What is 12 × 12?',
    correct:    '144',
    options:    shuffle(['144', '124', '132', '148']),
    category:   'Mathematics',
    difficulty: 'easy',
  },
  {
    question:   'Which country won the 2018 FIFA World Cup?',
    correct:    'France',
    options:    shuffle(['France', 'Croatia', 'Belgium', 'England']),
    category:   'Sports',
    difficulty: 'medium',
  },
  {
    question:   'What does "HTTP" stand for?',
    correct:    'HyperText Transfer Protocol',
    options:    shuffle(['HyperText Transfer Protocol', 'High Tech Transfer Page', 'HyperText Transfer Page', 'Hyper Transfer Text Protocol']),
    category:   'Computers',
    difficulty: 'easy',
  },
];

function getFallbackQuestion() {
  return FALLBACK_QUESTIONS[Math.floor(Math.random() * FALLBACK_QUESTIONS.length)];
}

// ── Format difficulty label ───────────────────────────────────────────────────
function difficultyEmoji(d) {
  if (d === 'easy')   return '🟢 Easy';
  if (d === 'medium') return '🟡 Medium';
  return '🔴 Hard';
}

// ── Public handlers ───────────────────────────────────────────────────────────

export async function handleQuiz(sock, msg, args) {
  const jid    = msg.key.remoteJid;
  const sender = msg.key.participant || jid;

  if (activeQuestions.has(jid)) {
    await sock.sendMessage(jid, {
      text:
        `❓ There's already an active question!\n` +
        `Answer it with *!answer A/B/C/D*\n` +
        `Or use *!endquiz* to skip it.`,
    }, { quoted: msg });
    return;
  }

  const topic = args?.trim()?.toLowerCase();
  if (topic && !CATEGORY_IDS[topic]) {
    const topics = Object.keys(CATEGORY_IDS).join(', ');
    await sock.sendMessage(jid, {
      text:
        `❌ Unknown topic: *${topic}*\n\n` +
        `Available topics:\n${topics}\n\n` +
        `Or just use *!quiz* for a random question.`,
    }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, { text: '🎯 Fetching question...' });

  let q = await fetchQuestion(topic);
  if (!q) q = getFallbackQuestion();

  const labeled = q.options.map((o, i) => ({ label: ANSWER_LABELS[i], text: o }));
  const correctLabel = labeled.find(l => l.text === q.correct)?.label;

  // Store active question — auto-expire in 60 seconds
  const expireTimeout = setTimeout(async () => {
    if (!activeQuestions.has(jid)) return;
    activeQuestions.delete(jid);
    try {
      await sock.sendMessage(jid, {
        text:
          `⏰ *Time's up!* Nobody answered.\n\n` +
          `✅ The correct answer was: *${correctLabel}. ${q.correct}*\n\n` +
          `Send *!quiz* to try another!`,
      });
    } catch { /* ignore */ }
  }, 60000);

  activeQuestions.set(jid, { question: q.question, options: labeled, correct: q.correct, correctLabel, sender, timeout: expireTimeout });

  const optionLines = labeled.map(l => `  *${l.label}.* ${l.text}`).join('\n');
  await sock.sendMessage(jid, {
    text:
      `🧠 *QUIZ TIME!*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📚 Category: ${q.category}\n` +
      `${difficultyEmoji(q.difficulty)}\n\n` +
      `❓ *${q.question}*\n\n` +
      `${optionLines}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📌 Answer: *!answer A* (or B, C, D)\n` +
      `⏱ You have *60 seconds!*`,
  }, { quoted: msg });
}

export async function handleAnswer(sock, msg, args) {
  const jid    = msg.key.remoteJid;
  const sender = msg.key.participant || jid;

  const active = activeQuestions.get(jid);
  if (!active) {
    await sock.sendMessage(jid, {
      text: `❌ No active quiz question.\nSend *!quiz* to start one!`,
    }, { quoted: msg });
    return;
  }

  const answer = args?.trim()?.toUpperCase();
  if (!ANSWER_LABELS.includes(answer)) {
    await sock.sendMessage(jid, {
      text: `❌ Please answer with *!answer A*, *!answer B*, *!answer C*, or *!answer D*`,
    }, { quoted: msg });
    return;
  }

  // Stop expiry timer
  clearTimeout(active.timeout);
  activeQuestions.delete(jid);

  const chosen    = active.options.find(o => o.label === answer);
  const isCorrect = chosen?.text === active.correct;
  const senderTag = `@${sender.split('@')[0]}`;

  updateStats(sender, isCorrect);
  const stats = getStats(sender);
  const pct   = Math.round((stats.correct / stats.total) * 100);

  if (isCorrect) {
    await sock.sendMessage(jid, {
      text:
        `✅ *CORRECT!* ${senderTag} 🎉\n\n` +
        `The answer was: *${active.correctLabel}. ${active.correct}*\n\n` +
        `📊 Your score: ${stats.correct}/${stats.total} (${pct}%)\n\n` +
        `Send *!quiz* for the next question!`,
      mentions: [sender],
    }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, {
      text:
        `❌ *WRONG!* ${senderTag}\n\n` +
        `You chose: *${answer}. ${chosen?.text}*\n` +
        `✅ Correct answer: *${active.correctLabel}. ${active.correct}*\n\n` +
        `📊 Your score: ${stats.correct}/${stats.total} (${pct}%)\n\n` +
        `Send *!quiz* to try again!`,
      mentions: [sender],
    }, { quoted: msg });
  }
}

export async function handleQuizStats(sock, msg) {
  const jid    = msg.key.remoteJid;
  const sender = msg.key.participant || jid;
  const stats  = getStats(sender);

  if (stats.total === 0) {
    await sock.sendMessage(jid, {
      text: `📊 You haven't answered any quiz questions yet!\nSend *!quiz* to start.`,
    }, { quoted: msg });
    return;
  }

  const pct = Math.round((stats.correct / stats.total) * 100);
  let rank  = '🥉 Beginner';
  if (pct >= 90) rank = '🏆 Master';
  else if (pct >= 75) rank = '🥇 Expert';
  else if (pct >= 50) rank = '🥈 Intermediate';

  await sock.sendMessage(jid, {
    text:
      `📊 *Your Quiz Stats*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `✅ Correct:  ${stats.correct}\n` +
      `❌ Wrong:    ${stats.total - stats.correct}\n` +
      `📝 Total:    ${stats.total}\n` +
      `🎯 Accuracy: ${pct}%\n` +
      `🏅 Rank:     ${rank}`,
  }, { quoted: msg });
}

export async function handleQuizTop(sock, msg) {
  const jid = msg.key.remoteJid;

  if (userStats.size === 0) {
    await sock.sendMessage(jid, {
      text: `📊 No quiz stats yet!\nSend *!quiz* to start.`,
    }, { quoted: msg });
    return;
  }

  const sorted = [...userStats.entries()]
    .map(([id, s]) => ({ id, ...s, pct: s.total ? Math.round((s.correct / s.total) * 100) : 0 }))
    .sort((a, b) => b.correct - a.correct || b.pct - a.pct)
    .slice(0, 10);

  const medals = ['🥇', '🥈', '🥉'];
  const lines  = [`🏆 *Quiz Leaderboard*\n━━━━━━━━━━━━━━━━━━`];

  sorted.forEach((p, i) => {
    const medal = medals[i] || `${i + 1}.`;
    const name  = p.id.split('@')[0];
    lines.push(`${medal} *+${name}* — ${p.correct} correct (${p.pct}%)`);
  });

  await sock.sendMessage(jid, { text: lines.join('\n') }, { quoted: msg });
}

export async function handleEndQuiz(sock, msg) {
  const jid = msg.key.remoteJid;

  if (!activeQuestions.has(jid)) {
    await sock.sendMessage(jid, { text: `❌ No active quiz question to end.` }, { quoted: msg });
    return;
  }

  const active = activeQuestions.get(jid);
  clearTimeout(active.timeout);
  activeQuestions.delete(jid);

  await sock.sendMessage(jid, {
    text:
      `🛑 Quiz question ended.\n\n` +
      `✅ The correct answer was: *${active.correctLabel}. ${active.correct}*\n\n` +
      `Send *!quiz* to start a new question.`,
  }, { quoted: msg });
}
