import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCommand, createSession, effectiveGames, evaluateTeamSplits, rankQueue } from '../src/engine/session.js';
import { DomainError } from '../src/engine/errors.js';
import { SessionStore } from '../src/store.js';

function session(players, { courts = 1, mode = 'fair', seed = 11, start = true, ...rest } = {}) {
  let now = 1_000_000;
  let state = createSession({ id: 'p2', courtCount: courts, playerNames: players, mode, seed, now, ...rest });
  const h = {
    get state() { return state; },
    set state(v) { state = v; },
    get now() { return now; },
    run(cmd) {
      now += 1000;
      const out = applyCommand(state, cmd, { now });
      state = out.state;
      return out.result;
    },
    playMatch(courtId = 'c1', winner = 'A') {
      const { matchId } = h.run({ type: 'scheduleNextMatch', courtId });
      h.run({ type: 'startMatch', matchId });
      h.run({ type: 'completeMatch', matchId, winner });
      return state.matches[matchId];
    },
    p: (id) => state.players[id],
  };
  if (start) h.run({ type: 'startSession' });
  return h;
}
const names = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);
const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof DomainError && e.code === code);

// ---------------------------------------------------------------------------
// Feature A — late joiner fairness baseline
// ---------------------------------------------------------------------------

describe('late joiner baseline', () => {
  it('gives a mid-session joiner the minimum effective games of active players; actual stats stay 0', () => {
    const h = session(names(8));
    h.playMatch();
    h.playMatch();
    h.playMatch(); // games now: four players at 2, four at 1
    const minEff = Math.min(...Object.values(h.state.players).map(effectiveGames));
    assert.equal(minEff, 1);
    const { playerId } = h.run({ type: 'addPlayer', name: 'มาสาย' });
    const p = h.p(playerId);
    assert.equal(p.fairnessBaseline, 1);
    assert.equal(p.gamesPlayed, 0);
    assert.equal(p.wins, 0);
    assert.equal(p.losses, 0);
    assert.equal(effectiveGames(p), 1);
  });

  it('counts waiting, playing and champion-holding players but excludes unavailable and departed ones', () => {
    const h = session(names(7), { mode: 'champion' });
    h.playMatch('c1', 'A'); // A crowned and holds the court with 1 game
    h.playMatch('c1', 'B'); // challengers crowned; exactly one player (P7) still has 0 games
    const zero = Object.values(h.state.players).find((p) => p.gamesPlayed === 0);
    h.run({ type: 'markUnavailable', playerId: zero.id }); // the only 0-game player is away
    const { playerId } = h.run({ type: 'addPlayer', name: 'ใหม่' });
    assert.equal(h.p(playerId).fairnessBaseline, 1, 'unavailable 0-game player must not drag the baseline down');
    h.run({ type: 'removePlayer', playerId });
    const second = h.run({ type: 'addPlayer', name: 'ใหม่2' });
    assert.equal(h.p(second.playerId).fairnessBaseline, 1, 'departed players are not active');
  });

  it('uses effective (not actual) games when computing a later joiner\'s baseline', () => {
    const h = session(names(4));
    h.playMatch();
    h.playMatch(); // all four at 2 games
    const a = h.run({ type: 'addPlayer', name: 'X' }); // baseline 2
    assert.equal(h.p(a.playerId).fairnessBaseline, 2);
    const b = h.run({ type: 'addPlayer', name: 'Y' }); // min effective is still 2 (X: 0 + 2)
    assert.equal(h.p(b.playerId).fairnessBaseline, 2, 'must not use X\'s actual 0 games');
  });

  it('never uses the maximum: joiner competes with the current minimum tier', () => {
    const h = session(names(6));
    h.playMatch(); // four players at 1, two at 0
    const { playerId } = h.run({ type: 'addPlayer', name: 'Z' });
    assert.equal(h.p(playerId).fairnessBaseline, 0);
  });

  it('keeps existing baselines and queue order; joiner goes to the back without inherited waiting time', () => {
    const h = session(names(8));
    h.playMatch();
    const first = h.run({ type: 'addPlayer', name: 'J1' });
    h.playMatch();
    const queueBefore = [...h.state.queue];
    const baselinesBefore = Object.fromEntries(Object.values(h.state.players).map((p) => [p.id, p.fairnessBaseline]));
    const { playerId } = h.run({ type: 'addPlayer', name: 'J2' });
    assert.deepEqual(h.state.queue.slice(0, -1), queueBefore, 'existing queue order untouched');
    assert.equal(h.state.queue.at(-1), playerId);
    for (const [id, b] of Object.entries(baselinesBefore)) assert.equal(h.p(id).fairnessBaseline, b);
    const p = h.p(playerId);
    assert.equal(p.totalWaitMs, 0);
    assert.equal(p.queuedAt, h.now);
    assert.equal(p.waitPasses, 0);
    assert.ok(h.p(first.playerId));
  });

  it('ranks by effective games, so a joiner does not jump ahead of players who have played less', () => {
    const h = session(names(10));
    h.playMatch();
    h.playMatch(); // 8 players at 1, 2 players at 0
    const { playerId } = h.run({ type: 'addPlayer', name: 'J' }); // baseline 0 (two 0-game players waiting)
    assert.equal(h.p(playerId).fairnessBaseline, 0);
    h.playMatch(); // the two 0-game players + J + one more
    h.playMatch();
    const late = h.run({ type: 'addPlayer', name: 'K' });
    const k = h.p(late.playerId);
    assert.ok(k.fairnessBaseline >= 1);
    const ranked = rankQueue(h.state);
    for (const id of ranked.slice(0, ranked.indexOf(k.id))) {
      assert.ok(effectiveGames(h.p(id)) <= effectiveGames(k), 'everyone ahead has ≤ effective games');
    }
    for (const id of ranked.slice(ranked.indexOf(k.id) + 1)) {
      assert.ok(effectiveGames(h.p(id)) >= effectiveGames(k));
    }
  });

  it('a temporarily unavailable player keeps their previous baseline on return', () => {
    const h = session(names(8));
    h.playMatch();
    h.playMatch();
    const { playerId } = h.run({ type: 'addPlayer', name: 'J' });
    const baseline = h.p(playerId).fairnessBaseline;
    h.run({ type: 'markUnavailable', playerId });
    h.playMatch();
    h.playMatch();
    h.run({ type: 'returnToQueue', playerId });
    assert.equal(h.p(playerId).fairnessBaseline, baseline);
  });

  it('rejoin after leaving: same identity and stats, baseline raised to the current minimum (never lowered)', () => {
    const h = session(names(8));
    h.playMatch();
    const leaver = h.state.queue[0];
    const before = { ...h.p(leaver) };
    h.run({ type: 'removePlayer', playerId: leaver });
    for (let i = 0; i < 4; i++) h.playMatch();
    h.run({ type: 'returnToQueue', playerId: leaver });
    const p = h.p(leaver);
    assert.equal(p.gamesPlayed, before.gamesPlayed);
    assert.equal(p.wins, before.wins);
    const minOthers = Math.min(...Object.values(h.state.players).filter((x) => x.id !== leaver && x.status !== 'left' && x.status !== 'unavailable').map(effectiveGames));
    assert.equal(effectiveGames(p), Math.max(before.gamesPlayed + before.fairnessBaseline, minOthers));
    assert.ok(p.fairnessBaseline >= before.fairnessBaseline);
  });

  it('uses baseline 0 when nobody is active', () => {
    const h = session(names(4));
    h.playMatch();
    for (const id of Object.keys(h.state.players)) h.run({ type: 'markUnavailable', playerId: id });
    const { playerId } = h.run({ type: 'addPlayer', name: 'คนเดียว' });
    assert.equal(h.p(playerId).fairnessBaseline, 0);
  });

  it('players added during setup get baseline 0', () => {
    const h = session(names(4), { start: false });
    const { playerId } = h.run({ type: 'addPlayer', name: 'ก่อนเริ่ม' });
    assert.equal(h.p(playerId).fairnessBaseline, 0);
  });
});

describe('persistence and legacy records', () => {
  it('baseline, wait passes and settings survive a restart with DATA_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rallymate-'));
    try {
      const file = join(dir, 'data.json');
      let t = 0;
      const a = new SessionStore({ dataFile: file, clock: () => (t += 1000) });
      const { state } = a.create({ name: 'บันทึก', courtCount: 1, playerNames: names(6) });
      a.dispatch(state.id, { type: 'startSession' });
      a.dispatch(state.id, { type: 'updateSettings', mixGroups: true });
      const { result: { matchId } } = a.dispatch(state.id, { type: 'scheduleNextMatch', courtId: 'c1' });
      a.dispatch(state.id, { type: 'startMatch', matchId });
      a.dispatch(state.id, { type: 'completeMatch', matchId, winner: 'A' });
      const { result: { playerId } } = a.dispatch(state.id, { type: 'addPlayer', name: 'มาสาย' });
      const b = new SessionStore({ dataFile: file, clock: () => (t += 1000) });
      const reloaded = b.get(state.id);
      assert.equal(reloaded.players[playerId].fairnessBaseline, a.get(state.id).players[playerId].fairnessBaseline);
      assert.equal(reloaded.config.mixGroups, true);
      assert.deepEqual(reloaded, a.get(state.id));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a Phase 1 session record (no fairnessBaseline / waitPasses / mixGroups / teamWeights) and keeps working', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rallymate-legacy-'));
    try {
      const legacy = createSession({ id: 'legacy1', courtCount: 1, playerNames: names(6), now: 1000 });
      // Strip every Phase 2 field to mimic a record written before this change.
      delete legacy.config.mixGroups;
      delete legacy.config.teamWeights;
      delete legacy.config.mix;
      for (const p of Object.values(legacy.players)) {
        delete p.fairnessBaseline;
        delete p.waitPasses;
      }
      legacy.status = 'active';
      const file = join(dir, 'data.json');
      writeFileSync(file, JSON.stringify({ sessions: [{ state: legacy, hostToken: 'tok' }] }));
      let t = 5000;
      const store = new SessionStore({ dataFile: file, clock: () => (t += 1000) });
      const { result: { matchId } } = store.dispatch('legacy1', { type: 'scheduleNextMatch', courtId: 'c1' });
      store.dispatch('legacy1', { type: 'startMatch', matchId });
      store.dispatch('legacy1', { type: 'completeMatch', matchId, winner: 'B' });
      const { result: { playerId } } = store.dispatch('legacy1', { type: 'addPlayer', name: 'ใหม่' });
      const s = store.get('legacy1');
      assert.equal(s.players[playerId].fairnessBaseline, 0, 'two legacy players still have 0 games');
      assert.equal(Object.values(s.players).filter((p) => p.gamesPlayed === 1).length, 4, 'historical stats untouched');
      store.dispatch('legacy1', { type: 'updateSettings', mixGroups: true });
      assert.equal(store.get('legacy1').config.mixGroups, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Feature C — weighted team formation (stage 2, after the four are chosen)
// ---------------------------------------------------------------------------

const sameTeam = (t, ref) => t.slice().sort().join() === ref.slice().sort().join();
const splitHas = (x, pair) => sameTeam(x.teamA, pair) || sameTeam(x.teamB, pair);

describe('weighted team formation', () => {
  it('evaluates all three 2v2 splits of the chosen four', () => {
    const h = session([{ name: 'A', skill: 3 }, { name: 'B', skill: 1 }, { name: 'C', skill: 2 }, { name: 'D', skill: 2 }]);
    const splits = evaluateTeamSplits(h.state, ['p1', 'p2', 'p3', 'p4']);
    assert.equal(splits.length, 3);
    const keys = splits.map((x) => [x.teamA.join('+'), x.teamB.join('+')].sort().join(' v '));
    assert.equal(new Set(keys).size, 3);
    assert.deepEqual(splits.map((x) => x.gap).sort(), [0, 2, 2]);
  });

  it('penalises repeated teammates and prefers fresh partners at equal skill', () => {
    const h = session(names(4));
    const m1 = h.playMatch();
    const splits = evaluateTeamSplits(h.state, ['p1', 'p2', 'p3', 'p4']);
    const repeated = splits.find((x) => splitHas(x, m1.teamA));
    assert.ok(repeated.recentTeammate > 0);
    for (const x of splits.filter((y) => y !== repeated)) assert.ok(x.score < repeated.score);
    const m2 = h.playMatch();
    assert.ok(!sameTeam(m2.teamA, m1.teamA) && !sameTeam(m2.teamB, m1.teamA), 'second match uses fresh partners');
  });

  it('weights recent teammate repeats more than older ones', () => {
    // Synthetic history (read-only scoring): A+B partnered long ago, A+C partnered recently.
    const h = session(names(8));
    const past = [
      [['p1', 'p2'], ['p5', 'p6']], // oldest: A+B
      [['p5', 'p7'], ['p6', 'p8']],
      [['p5', 'p8'], ['p6', 'p7']],
      [['p5', 'p6'], ['p7', 'p8']],
      [['p1', 'p3'], ['p7', 'p8']], // most recent: A+C
    ];
    const s = structuredClone(h.state);
    past.forEach(([teamA, teamB], i) => {
      const id = `hist${i}`;
      s.matches[id] = { id, courtId: 'c1', status: 'completed', teamA, teamB };
      s.matchOrder.push(id);
    });
    const splits = evaluateTeamSplits(s, ['p1', 'p2', 'p3', 'p4']);
    const withOld = splits.find((x) => splitHas(x, ['p1', 'p2']));
    const withRecent = splits.find((x) => splitHas(x, ['p1', 'p3']));
    const fresh = splits.find((x) => splitHas(x, ['p1', 'p4']));
    assert.equal(withOld.olderTeammate, 1);
    assert.equal(withOld.recentTeammate, 0);
    assert.equal(withRecent.recentTeammate, 1);
    assert.ok(withRecent.score > withOld.score, 'recent repeat costs more than an old one');
    assert.ok(withOld.score > fresh.score, 'an old repeat still costs something');
  });

  it('guardrail: never picks an extreme mismatch (gap > 2) to avoid repeats when a gap ≤ 2 split exists', () => {
    const h = session([{ name: 'A', skill: 3 }, { name: 'B', skill: 3 }, { name: 'C', skill: 1 }, { name: 'D', skill: 1 }], {
      teamWeights: { skillGap: 0.1, recentTeammate: 50, olderTeammate: 50, recentOpponent: 0 },
    });
    for (let i = 0; i < 6; i++) h.playMatch();
    const splits = evaluateTeamSplits(h.state, ['p1', 'p2', 'p3', 'p4']);
    assert.equal(splits.find((x) => x.gap === 4).allowed, false);
    for (let i = 0; i < 4; i++) {
      const m = h.playMatch();
      const gap = Math.abs(m.teamA.reduce((n, id) => n + h.p(id).skill, 0) - m.teamB.reduce((n, id) => n + h.p(id).skill, 0));
      assert.ok(gap <= 2, `chose gap ${gap}`);
    }
  });

  it('weights can trade a small skill gap (2) for fresh teammates, but default weights keep balance first', () => {
    // A3 B2 C2 D1 E2 F2. With B and C away, the only gap-0 split of A,D,E,F is A+D vs E+F,
    // so A+D become recent teammates. Then score the four A,B,C,D: its gap-0 split (A+D vs B+C)
    // carries exactly one recent teammate repeat; the gap-2 splits are fresh.
    const roster = [
      { name: 'A', skill: 3 }, { name: 'B', skill: 2 }, { name: 'C', skill: 2 },
      { name: 'D', skill: 1 }, { name: 'E', skill: 2 }, { name: 'F', skill: 2 },
    ];
    const prepare = (opts) => {
      const h = session(roster, opts);
      h.run({ type: 'markUnavailable', playerId: 'p2' });
      h.run({ type: 'markUnavailable', playerId: 'p3' });
      const m = h.playMatch();
      assert.ok(splitHas({ teamA: m.teamA, teamB: m.teamB }, ['p1', 'p4']), 'fixture: A+D partnered');
      h.run({ type: 'returnToQueue', playerId: 'p2' });
      h.run({ type: 'returnToQueue', playerId: 'p3' });
      return evaluateTeamSplits(h.state, ['p1', 'p2', 'p3', 'p4']).filter((x) => x.allowed).sort((a, b) => a.score - b.score);
    };
    const defaults = prepare({});
    assert.equal(defaults[0].gap, 0, 'default weights: one recent repeat is not worth a 2-point gap');
    assert.equal(defaults[0].recentTeammate, 1);
    const diversityHeavy = prepare({ teamWeights: { skillGap: 1, recentTeammate: 10, olderTeammate: 2, recentOpponent: 1 } });
    assert.equal(diversityHeavy[0].gap, 2, 'diversity-heavy weights accept gap 2 to avoid the repeat');
  });

  it('rejects invalid team weights', () => {
    rejects(() => createSession({ id: 'w', playerNames: names(4), teamWeights: { skillGap: -1 } }), 'VALIDATION_ERROR');
    rejects(() => createSession({ id: 'w', playerNames: names(4), teamWeights: { bogus: 1 } }), 'VALIDATION_ERROR');
  });

  it('identical seeds and action sequences give identical line-ups', () => {
    const roster = Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, skill: (i % 3) + 1 }));
    const replay = (seed, mix) => {
      const h = session(roster, { seed, courts: 2 });
      if (mix) h.run({ type: 'updateSettings', mixGroups: true });
      const out = [];
      for (let i = 0; i < 8; i++) {
        const m = h.playMatch(i % 2 ? 'c2' : 'c1', i % 3 ? 'A' : 'B');
        out.push(`${m.teamA}|${m.teamB}`);
      }
      return out;
    };
    assert.deepEqual(replay(5, false), replay(5, false));
    assert.deepEqual(replay(5, true), replay(5, true));
  });
});

// ---------------------------------------------------------------------------
// Feature B — optional Mix Groups (stage 1 candidate selection)
// ---------------------------------------------------------------------------

/** Advances a 2-court session one scheduling at a time, calling inspect(pre, match) each time. */
function driveTwoCourts(h, steps, inspect, winner = 'A') {
  for (let i = 0; i < steps; i++) {
    const courtId = i % 2 ? 'c2' : 'c1';
    const court = h.state.courts.find((c) => c.id === courtId);
    if (court.currentMatchId) {
      h.run({ type: 'startMatch', matchId: court.currentMatchId });
      h.run({ type: 'completeMatch', matchId: court.currentMatchId, winner });
    }
    const pre = structuredClone(h.state);
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId });
    inspect(pre, h.state.matches[matchId]);
  }
}

describe('mix groups', () => {
  it('defaults to OFF and the host can toggle it before and during a session', () => {
    const h = session(names(8), { start: false });
    assert.equal(h.state.config.mixGroups, false);
    assert.equal(h.run({ type: 'updateSettings', mixGroups: true }).changed, true);
    h.run({ type: 'startSession' });
    h.playMatch();
    h.run({ type: 'updateSettings', mixGroups: false });
    assert.equal(h.state.config.mixGroups, false);
    assert.equal(h.run({ type: 'updateSettings', mixGroups: false }).changed, false);
    assert.ok(h.state.events.some((e) => e.type === 'SETTINGS_CHANGED'));
    rejects(() => h.run({ type: 'updateSettings', mixGroups: 'yes' }), 'VALIDATION_ERROR');
  });

  it('never picks a player with more effective games over one with fewer', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = session(names(13), { courts: 2, seed });
      h.run({ type: 'updateSettings', mixGroups: true });
      driveTwoCourts(h, 14, (pre, m) => {
        const picked = [...m.teamA, ...m.teamB];
        const pickedMax = Math.max(...picked.map((id) => effectiveGames(pre.players[id])));
        for (const id of pre.queue.filter((x) => !picked.includes(x))) {
          assert.ok(effectiveGames(pre.players[id]) >= pickedMax, `seed ${seed}: bypassed ${id} with fewer effective games`);
        }
      });
    }
  });

  it('respects the waiting tolerance and never bypasses a protected (long-waiting) player', () => {
    for (const seed of [1, 2, 3, 4]) {
      const h = session(names(14), { courts: 2, seed });
      h.run({ type: 'updateSettings', mixGroups: true });
      driveTwoCourts(h, 16, (pre, m) => {
        const picked = [...m.teamA, ...m.teamB];
        const protectAt = Math.ceil(pre.queue.length / 4) + pre.config.mix.extraWaitsBeforeProtect;
        for (const a of picked) {
          for (const b of pre.queue.filter((id) => !picked.includes(id))) {
            const pa = pre.players[a];
            const pb = pre.players[b];
            if (effectiveGames(pa) !== effectiveGames(pb)) continue;
            assert.ok(pb.waitPasses <= pa.waitPasses + pre.config.mix.waitTolerance, `seed ${seed}: tolerance broken`);
            assert.ok(!(pb.waitPasses >= protectAt && pa.waitPasses < protectAt), `seed ${seed}: bypassed a protected player`);
          }
        }
      }, 'B');
    }
  });

  it('improves group-of-four diversity where mixing is possible (10 players, 1 court)', () => {
    const repeatedGroups = (mix) => {
      let total = 0;
      for (const seed of [1, 2, 3, 4, 5]) {
        const h = session(names(10), { seed });
        if (mix) h.run({ type: 'updateSettings', mixGroups: true });
        const seen = new Set();
        for (let i = 0; i < 25; i++) {
          const m = h.playMatch('c1', i % 2 ? 'A' : 'B');
          const key = [...m.teamA, ...m.teamB].sort().join();
          if (seen.has(key)) total++;
          seen.add(key);
        }
      }
      return total;
    };
    const off = repeatedGroups(false);
    const on = repeatedGroups(true);
    assert.ok(on < off, `repeated groups of four: OFF ${off}, ON ${on}`);
  });

  it('does not break Champion Mode: champion pair kept, streak cap 2', () => {
    const h = session(names(10), { mode: 'champion', seed: 3 });
    h.run({ type: 'updateSettings', mixGroups: true });
    const m1 = h.playMatch('c1', 'A');
    const champ = h.state.courts[0].champion;
    assert.deepEqual(champ.team, m1.teamA);
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    assert.deepEqual(h.state.matches[matchId].teamA, champ.team, 'mix never replaces champions');
    h.run({ type: 'startMatch', matchId });
    h.run({ type: 'completeMatch', matchId, winner: 'A' });
    assert.equal(h.state.matches[matchId].outcome, 'rotate_max_wins');
    assert.equal(h.state.courts[0].champion, null);
  });
});
