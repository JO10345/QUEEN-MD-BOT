/**
 * Poll System
 * !poll Question | Option1 | Option2 | Option3
 * !vote 1        — vote for option 1
 * !pollresults   — see current results
 * !endpoll       — end poll (admin/owner only)
 */

const activePolls = new Map(); // jid → poll object

export async function handlePoll(sock, msg, args) {
  const jid    = msg.key.remoteJid;
  const sender = msg.key.participant || jid;

  const parts = args.split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length < 3) {
    await sock.sendMessage(jid, {
      text:
        `📊 *Create a Poll*\n\n` +
        `*Usage:* !poll Question | Option1 | Option2 | Option3\n\n` +
        `*Example:*\n` +
        `!poll Best food? | Jollof Rice | Fried Rice | Pounded Yam\n\n` +
        `_Minimum 2 options, maximum 10._`,
    }, { quoted: msg });
    return;
  }

  if (parts.length > 11) {
    await sock.sendMessage(jid, { text: `❌ Maximum 10 options per poll.` });
    return;
  }

  if (activePolls.has(jid)) {
    await sock.sendMessage(jid, {
      text: `❌ There is already an active poll in this chat.\nUse *!endpoll* to end it first.`,
    });
    return;
  }

  const question = parts[0];
  const options  = parts.slice(1);

  const poll = {
    question,
    options,
    votes:    new Map(), // sender → optionIndex
    creator:  sender,
    startedAt: Date.now(),
  };

  activePolls.set(jid, poll);

  const optionLines = options.map((o, i) => `  *${i + 1}.* ${o}`).join('\n');
  await sock.sendMessage(jid, {
    text:
      `📊 *POLL STARTED*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `❓ *${question}*\n\n` +
      `${optionLines}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📌 Vote: *!vote <number>*\n` +
      `📈 Results: *!pollresults*\n` +
      `🛑 End: *!endpoll*`,
  }, { quoted: msg });
}

export async function handleVote(sock, msg, args) {
  const jid    = msg.key.remoteJid;
  const sender = msg.key.participant || jid;
  const poll   = activePolls.get(jid);

  if (!poll) {
    await sock.sendMessage(jid, {
      text: `❌ No active poll in this chat.\nStart one with *!poll Question | Option1 | Option2*`,
    });
    return;
  }

  const num = parseInt(args.trim());
  if (isNaN(num) || num < 1 || num > poll.options.length) {
    await sock.sendMessage(jid, {
      text: `❌ Vote with a number between 1 and ${poll.options.length}.\nExample: *!vote 2*`,
    });
    return;
  }

  const alreadyVoted = poll.votes.has(sender);
  poll.votes.set(sender, num - 1);

  const senderName = `@${sender.split('@')[0]}`;
  await sock.sendMessage(jid, {
    text: `✅ ${senderName} voted for *${num}. ${poll.options[num - 1]}*${alreadyVoted ? ' (changed)' : ''}`,
    mentions: [sender],
  }, { quoted: msg });
}

export async function handlePollResults(sock, msg) {
  const jid  = msg.key.remoteJid;
  const poll = activePolls.get(jid);

  if (!poll) {
    await sock.sendMessage(jid, { text: `❌ No active poll. Start one with *!poll*` });
    return;
  }

  const totalVotes = poll.votes.size;

  const counts = poll.options.map((_, i) =>
    [...poll.votes.values()].filter(v => v === i).length
  );

  const lines = [`📊 *Poll Results*\n❓ ${poll.question}\n━━━━━━━━━━━━━━━━━━`];
  counts.forEach((c, i) => {
    const pct  = totalVotes ? Math.round((c / totalVotes) * 100) : 0;
    const bar  = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    lines.push(`*${i + 1}. ${poll.options[i]}*\n${bar} ${pct}% (${c} vote${c !== 1 ? 's' : ''})`);
  });

  lines.push(`━━━━━━━━━━━━━━━━━━\n👥 Total votes: ${totalVotes}`);
  await sock.sendMessage(jid, { text: lines.join('\n\n') }, { quoted: msg });
}

export async function handleEndPoll(sock, msg, isAdmin) {
  const jid  = msg.key.remoteJid;
  const poll = activePolls.get(jid);

  if (!poll) {
    await sock.sendMessage(jid, { text: `❌ No active poll to end.` });
    return;
  }

  const sender = msg.key.participant || jid;
  const isCreator = poll.creator === sender;

  if (!isCreator && !isAdmin) {
    await sock.sendMessage(jid, { text: `❌ Only the poll creator or admins can end the poll.` });
    return;
  }

  const totalVotes = poll.votes.size;
  const counts = poll.options.map((_, i) =>
    [...poll.votes.values()].filter(v => v === i).length
  );
  const maxVotes = Math.max(...counts);
  const winners  = poll.options.filter((_, i) => counts[i] === maxVotes);

  const lines = [`🏁 *POLL ENDED*\n❓ ${poll.question}\n━━━━━━━━━━━━━━━━━━`];
  counts.forEach((c, i) => {
    const pct  = totalVotes ? Math.round((c / totalVotes) * 100) : 0;
    const bar  = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    const win  = counts[i] === maxVotes ? ' 🏆' : '';
    lines.push(`*${i + 1}. ${poll.options[i]}${win}*\n${bar} ${pct}% (${c})`);
  });

  const winText = winners.length === 1 ? `🏆 *Winner: ${winners[0]}*` : `🤝 *Tie: ${winners.join(' & ')}*`;
  lines.push(`━━━━━━━━━━━━━━━━━━\n👥 Total votes: ${totalVotes}\n${winText}`);

  activePolls.delete(jid);
  await sock.sendMessage(jid, { text: lines.join('\n\n') }, { quoted: msg });
}
