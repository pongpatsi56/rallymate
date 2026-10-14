import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createSession, evaluateTeamSplits, rankQueue } from '../src/engine/session.js';
import { DomainError } from '../src/engine/errors.js';

const team = (s, ids) => ids.reduce((n, id) => n + (s.players[id].skill ?? 2), 0);
const pairKey = (a, b) => [a, b].sort().join('|');

function session(players, { courts = 1, mode = 'fair', seed = 7 } = {}) {
  let now = 1000;
  let state = createSession({ id: 'fair', courtCount: courts, playerNames: players, mode, seed, now });
  const run = (cmd) => {
    now += 1000;
    const out = applyCommand(state, cmd, { now });
    state = out.state;
    return out.result;
  };
  run({ type: 'startSession' });
  return { get state() { return state; }, run };
}

describe('skill levels', () => {
  it('defaults to Intermediate (2) and accepts Beginner/Advanced', () => {
    const h = session(['เอ', { name: 'บี', skill: 1 }, { name: 'ซี', skill: 3 }, 'ดี']);
    assert.deepEqual(Object.values(h.state.players).map((p) => p.skill), [2, 1, 3, 2]);
    const { playerId } = h.run({ type: 'addPlayer', name: 'อี', skill: 3 });
    assert.equal(h.state.players[playerId].skill, 3);
    h.run({ type: 'setPlayerSkill', playerId, skill: 1 });
    assert.equal(h.state.players[playerId].skill, 1);
    assert.throws(() => h.run({ type: 'setPlayerSkill', playerId, skill: 4 }), (e) => e instanceof DomainError && e.code === 'VALIDATION_ERROR');
    assert.throws(() => h.run({ type: 'addPlayer', name: 'เอฟ', skill: 0 }), (e) => e.code === 'VALIDATION_ERROR');
  });
});

describe('team balancing (regression: fixed [0,3] vs [1,2] split ignored skill)', () => {
  it('splits 3,1,1,3 into two balanced teams instead of 6 vs 2', () => {
    const h = session([{ name: 'A', skill: 3 }, { name: 'B', skill: 1 }, { name: 'C', skill: 1 }, { name: 'D', skill: 3 }]);
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    const m = h.state.matches[matchId];
    assert.equal(team(h.state, m.teamA), team(h.state, m.teamB));
  });

  // Phase 2 replaced strict skill-first ordering with weighted scoring (see
  // docs/fairness-audit-phase2.md); this property now checks the weighted policy.
  it('always picks a lowest-scoring split that passes the skill-gap guardrail', () => {
    const roster = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, skill: [1, 2, 2, 3][i % 4] }));
    const h = session(roster, { courts: 2 });
    for (let round = 0; round < 30; round++) {
      for (const courtId of ['c1', 'c2']) {
        const court = h.state.courts.find((c) => c.id === courtId);
        if (court.currentMatchId) h.run({ type: 'completeMatch', matchId: court.currentMatchId, winner: round % 2 ? 'A' : 'B' });
        const { matchId } = h.run({ type: 'scheduleNextMatch', courtId });
        h.run({ type: 'startMatch', matchId });
        const m = h.state.matches[matchId];
        // Scheduling adds no completed match, so history here equals what the engine saw.
        const splits = evaluateTeamSplits(h.state, [...m.teamA, ...m.teamB]);
        const chosen = splits.find((x) => [x.teamA, x.teamB].some((t) => pairKey(...t) === pairKey(...m.teamA)));
        assert.ok(chosen.allowed, `match ${m.no}: chosen split violates the guardrail`);
        const bestScore = Math.min(...splits.filter((x) => x.allowed).map((x) => x.score));
        assert.equal(chosen.score, bestScore, `match ${m.no}: a better allowed split existed`);
      }
    }
  });
});

describe('participation still comes first', () => {
  it('skill never lets a player with more games jump ahead of one with fewer', () => {
    // Four advanced players have played; four beginners have not. Beginners must play next
    // even though mixing would give "better" balance.
    const roster = [
      ...['A1', 'A2', 'A3', 'A4'].map((name) => ({ name, skill: 3 })),
      ...['B1', 'B2', 'B3', 'B4'].map((name) => ({ name, skill: 1 })),
    ];
    const h = session(roster);
    // Force the advanced players into the first match by making beginners unavailable.
    for (const id of ['p5', 'p6', 'p7', 'p8']) h.run({ type: 'markUnavailable', playerId: id });
    let { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    h.run({ type: 'startMatch', matchId });
    for (const id of ['p5', 'p6', 'p7', 'p8']) h.run({ type: 'returnToQueue', playerId: id });
    h.run({ type: 'completeMatch', matchId, winner: 'A' });
    ({ matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' }));
    const m = h.state.matches[matchId];
    assert.deepEqual([...m.teamA, ...m.teamB].sort(), ['p5', 'p6', 'p7', 'p8']);
  });

  it('only chooses among equally eligible players (same games and same wait start)', () => {
    const roster = Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, skill: (i % 3) + 1 }));
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = session(roster, { seed });
      const ranked = rankQueue(h.state);
      const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
      const m = h.state.matches[matchId];
      // Everyone is tied at the start, so the candidate window is the first 8 in queue order.
      assert.ok([...m.teamA, ...m.teamB].every((id) => ranked.slice(0, 8).includes(id)));
    }
  });

  it('is deterministic for a given seed', () => {
    const roster = Array.from({ length: 9 }, (_, i) => `P${i}`);
    const play = (seed) => {
      const h = session(roster, { seed });
      const out = [];
      for (let i = 0; i < 6; i++) {
        const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
        h.run({ type: 'startMatch', matchId });
        h.run({ type: 'completeMatch', matchId, winner: 'A' });
        const m = h.state.matches[matchId];
        out.push(`${m.teamA.join(',')}v${m.teamB.join(',')}`);
      }
      return out;
    };
    assert.deepEqual(play(42), play(42));
  });
});

describe('teammate rotation', () => {
  it('cycles through all three pairings before repeating when the same four must play', () => {
    const h = session(['A', 'B', 'C', 'D']);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
      h.run({ type: 'startMatch', matchId });
      h.run({ type: 'completeMatch', matchId, winner: i % 2 ? 'A' : 'B' });
      const m = h.state.matches[matchId];
      seen.push(pairKey(...m.teamA), pairKey(...m.teamB));
    }
    assert.equal(new Set(seen).size, 6, `pairs repeated: ${seen}`);
  });

  it('champion mode: tied challengers are chosen to balance against the champion pair', () => {
    // All eight are tied at creation (0 games, same wait start).
    const roster = [
      { name: 'C1', skill: 3 }, { name: 'C2', skill: 3 }, { name: 'L1', skill: 1 }, { name: 'L2', skill: 1 },
      { name: 'X1', skill: 3 }, { name: 'X2', skill: 3 }, { name: 'Y1', skill: 1 }, { name: 'Y2', skill: 1 },
    ];
    const h = session(roster, { mode: 'champion' });
    let { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    h.run({ type: 'startMatch', matchId });
    h.run({ type: 'completeMatch', matchId, winner: 'A' });
    const champ = h.state.courts[0].champion.team;
    ({ matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' }));
    const m2 = h.state.matches[matchId];
    assert.deepEqual(m2.teamA, champ);
    assert.equal(team(h.state, m2.teamA), team(h.state, m2.teamB), 'challengers match the champion pair strength');
  });
});
