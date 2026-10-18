/**
 * Management HTTP API for Queen MD Bot
 *
 * Exposes a lightweight REST API that the web admin dashboard calls remotely.
 * Protected by MANAGEMENT_API_KEY — every request must include:
 *   X-API-Key: <your key>
 *
 * Endpoints:
 *   GET  /management/status         — bot uptime, sessions, feature states
 *   POST /management/toggle         — toggle a bot feature on/off
 *   POST /management/session/stop   — disconnect a session
 *
 * Start it: startManagementServer(port)  (called from index.js)
 */

import { createServer } from 'http';
import { getSessions, stopSession, BOT_PUBLIC, setBotPublic } from './whatsapp.js';
import {
  isAutoTypingPmEnabled,
  isAutoTypingGroupEnabled,
  setAutoTypingPm,
  setAutoTypingGroup,
  setAutoTyping,
} from './features/autotyping.js';
import {
  isAutoStatusViewEnabled,
  isAutoStatusReplyEnabled,
  isAutoStatusReactionEnabled,
  getAutoStatusEmojis,
  setAutoStatusView,
  setAutoStatusReply,
  setAutoStatusReaction,
} from './features/autostatus.js';
import {
  isAutoReactPmEnabled,
  isAutoReactGroupEnabled,
  setAutoReactPm,
  setAutoReactGroup,
  setAutoReact,
} from './features/autoreact.js';
import {
  isChatbotPmEnabled,
  isChatbotGroupEnabled,
  setChatbotPm,
  setChatbotGroup,
} from './features/chatbot.js';
import { isViewOnceEnabled, setViewOnce } from './features/viewonce.js';
import { isAntiDeleteEnabled, setAntiDelete } from './features/antidelete.js';

const API_KEY     = process.env.MANAGEMENT_API_KEY || '';
const _startedAt  = Date.now();

// ── Auth middleware ───────────────────────────────────────────────────────────

function isAuthorised(req) {
  if (!API_KEY) return true; // key not configured — open (development only)
  const header = req.headers['x-api-key'] || '';
  return header === API_KEY;
}

// ── Route handlers ─────────────────────────────────────────────────────────────

function handleStatus() {
  const sessions = getSessions();
  return {
    ok:      true,
    uptime:  Math.floor((Date.now() - _startedAt) / 1000),
    sessions: getSessions(),
    features: {
      autotyping:  { pm: isAutoTypingPmEnabled(),    group: isAutoTypingGroupEnabled() },
      autostatus:  {
        view: isAutoStatusViewEnabled(),
        reply: isAutoStatusReplyEnabled(),
        react: isAutoStatusReactionEnabled(),
        emojis: getAutoStatusEmojis(),
      },
      autoreact:   { pm: isAutoReactPmEnabled(),     group: isAutoReactGroupEnabled() },
      chatbot:     { pm: isChatbotPmEnabled(),        group: isChatbotGroupEnabled() },
      viewonce:    isViewOnceEnabled(),
      antidelete:  sessions.length
        ? sessions.some(session => isAntiDeleteEnabled(session.phone))
        : isAntiDeleteEnabled(),
      antideleteSessions: sessions.map(session => ({
        phone: session.phone,
        enabled: isAntiDeleteEnabled(session.phone),
      })),
      botPublic:   BOT_PUBLIC,
    },
  };
}

function handleToggle(body) {
  const { feature, scope, value } = body;
  const v = Boolean(value);

  switch (feature) {
    case 'autotyping':
      if (scope === 'pm')    setAutoTypingPm(v);
      else if (scope === 'group') setAutoTypingGroup(v);
      else setAutoTyping(v);
      break;
    case 'autostatus': {
      if (scope === 'view') setAutoStatusView(v);
      else if (scope === 'reply') setAutoStatusReply(v);
      else if (scope === 'react') setAutoStatusReaction(v);
      else {
        setAutoStatusView(v);
        setAutoStatusReply(v);
        setAutoStatusReaction(v);
      }
      break;
    }
    case 'autoreact':
      if (scope === 'pm')    setAutoReactPm(v);
      else if (scope === 'group') setAutoReactGroup(v);
      else setAutoReact(v);
      break;
    case 'chatbot':
      if (scope === 'pm')    setChatbotPm(v);
      else if (scope === 'group') setChatbotGroup(v);
      else { setChatbotPm(v); setChatbotGroup(v); }
      break;
    case 'viewonce':
      setViewOnce(v);
      break;
    case 'antidelete':
      {
        const activeSessions = getSessions();
        if (!activeSessions.length) setAntiDelete(v);
        for (const session of activeSessions) {
          setAntiDelete(v, session.phone);
        }
      }
      break;
    case 'botPublic':
      setBotPublic(v);
      break;
    default:
      return { ok: false, error: `Unknown feature: ${feature}` };
  }

  return { ok: true, updated: { feature, scope: scope || 'global', value: v } };
}

function handleSessionStop(body) {
  const { phone } = body;
  if (!phone) return { ok: false, error: 'phone is required' };
  const stopped = stopSession(String(phone));
  return { ok: stopped, error: stopped ? undefined : 'Session not found' };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Content-Type, X-API-Key',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  });
  res.end(json);
}

export function startManagementServer(port = 5001) {
  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    const url = req.url?.split('?')[0] || '';

    if (!isAuthorised(req)) {
      return send(res, 401, { ok: false, error: 'Unauthorised' });
    }

    try {
      // GET /management/status
      if (req.method === 'GET' && url === '/management/status') {
        return send(res, 200, handleStatus());
      }

      // POST /management/toggle
      if (req.method === 'POST' && url === '/management/toggle') {
        const body   = await readBody(req);
        const result = handleToggle(body);
        return send(res, result.ok ? 200 : 400, result);
      }

      // POST /management/session/stop
      if (req.method === 'POST' && url === '/management/session/stop') {
        const body   = await readBody(req);
        const result = handleSessionStop(body);
        return send(res, result.ok ? 200 : 400, result);
      }

      // 404
      return send(res, 404, { ok: false, error: 'Not found' });

    } catch (err) {
      console.error(`[management] ${err.message}`);
      return send(res, 500, { ok: false, error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`🖥️  Management API listening on http://localhost:${port}/management`);
    if (!API_KEY) {
      console.warn(`⚠️  MANAGEMENT_API_KEY is not set — API is open (set it in .env for security)`);
    }
  });

  server.on('error', (err) => {
    console.error(`❌ Management server error: ${err.message}`);
  });

  return server;
}
