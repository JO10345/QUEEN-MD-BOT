/**
 * Shared AI client for !ai and the automatic chatbot.
 *
 * David Cyril's GPT endpoints are primary when DAVID_API_KEY is configured.
 * Other public providers remain as short-timeout fallbacks.
 */

import axios from 'axios';

const CUSTOM_URL = (process.env.AI_API_URL || '').trim();
const DAVID_API_KEY = (process.env.DAVID_API_KEY || '').trim();
const DAVID_HEADERS = DAVID_API_KEY ? { 'X-API-Key': DAVID_API_KEY } : undefined;

const ASSISTANT_RULES = [
  'You are the helpful personal assistant inside a WhatsApp bot.',
  'Answer the user directly and naturally, without saying you are an API.',
  'Be accurate, friendly, and concise enough for WhatsApp.',
  'Use plain text unless a short list or code block genuinely helps.',
  'If the request is unclear, ask one focused follow-up question.',
].join(' ');

function textFromResponse(data) {
  const contentText = (value) => Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '')
      .filter(Boolean).join('\n')
    : '';
  const candidates = [
    data?.text,
    data?.response,
    data?.result,
    data?.answer,
    data?.data,
    data?.message?.content,
    data?.message,
    data?.output,
    data?.choices?.[0]?.message?.content,
    data?.data?.response,
    data?.data?.result,
    data?.data?.answer,
    data?.data?.data,
    data?.data?.text,
    data?.data?.message,
    data?.result?.response,
    data?.result?.answer,
    data?.result?.text,
    data?.result?.message,
    data?.result?.content,
    data?.result?.choices?.[0]?.message?.content,
    data?.data?.result?.message,
    data?.data?.result?.content,
    contentText(data?.content),
    contentText(data?.result?.content),
    contentText(data?.data?.content),
  ];

  const value = candidates.find(item => typeof item === 'string' && item.trim());
  return value?.trim() || '';
}

function buildPrompt(message, history, botName) {
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  const transcript = recent
    .map(item => `${item.role === 'assistant' ? botName : 'User'}: ${item.content}`)
    .join('\n');

  return [
    `${ASSISTANT_RULES} Your name is ${botName}.`,
    transcript,
    `User: ${message}`,
    'Answer the user directly.',
  ].filter(Boolean).join('\n');
}

async function callProvider(name, url, params, headers) {
  let response;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await axios.get(url, {
        params, timeout: 18_000,
        headers: { 'User-Agent': 'Queen-MD-Bot/3.1', ...headers },
      });
      break;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      if (attempt === 0 && (status === 408 || status === 425 || status === 429 || status >= 500)) {
        await new Promise(resolve => setTimeout(resolve, 900));
        continue;
      }
      throw error;
    }
  }
  if (!response) throw lastError || new Error(`${name} request failed`);
  const { data } = response;

  if (data?.success === false || data?.status === false) {
    throw new Error(data?.message || `${name} returned an error`);
  }

  const reply = textFromResponse(data);
  if (!reply) throw new Error(`${name} returned an empty response`);
  return reply;
}

export async function getAssistantReply({ message, history = [], botName = 'Queen MD Bot' }) {
  const prompt = buildPrompt(message, history, botName);
  const providers = [
    ...(CUSTOM_URL ? [{
      name: 'configured AI',
      url: CUSTOM_URL,
      params: { prompt },
    }] : []),
    ...(DAVID_API_KEY ? [
      {
        name: 'David Claude Sonnet 4.6',
        url: 'https://apis.davidcyriltech.my.id/ai/claude-sonnet-4.6',
        params: { prompt },
        headers: DAVID_HEADERS,
      },
      {
        name: 'David GPT-5',
        url: 'https://apis.davidcyriltech.my.id/ai/gpt-5',
        params: { prompt },
        headers: DAVID_HEADERS,
      },
      {
        name: 'David GPT-5.3 Chat',
        url: 'https://apis.davidcyriltech.my.id/ai/gpt-5.3-chat',
        params: { prompt },
        headers: DAVID_HEADERS,
      },
      {
        name: 'David GPT-4o',
        url: 'https://apis.davidcyriltech.my.id/ai/gpt-4o',
        params: { prompt },
        headers: DAVID_HEADERS,
      },
    ] : []),
    {
      name: 'EliteProtech ChatGPT',
      url: 'https://eliteprotech-apis.zone.id/ai/chatgpt',
      params: { prompt },
    },
    {
      name: 'EliteProtech NoteGPT',
      url: 'https://eliteprotech-apis.zone.id/ai/notegpt',
      params: { prompt },
    },
    {
      name: 'AI fallback',
      url: 'https://all-in-1-ais.officialhectormanuel.workers.dev/',
      params: { query: prompt, model: process.env.AI_MODEL || 'gemini' },
    },
    {
      name: 'GPT fallback',
      url: 'https://api.yupra.my.id/api/ai/gpt5',
      params: { text: prompt },
    },
  ];

  const errors = [];
  const primary = providers.slice(0, CUSTOM_URL ? 3 : 2);
  const rest = providers.slice(CUSTOM_URL ? 3 : 2);
  const offset = (getAssistantReply._offset = ((getAssistantReply._offset || 0) + 1) % primary.length);
  const ordered = [...primary.slice(offset), ...primary.slice(0, offset), ...rest];
  for (const provider of ordered) {
    try {
      const reply = await callProvider(provider.name, provider.url, provider.params, provider.headers);
      if (errors.length) {
        console.warn(`[AI] ${provider.name} succeeded after fallback: ${errors.join(', ')}`);
      }
      return reply;
    } catch (error) {
      const messageText = error?.message || String(error);
      errors.push(`${provider.name}: ${messageText}`);
      console.warn(`[AI] ${provider.name} failed: ${messageText}`);
    }
  }

  throw new Error(`All AI providers failed (${errors.join(' | ')})`);
}