import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError, httpStatusFor } from './engine/errors.js';
import { SessionStore, publicView } from './store.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Each route maps a URL + body to an engine command. All of these are host-only.
const COMMAND_ROUTES = [
  ['POST', /^\/start$/, () => ({ type: 'startSession' })],
  ['POST', /^\/end$/, (_m, b) => ({ type: 'endSession', confirm: b.confirm })],
  ['PUT', /^\/mode$/, (_m, b) => ({ type: 'setMode', mode: b.mode })],
  ['POST', /^\/courts\/([\w-]+)\/next$/, (m) => ({ type: 'scheduleNextMatch', courtId: m[1] })],
  ['POST', /^\/courts\/([\w-]+)\/champion-override$/, (m, b) => ({
    type: 'championOverride', courtId: m[1], action: b.action, confirm: b.confirm,
  })],
  ['POST', /^\/matches\/([\w-]+)\/start$/, (m) => ({ type: 'startMatch', matchId: m[1] })],
  ['POST', /^\/matches\/([\w-]+)\/result$/, (m, b) => ({ type: 'completeMatch', matchId: m[1], winner: b.winner })],
  ['POST', /^\/matches\/([\w-]+)\/cancel$/, (m, b) => ({
    type: 'cancelMatch', matchId: m[1], confirm: b.confirm, reason: b.reason,
  })],
  ['POST', /^\/matches\/([\w-]+)\/substitute$/, (m, b) => ({
    type: 'substitutePlayer',
    matchId: m[1],
    outPlayerId: b.outPlayerId,
    inPlayerId: b.inPlayerId ?? undefined,
    outStatus: b.outStatus,
    confirm: b.confirm,
  })],
  ['POST', /^\/players$/, (_m, b) => ({ type: 'addPlayer', name: b.name })],
  ['POST', /^\/players\/([\w-]+)\/unavailable$/, (m, b) => ({ type: 'markUnavailable', playerId: m[1], confirm: b.confirm })],
  ['POST', /^\/players\/([\w-]+)\/return$/, (m) => ({ type: 'returnToQueue', playerId: m[1] })],
  ['DELETE', /^\/players\/([\w-]+)$/, (m, b) => ({ type: 'removePlayer', playerId: m[1], confirm: b.confirm })],
];

export function createApp({ store = new SessionStore() } = {}) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, store);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (err) {
      sendError(res, err);
    }
  };
}

async function handleApi(req, res, url, store) {
  const path = url.pathname;

  if (req.method === 'POST' && path === '/api/sessions') {
    const body = await readJson(req);
    const { state, hostToken } = store.create({
      name: body.name,
      courtCount: body.courtCount === undefined ? 1 : Number(body.courtCount),
      playerNames: body.playerNames ?? [],
      mode: body.mode ?? 'fair',
    });
    return sendJson(res, 201, { session: publicView(state, store.clock()), hostToken });
  }

  const m = path.match(/^\/api\/sessions\/([\w-]+)(\/.*)?$/);
  if (!m) throw new DomainError('NOT_FOUND', 'Route not found');
  const [, sessionId, rest = ''] = m;

  if (req.method === 'GET' && rest === '') {
    const state = store.get(sessionId);
    const isHost = store.isHost(sessionId, req.headers['x-host-token']);
    return sendJson(res, 200, { session: publicView(state, store.clock()), role: isHost ? 'host' : 'viewer' });
  }
  if (req.method === 'GET' && rest === '/events') {
    const state = store.get(sessionId);
    const since = Number(url.searchParams.get('since') ?? 0);
    return sendJson(res, 200, { events: state.events.filter((e) => e.seq > since), version: state.version });
  }

  for (const [method, pattern, build] of COMMAND_ROUTES) {
    const match = rest.match(pattern);
    if (!match || req.method !== method) continue;
    store.get(sessionId); // 404 before 401 for unknown sessions
    if (!req.headers['x-host-token']) throw new DomainError('UNAUTHORIZED', 'Host token required');
    if (!store.isHost(sessionId, req.headers['x-host-token'])) throw new DomainError('FORBIDDEN', 'Invalid host token');
    const body = await readJson(req);
    const command = build(match, body);
    const ifMatch = req.headers['if-match'];
    const expectedVersion = ifMatch !== undefined ? Number(String(ifMatch).replace(/"/g, '')) : undefined;
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
      throw new DomainError('VALIDATION_ERROR', 'If-Match must be an integer version');
    }
    const idempotencyKey = req.headers['idempotency-key'] || undefined;
    const outcome = store.dispatch(sessionId, command, { idempotencyKey, expectedVersion });
    return sendJson(res, 200, {
      result: outcome.result,
      replayed: outcome.replayed,
      session: publicView(store.get(sessionId), store.clock()),
    });
  }
  throw new DomainError('NOT_FOUND', 'Route not found');
}

async function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new DomainError('VALIDATION_ERROR', 'Body must be a JSON object');
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new DomainError('NOT_FOUND', 'Not found');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(normalize(PUBLIC_DIR)) || filePath.includes(`${sep}..`)) {
    throw new DomainError('NOT_FOUND', 'Not found');
  }
  let content;
  try {
    content = await readFile(filePath);
  } catch {
    throw new DomainError('NOT_FOUND', 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  if (res.headersSent) return res.end();
  if (err instanceof DomainError) {
    return sendJson(res, httpStatusFor(err.code), { error: { code: err.code, message: err.message, details: err.details } });
  }
  console.error(err);
  return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  const store = new SessionStore({ dataFile: process.env.DATA_FILE || null });
  createServer(createApp({ store })).listen(port, () => {
    console.log(`Badminton matchmaking running at http://localhost:${port}`);
  });
}
