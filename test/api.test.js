import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { SessionStore } from '../src/store.js';

let server;
let base;

before(async () => {
  server = createServer(createApp({ store: new SessionStore() }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function api(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Host-Token': token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function newSession(opts = {}) {
  const playerNames = Array.from({ length: opts.players ?? 8 }, (_, i) => `ผู้เล่น${i + 1}`);
  const { status, json } = await api('POST', '/api/sessions', {
    body: { name: 'ก๊วนทดสอบ', courtCount: opts.courts ?? 1, playerNames, mode: opts.mode },
  });
  assert.equal(status, 201);
  const id = json.session.id;
  const token = json.hostToken;
  await api('POST', `/api/sessions/${id}/start`, { token });
  return { id, token, s: (path) => `/api/sessions/${id}${path}` };
}

describe('HTTP API', () => {
  it('creates a session in Fair mode and never leaks the host token to viewers', async () => {
    const { id, token } = await newSession();
    const viewer = await api('GET', `/api/sessions/${id}`);
    assert.equal(viewer.status, 200);
    assert.equal(viewer.json.role, 'viewer');
    assert.equal(viewer.json.session.mode, 'fair');
    assert.ok(!JSON.stringify(viewer.json).includes(token));
    const host = await api('GET', `/api/sessions/${id}`, { token });
    assert.equal(host.json.role, 'host');
  });

  it('rejects admin actions from viewers and wrong tokens', async () => {
    const { s } = await newSession();
    const anon = await api('PUT', s('/mode'), { body: { mode: 'champion' } });
    assert.equal(anon.status, 401);
    const wrong = await api('PUT', s('/mode'), { body: { mode: 'champion' }, token: 'nope' });
    assert.equal(wrong.status, 403);
    const missing = await api('PUT', '/api/sessions/doesnotexist/mode', { body: { mode: 'champion' }, token: 'x' });
    assert.equal(missing.status, 404);
  });

  it('runs a champion flow end-to-end with pending mode change', async () => {
    const { s, token } = await newSession();
    let r = await api('POST', s('/courts/c1/next'), { token });
    const matchId = r.json.result.matchId;
    await api('POST', s(`/matches/${matchId}/start`), { token });
    r = await api('PUT', s('/mode'), { token, body: { mode: 'champion' } });
    assert.deepEqual(r.json.result.pendingCourts, ['c1']);
    assert.equal(r.json.session.courts[0].pendingMode, 'champion');
    r = await api('POST', s(`/matches/${matchId}/result`), { token, body: { winner: 'A' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.session.courts[0].effectiveMode, 'champion');

    r = await api('GET', s('/events?since=0'));
    const types = r.json.events.map((e) => e.type);
    assert.ok(types.includes('MODE_CHANGE_REQUESTED'));
    assert.ok(types.includes('MODE_CHANGE_APPLIED'));
  });

  it('returns 428 when confirmation is required', async () => {
    const { s, token } = await newSession();
    let r = await api('POST', s('/courts/c1/next'), { token });
    const matchId = r.json.result.matchId;
    await api('POST', s(`/matches/${matchId}/start`), { token });
    r = await api('POST', s(`/matches/${matchId}/cancel`), { token, body: {} });
    assert.equal(r.status, 428);
    assert.equal(r.json.error.code, 'CONFIRMATION_REQUIRED');
    r = await api('POST', s(`/matches/${matchId}/cancel`), { token, body: { confirm: true } });
    assert.equal(r.status, 200);
  });

  it('replays duplicate submissions with the same Idempotency-Key without re-applying', async () => {
    const { s, token } = await newSession();
    let r = await api('POST', s('/courts/c1/next'), { token });
    const matchId = r.json.result.matchId;
    await api('POST', s(`/matches/${matchId}/start`), { token });
    const headers = { 'Idempotency-Key': 'result-1' };
    const first = await api('POST', s(`/matches/${matchId}/result`), { token, body: { winner: 'A' }, headers });
    const second = await api('POST', s(`/matches/${matchId}/result`), { token, body: { winner: 'A' }, headers });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.json.replayed, true);
    assert.equal(second.json.session.version, first.json.session.version);
    const games = Object.values(second.json.session.players).reduce((n, p) => n + p.gamesPlayed, 0);
    assert.equal(games, 4);

    const mismatch = await api('POST', s(`/matches/${matchId}/result`), { token, body: { winner: 'B' }, headers });
    assert.equal(mismatch.status, 422);
  });

  it('only accepts one of several concurrent result submissions', async () => {
    const { s, token } = await newSession();
    let r = await api('POST', s('/courts/c1/next'), { token });
    const matchId = r.json.result.matchId;
    await api('POST', s(`/matches/${matchId}/start`), { token });
    const results = await Promise.all(
      ['A', 'B', 'A', 'B', 'A'].map((winner) => api('POST', s(`/matches/${matchId}/result`), { token, body: { winner } })),
    );
    const ok = results.filter((x) => x.status === 200);
    assert.equal(ok.length, 1);
    assert.ok(results.filter((x) => x.status === 409).every((x) => x.json.error.code === 'MATCH_ALREADY_FINISHED'));
    r = await api('GET', s(''));
    const games = Object.values(r.json.session.players).reduce((n, p) => n + p.gamesPlayed, 0);
    assert.equal(games, 4);
  });

  it('rejects stale writes with If-Match version conflicts', async () => {
    const { s, token } = await newSession();
    const { json } = await api('GET', s(''));
    const v = json.session.version;
    const ok = await api('POST', s('/players'), { token, body: { name: 'ใหม่1' }, headers: { 'If-Match': String(v) } });
    assert.equal(ok.status, 200);
    const stale = await api('POST', s('/players'), { token, body: { name: 'ใหม่2' }, headers: { 'If-Match': String(v) } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT');
  });

  it('supports player management routes', async () => {
    const { s, token } = await newSession();
    let r = await api('POST', s('/players'), { token, body: { name: 'มาสาย' } });
    const pid = r.json.result.playerId;
    r = await api('POST', s(`/players/${pid}/unavailable`), { token, body: {} });
    assert.equal(r.json.session.players[pid].status, 'unavailable');
    r = await api('POST', s(`/players/${pid}/return`), { token });
    assert.equal(r.json.session.players[pid].status, 'waiting');
    r = await api('DELETE', s(`/players/${pid}`), { token });
    assert.equal(r.json.session.players[pid].status, 'left');
  });

  it('accepts skill levels on create/add and lets the host change them', async () => {
    const { status, json } = await api('POST', '/api/sessions', {
      body: { name: 'ฝีมือ', courtCount: 1, playerNames: [{ name: 'เก่ง', skill: 3 }, 'กลาง', { name: 'ใหม่', skill: 1 }, 'อีกคน'] },
    });
    assert.equal(status, 201);
    const id = json.session.id;
    const token = json.hostToken;
    assert.deepEqual(Object.values(json.session.players).map((p) => p.skill), [3, 2, 1, 2]);
    let r = await api('POST', `/api/sessions/${id}/players`, { token, body: { name: 'มาสาย', skill: 1 } });
    const pid = r.json.result.playerId;
    assert.equal(r.json.session.players[pid].skill, 1);
    r = await api('PUT', `/api/sessions/${id}/players/${pid}/skill`, { token, body: { skill: 3 } });
    assert.equal(r.json.session.players[pid].skill, 3);
    r = await api('PUT', `/api/sessions/${id}/players/${pid}/skill`, { token, body: { skill: 9 } });
    assert.equal(r.status, 400);
    r = await api('PUT', `/api/sessions/${id}/players/${pid}/skill`, { body: { skill: 1 } });
    assert.equal(r.status, 401);
  });

  it('Mix Groups setting: default OFF, host-only toggle, visible to viewers, idempotent and version-checked', async () => {
    const { id, token, s } = await newSession();
    let r = await api('GET', s(''));
    assert.equal(r.json.session.config.mixGroups, false);
    r = await api('PUT', s('/settings'), { body: { mixGroups: true } });
    assert.equal(r.status, 401);
    r = await api('PUT', s('/settings'), { body: { mixGroups: true }, token: 'wrong' });
    assert.equal(r.status, 403);
    const v = (await api('GET', s(''))).json.session.version;
    const headers = { 'Idempotency-Key': 'mix-on', 'If-Match': String(v) };
    const first = await api('PUT', s('/settings'), { token, body: { mixGroups: true }, headers });
    assert.equal(first.status, 200);
    assert.equal(first.json.session.config.mixGroups, true);
    const replay = await api('PUT', s('/settings'), { token, body: { mixGroups: true }, headers });
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.session.version, first.json.session.version);
    const stale = await api('PUT', s('/settings'), { token, body: { mixGroups: false }, headers: { 'If-Match': String(v) } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT');
    r = await api('PUT', s('/settings'), { token, body: { mixGroups: 'on' } });
    assert.equal(r.status, 400);
    r = await api('GET', `/api/sessions/${id}`);
    assert.equal(r.json.role, 'viewer');
    assert.equal(r.json.session.config.mixGroups, true, 'viewers can see the setting');
  });

  it('exposes the late-joiner baseline without changing real games played', async () => {
    const { s, token } = await newSession({ players: 4 });
    for (let i = 0; i < 2; i++) {
      const { json } = await api('POST', s('/courts/c1/next'), { token });
      await api('POST', s(`/matches/${json.result.matchId}/start`), { token });
      await api('POST', s(`/matches/${json.result.matchId}/result`), { token, body: { winner: 'A' } });
    }
    const r = await api('POST', s('/players'), { token, body: { name: 'มาสาย' } });
    const p = r.json.session.players[r.json.result.playerId];
    assert.equal(p.gamesPlayed, 0);
    assert.equal(p.fairnessBaseline, 2);
  });

  it('substitutes and overrides champions through the API', async () => {
    const { s, token } = await newSession({ mode: 'champion' });
    let r = await api('POST', s('/courts/c1/next'), { token });
    let matchId = r.json.result.matchId;
    await api('POST', s(`/matches/${matchId}/start`), { token });
    await api('POST', s(`/matches/${matchId}/result`), { token, body: { winner: 'A' } });
    r = await api('POST', s('/courts/c1/next'), { token });
    matchId = r.json.result.matchId;
    const challenger = r.json.session.matches[matchId].teamB[0];
    r = await api('POST', s(`/matches/${matchId}/substitute`), { token, body: { outPlayerId: challenger } });
    assert.equal(r.status, 200);
    await api('POST', s(`/matches/${matchId}/start`), { token });
    r = await api('POST', s('/courts/c1/champion-override'), { token, body: { action: 'release_after_match' } });
    assert.equal(r.status, 428);
    r = await api('POST', s('/courts/c1/champion-override'), { token, body: { action: 'release_after_match', confirm: true } });
    assert.equal(r.json.session.courts[0].pendingOverride, 'release');
  });

  it('validates bodies', async () => {
    const res = await fetch(`${base}/api/sessions`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
    const r = await api('POST', '/api/sessions', { body: { courtCount: 99 } });
    assert.equal(r.status, 400);
  });

  it('serves the Thai frontend', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('lang="th"'));
    const traversal = await fetch(`${base}/..%2Fpackage.json`);
    assert.equal(traversal.status, 404);
  });
});

describe('persistence', () => {
  it('reloads sessions from the data file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'badminton-'));
    try {
      const file = join(dir, 'data.json');
      const a = new SessionStore({ dataFile: file });
      const { state, hostToken } = a.create({ name: 'บันทึก', courtCount: 1, playerNames: ['ก', 'ข', 'ค', 'ง'] });
      a.dispatch(state.id, { type: 'startSession' });
      const b = new SessionStore({ dataFile: file });
      assert.equal(b.get(state.id).status, 'active');
      assert.ok(b.isHost(state.id, hostToken));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
