/**
 * Auto-reply rules — edit this file to add your own.
 * 
 * matchType options:
 *   "exact"      — message must match exactly
 *   "contains"   — message must contain the trigger
 *   "startsWith" — message must start with the trigger
 */

export const AUTOREPLIES = [
  {
    trigger: 'hello',
    response: '👋 Hello! I am *{BOT_NAME}*. Send *!help* to see what I can do!',
    matchType: 'contains',
  },
  {
    trigger: 'hi',
    response: '👋 Hi there! Type *!help* to see all my commands.',
    matchType: 'startsWith',
  },
  {
    trigger: 'thanks',
    response: "You're welcome! 😊 Let me know if you need anything else.",
    matchType: 'contains',
  },
  {
    trigger: 'good morning',
    response: '☀️ Good morning! Hope you have an amazing day!',
    matchType: 'contains',
  },
  {
    trigger: 'good night',
    response: '🌙 Good night! Sleep well!',
    matchType: 'contains',
  },
  {
    trigger: 'bye',
    response: '👋 Goodbye! Come back anytime!',
    matchType: 'contains',
  },
];

export function findAutoreply(messageText, botName) {
  const text = messageText.toLowerCase().trim();

  for (const rule of AUTOREPLIES) {
    const trigger = rule.trigger.toLowerCase();
    let matched = false;

    if (rule.matchType === 'exact') matched = text === trigger;
    else if (rule.matchType === 'contains') matched = text.includes(trigger);
    else if (rule.matchType === 'startsWith') matched = text.startsWith(trigger);

    if (matched) {
      return rule.response.replace('{BOT_NAME}', botName);
    }
  }

  return null;
}
