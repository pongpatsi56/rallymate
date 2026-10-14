// Phase 2 hardening: gaps found while re-checking the regression list.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, assertInvariants, createSession, effectiveGames } from '../src/engine/session.js';
import { elapsedMatchMinutesByPlayer } from '../sim/runner.js';

function session(players, { courts = 1, mode = 'fair', seed = 21, ...rest } = {}) {
  let now = 0;
  let state = createSession({ id: 'hard', courtCount: courts, playerNames: players, mode, seed, now, ...rest });
  const h = {
    get state() { return state; },
    set state(v) { state = v; },
    tick(ms = 60_000) { now += ms; },
    run(cmd) {
      now += 1000;
      const out = applyCommand(state, cmd, { now });
      state = out.state;
      return out.result;
    },
    p: (id) => state.players[id],
  };
  h.run({ type: 'startSession' });
  return h;
}
const names = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

describe('front-of-queue returns keep top waiting priority (Mix Groups relies on waitPasses)', () => {
  it('players returned by a cancellation get the highest wait-pass count in the queue', () => {
    const h = session(names(12), { courts: 2 });
    h.run({ type: 'updateSettings', mixGroups: true });
    const a = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    h.run({ type: 'scheduleNextMatch', courtId: 'c2' }); // remaining four have now been passed twice
    const top = Math.max(...h.state.queue.map((id) => h.p(id).waitPasses));
    assert.ok(top >= 1);
    h.run({ type: 'cancelMatch', matchId: a.matchId });
    const returned = [...h.state.matches[a.matchId].teamA, ...h.state.matches[a.matchId].teamB];
    for (const id of returned) assert.equal(h.p(id).waitPasses, top);
    assert.deepEqual(h.state.queue.slice(0, 4), returned, 'and they are at the front of the queue');
  });

  it('a player substituted out back to the queue gets the highest wait-pass count', () => {
    const h = session(names(10));
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    const top = Math.max(...h.state.queue.map((id) => h.p(id).waitPasses));
    const out = h.state.matches[matchId].teamA[0];
    h.run({ type: 'substitutePlayer', matchId, outPlayerId: out });
    assert.equal(h.p(out).waitPasses, top);
    assert.equal(h.state.queue[0], out);
  });
});

describe('multi-court asynchronous finishes with Mix ON, late joiners, cancellations and substitutions', () => {
  it('keeps every invariant, never double-assigns, and never touches baselines or real stats', () => {
    for (const seed of [1, 2, 3]) {
      const h = session(names(15), { courts: 3, seed });
      h.run({ type: 'updateSettings', mixGroups: true });
      for (const c of ['c1', 'c2', 'c3']) {
        const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: c });
        h.run({ type: 'startMatch', matchId });
      }
      // Courts finish out of order: c3, c1, c3, c2, ...
      const order = ['c3', 'c1', 'c3', 'c2', 'c1', 'c3', 'c2', 'c2', 'c1', 'c3', 'c1', 'c2'];
      const baselines = new Map();
      order.forEach((courtId, i) => {
        h.tick(60_000 * (1 + (i % 4)));
        const court = h.state.courts.find((c) => c.id === courtId);
        const m = h.state.matches[court.currentMatchId];
        if (i === 3) {
          h.run({ type: 'cancelMatch', matchId: m.id, confirm: true });
        } else {
          if (i === 5) h.run({ type: 'substitutePlayer', matchId: m.id, outPlayerId: m.teamB[0], confirm: true });
          h.run({ type: 'completeMatch', matchId: m.id, winner: i % 2 ? 'A' : 'B' });
        }
        if (i === 2 || i === 6) {
          const { playerId } = h.run({ type: 'addPlayer', name: `late${i}` });
          baselines.set(playerId, h.p(playerId).fairnessBaseline);
        }
        const { matchId } = h.run({ type: 'scheduleNextMatch', courtId });
        h.run({ type: 'startMatch', matchId });
        assertInvariants(h.state);
        const onCourt = h.state.courts.flatMap((c) => {
          const cm = h.state.matches[c.currentMatchId];
          return cm ? [...cm.teamA, ...cm.teamB] : [];
        });
        assert.equal(new Set(onCourt).size, onCourt.length, `seed ${seed}: someone is on two courts`);
      });
      for (const [id, b] of baselines) assert.equal(h.p(id).fairnessBaseline, b, 'baseline is fixed at join time');
      const completed = Object.values(h.state.matches).filter((m) => m.status === 'completed');
      for (const p of Object.values(h.state.players)) {
        const credit = completed.filter((m) => [...m.teamA, ...m.teamB].includes(p.id)).length;
        assert.equal(p.gamesPlayed, credit, `seed ${seed}: ${p.id} game credit`);
        assert.equal(effectiveGames(p), p.gamesPlayed + p.fairnessBaseline);
      }
    }
  });
});

describe('legacy sessions with Mix Groups', () => {
  it('a Phase 1 record (no waitPasses / mix config) can switch Mix ON and schedule safely', () => {
    let state = createSession({ id: 'old', courtCount: 2, playerNames: names(11), now: 0 });
    delete state.config.mix;
    delete state.config.mixGroups;
    delete state.config.teamWeights;
    for (const p of Object.values(state.players)) {
      delete p.waitPasses;
      delete p.fairnessBaseline;
    }
    let now = 0;
    const run = (cmd) => {
      now += 1000;
      const out = applyCommand(state, cmd, { now });
      state = out.state;
      return out.result;
    };
    run({ type: 'startSession' });
    run({ type: 'updateSettings', mixGroups: true });
    assert.ok(state.config.mix, 'mix defaults are filled in on first use');
    for (let i = 0; i < 6; i++) {
      const courtId = i % 2 ? 'c2' : 'c1';
      const court = state.courts.find((c) => c.id === courtId);
      if (court.currentMatchId) run({ type: 'completeMatch', matchId: court.currentMatchId, winner: 'A' });
      const { matchId } = run({ type: 'scheduleNextMatch', courtId });
      run({ type: 'startMatch', matchId });
    }
    assertInvariants(state);
  });
});

describe('elapsed match duration metric (participation statistic, not active play time)', () => {
  it('sums endedAt - startedAt of completed matches, from the substitution time for mid-match entrants', () => {
    const h = session(names(6));
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    h.run({ type: 'startMatch', matchId });
    const startedAt = h.state.matches[matchId].startedAt;
    h.tick(5 * 60_000);
    const out = h.state.matches[matchId].teamA[0];
    const { inPlayerId } = h.run({ type: 'substitutePlayer', matchId, outPlayerId: out, confirm: true });
    const subAt = h.state.matches[matchId].substitutions[0].at;
    h.tick(10 * 60_000);
    h.run({ type: 'completeMatch', matchId, winner: 'A' });
    const m = h.state.matches[matchId];
    const { minutes, missing } = elapsedMatchMinutesByPlayer(h.state);
    assert.equal(missing, 0);
    assert.equal(minutes.get(m.teamB[0]), (m.endedAt - startedAt) / 60_000);
    assert.equal(minutes.get(inPlayerId), (m.endedAt - subAt) / 60_000, 'substitute counted from entry');
    assert.equal(minutes.has(out), false, 'substituted-out player has no completed appearance');
  });

  it('excludes cancelled matches and reports matches missing timestamps instead of guessing', () => {
    const h = session(names(8));
    const a = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    h.run({ type: 'startMatch', matchId: a.matchId });
    h.run({ type: 'cancelMatch', matchId: a.matchId, confirm: true });
    const b = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    h.run({ type: 'startMatch', matchId: b.matchId });
    h.run({ type: 'completeMatch', matchId: b.matchId, winner: 'B' });
    const broken = structuredClone(h.state);
    broken.matches[b.matchId].startedAt = null;
    assert.equal(elapsedMatchMinutesByPlayer(h.state).minutes.size, 4, 'only the completed match counts');
    const r = elapsedMatchMinutesByPlayer(broken);
    assert.equal(r.missing, 1);
    assert.equal(r.minutes.size, 0);
  });
});
