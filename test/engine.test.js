import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, assertInvariants } from '../src/engine/session.js';
import { DomainError } from '../src/engine/errors.js';
import { Harness, completedMatches } from './helpers.js';

const rejectsWith = (fn, code) =>
  assert.throws(fn, (err) => err instanceof DomainError && err.code === code, `expected ${code}`);

describe('defaults and fair mode', () => {
  it('starts in Fair mode with every court in Fair mode', () => {
    const h = new Harness();
    assert.equal(h.state.mode, 'fair');
    assert.ok(h.state.courts.every((c) => c.effectiveMode === 'fair' && c.champion === null));
  });

  it('rotates both teams out after a Fair match and prioritises fewest games', () => {
    const h = new Harness({ players: 8 });
    const { match, result } = h.playAndFinish('c1', 'A');
    assert.equal(result.outcome, 'rotate_fair');
    assert.equal(h.court().champion, null);
    for (const id of [...match.teamA, ...match.teamB]) assert.equal(h.player(id).status, 'waiting');
    const next = h.play('c1');
    const nextIds = [...next.teamA, ...next.teamB].sort();
    assert.deepEqual(nextIds, ['p5', 'p6', 'p7', 'p8']);
  });
});

describe('champion mode rules', () => {
  it('first winner is crowned, then a champion reaching 2 consecutive wins rotates out with challengers', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    assert.equal(first.result.outcome, 'champion_crowned');
    const champs = first.match.teamA;
    assert.deepEqual(h.court().champion, { team: champs, streak: 1 });
    for (const id of champs) assert.equal(h.player(id).status, 'champion_hold');

    const second = h.play('c1');
    assert.deepEqual(second.teamA, champs, 'champion pair keeps the court as team A');
    assert.equal(second.championTeam, 'A');
    const res = h.finish(second.id, 'A');
    assert.equal(res.outcome, 'rotate_max_wins');
    assert.equal(h.court().champion, null);
    for (const id of [...second.teamA, ...second.teamB]) assert.equal(h.player(id).status, 'waiting');
    assert.ok(h.eventTypes().includes('CHAMPION_ROTATED'));
  });

  it('a winning challenger becomes the new champion with a streak of 1', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const oldChamps = first.match.teamA;
    const second = h.play('c1');
    const res = h.finish(second.id, 'B');
    assert.equal(res.outcome, 'challenger_crowned');
    assert.deepEqual(h.court().champion, { team: second.teamB, streak: 1 });
    for (const id of oldChamps) assert.equal(h.player(id).status, 'waiting');
    const crowned = h.state.events.filter((e) => e.type === 'CHAMPION_CROWNED').at(-1);
    assert.deepEqual(crowned.data.replaced, oldChamps);
  });

  it('never revokes champion privileges because of fairness metrics', () => {
    // Champions play far more games than the bench, but are still retained.
    const h = new Harness({ players: 6, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const champs = first.match.teamA;
    const second = h.play('c1');
    assert.deepEqual(second.teamA, champs);
    assert.ok(h.player(champs[0]).gamesPlayed > h.player(second.teamB[0]).gamesPlayed);
  });

  it('tracks champion streaks independently per court', () => {
    const h = new Harness({ players: 12, courts: 2, mode: 'champion' });
    const m1 = h.play('c1');
    const m2 = h.play('c2');
    h.finish(m1.id, 'A');
    h.finish(m2.id, 'B');
    assert.deepEqual(h.court('c1').champion, { team: m1.teamA, streak: 1 });
    assert.deepEqual(h.court('c2').champion, { team: m2.teamB, streak: 1 });

    const m3 = h.play('c1');
    h.finish(m3.id, 'A'); // c1 champion hits 2 → rotates
    assert.equal(h.court('c1').champion, null);
    assert.deepEqual(h.court('c2').champion, { team: m2.teamB, streak: 1 }, 'c2 unaffected');
  });
});

describe('mid-session mode switching', () => {
  it('Fair → Champion during an active match: current match finishes under Fair rules, tracking starts next match', () => {
    const h = new Harness({ players: 8 });
    const m1 = h.play('c1');
    const before = { queue: [...h.state.queue] };
    const res = h.run({ type: 'setMode', mode: 'champion' });
    assert.deepEqual(res.pendingCourts, ['c1']);
    assert.equal(h.court().effectiveMode, 'fair');
    assert.equal(h.court().pendingMode, 'champion');
    assert.equal(h.state.mode, 'champion');
    assert.equal(h.match(m1.id).status, 'in_progress', 'running match untouched');
    assert.deepEqual(h.state.queue, before.queue, 'queue order preserved');

    const done = h.finish(m1.id, 'A');
    assert.equal(done.outcome, 'rotate_fair');
    assert.equal(h.court().champion, null);
    assert.equal(h.court().effectiveMode, 'champion');
    assert.equal(h.court().pendingMode, null);

    const m2 = h.playAndFinish('c1', 'B');
    assert.equal(m2.result.outcome, 'champion_crowned');
    assert.deepEqual(h.court().champion, { team: m2.match.teamB, streak: 1 });
  });

  it('Champion → Fair during an active match: champion retention and streak cleared after that match', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const champs = first.match.teamA;
    const m2 = h.play('c1');
    const statsBefore = structuredClone(h.state.players);

    h.run({ type: 'setMode', mode: 'fair' });
    assert.equal(h.court().pendingMode, 'fair');
    assert.deepEqual(h.court().champion, { team: champs, streak: 1 }, 'champion intact until match ends');

    const res = h.finish(m2.id, 'A'); // champion wins but mode switched
    assert.equal(res.outcome, 'rotate_mode_switched');
    assert.equal(h.court().champion, null);
    assert.equal(h.court().effectiveMode, 'fair');
    for (const id of champs) {
      assert.equal(h.player(id).status, 'waiting');
      assert.equal(h.player(id).gamesPlayed, statsBefore[id].gamesPlayed + 1);
      assert.equal(h.player(id).wins, statsBefore[id].wins + 1, 'the win itself still counts');
    }
    assert.equal(completedMatches(h.state).length, 2, 'match history preserved');
  });

  it('switching back before the match ends withdraws the pending change', () => {
    const h = new Harness({ players: 8 });
    h.play('c1');
    h.run({ type: 'setMode', mode: 'champion' });
    h.run({ type: 'setMode', mode: 'fair' });
    assert.equal(h.court().pendingMode, null);
  });

  it('switching to Fair while a champion holds an idle court releases them immediately to the queue', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const res = h.run({ type: 'setMode', mode: 'fair' });
    assert.deepEqual(res.appliedCourts, ['c1']);
    assert.equal(h.court().champion, null);
    for (const id of first.match.teamA) assert.equal(h.player(id).status, 'waiting');
  });

  it('applies the switch per court in a multi-court session', () => {
    const h = new Harness({ players: 12, courts: 3 });
    h.play('c1');
    const res = h.run({ type: 'setMode', mode: 'champion' });
    assert.deepEqual(res.pendingCourts, ['c1']);
    assert.deepEqual(res.appliedCourts, ['c2', 'c3']);
    assert.equal(h.court('c2').effectiveMode, 'champion');
    assert.equal(h.court('c1').effectiveMode, 'fair');
  });

  it('allows changing mode during setup', () => {
    const h = new Harness({ start: false });
    h.run({ type: 'setMode', mode: 'champion' });
    assert.equal(h.court().effectiveMode, 'champion');
  });
});

describe('champion override', () => {
  it('release after current match (champion after 1 win): champion rotates out, no win/loss from override', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const champs = first.match.teamA;
    const m2 = h.play('c1');

    rejectsWith(() => h.run({ type: 'championOverride', courtId: 'c1', action: 'release_after_match' }), 'CONFIRMATION_REQUIRED');
    h.run({ type: 'championOverride', courtId: 'c1', action: 'release_after_match', confirm: true });
    assert.equal(h.court().pendingOverride, 'release');

    const res = h.finish(m2.id, 'A');
    assert.equal(res.outcome, 'rotate_override_release');
    assert.equal(h.court().champion, null);
    for (const id of champs) assert.equal(h.player(id).status, 'waiting');
    const t = h.totals();
    assert.equal(t.games, 8, 'two matches × 4 players, nothing extra');
    assert.equal(t.wins, 4);
    assert.equal(t.losses, 4);
    const types = h.eventTypes();
    assert.ok(types.includes('CHAMPION_OVERRIDE_REQUESTED'));
    assert.ok(types.includes('CHAMPION_OVERRIDE_APPLIED'));
  });

  it('release after match still lets a winning challenger become champion', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    h.playAndFinish('c1', 'A');
    const m2 = h.play('c1');
    h.run({ type: 'championOverride', courtId: 'c1', action: 'release_after_match', confirm: true });
    const res = h.finish(m2.id, 'B');
    assert.equal(res.outcome, 'challenger_crowned');
    assert.deepEqual(h.court().champion.team, m2.teamB);
  });

  it('force rotation after current match sends both teams out regardless of winner', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    h.playAndFinish('c1', 'A');
    const m2 = h.play('c1');
    h.run({ type: 'championOverride', courtId: 'c1', action: 'force_rotate_after_match', confirm: true });
    const res = h.finish(m2.id, 'B');
    assert.equal(res.outcome, 'rotate_override_force');
    assert.equal(h.court().champion, null);
  });

  it('release immediately only when the court is between matches', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const statsBefore = structuredClone(h.state.players);
    h.run({ type: 'championOverride', courtId: 'c1', action: 'release_now', confirm: true });
    assert.equal(h.court().champion, null);
    for (const id of first.match.teamA) assert.equal(h.player(id).status, 'waiting');
    assert.deepEqual(
      Object.values(h.state.players).map((p) => [p.gamesPlayed, p.wins, p.losses]),
      Object.values(statsBefore).map((p) => [p.gamesPlayed, p.wins, p.losses]),
      'override changes no stats',
    );
    assert.equal(completedMatches(h.state).length, 1, 'completed match records kept');

    h.playAndFinish('c1', 'A');
    h.play('c1');
    rejectsWith(() => h.run({ type: 'championOverride', courtId: 'c1', action: 'release_now', confirm: true }), 'COURT_BUSY');
  });

  it('can withdraw a pending override', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    h.playAndFinish('c1', 'A');
    const m2 = h.play('c1');
    h.run({ type: 'championOverride', courtId: 'c1', action: 'release_after_match', confirm: true });
    h.run({ type: 'championOverride', courtId: 'c1', action: 'cancel_pending' });
    assert.equal(h.finish(m2.id, 'A').outcome, 'rotate_max_wins');
  });

  it('rejects overrides that make no sense', () => {
    const h = new Harness({ players: 8 });
    rejectsWith(() => h.run({ type: 'championOverride', courtId: 'c1', action: 'release_now', confirm: true }), 'NO_CHAMPION');
    h.play('c1');
    rejectsWith(() => h.run({ type: 'championOverride', courtId: 'c1', action: 'force_rotate_after_match', confirm: true }), 'NOT_CHAMPION_MODE');
    rejectsWith(() => h.run({ type: 'championOverride', courtId: 'c1', action: 'nope', confirm: true }), 'VALIDATION_ERROR');
  });
});

describe('emergency player controls', () => {
  it('adds a player mid-session who joins the queue with fairness priority', () => {
    const h = new Harness({ players: 8 });
    h.playAndFinish('c1', 'A');
    const { playerId } = h.run({ type: 'addPlayer', name: 'มาสาย' });
    assert.equal(h.player(playerId).status, 'waiting');
    assert.equal(h.state.queue.at(-1), playerId);
    const rank = h.priority();
    const veterans = rank.filter((id) => h.player(id).gamesPlayed > 0);
    assert.ok(veterans.every((id) => rank.indexOf(playerId) < rank.indexOf(id)), 'zero games → ahead of everyone who has played');
    const ev = h.state.events.at(-1);
    assert.equal(ev.type, 'PLAYER_ADDED');
    assert.equal(ev.data.midSession, true);
    rejectsWith(() => h.run({ type: 'addPlayer', name: ' มาสาย ' }), 'DUPLICATE_NAME');
    rejectsWith(() => h.run({ type: 'addPlayer', name: '   ' }), 'VALIDATION_ERROR');
  });

  it('marks a waiting player unavailable and returns them to the queue', () => {
    const h = new Harness({ players: 8 });
    h.run({ type: 'markUnavailable', playerId: 'p2' });
    assert.equal(h.player('p2').status, 'unavailable');
    assert.ok(!h.state.queue.includes('p2'));
    const m = h.play('c1');
    assert.ok(![...m.teamA, ...m.teamB].includes('p2'));
    h.run({ type: 'returnToQueue', playerId: 'p2' });
    assert.equal(h.player('p2').status, 'waiting');
    assert.equal(h.state.queue.at(-1), 'p2');
  });

  it('cannot mark a player in a match unavailable — they must be substituted', () => {
    const h = new Harness({ players: 8 });
    const m = h.play('c1');
    rejectsWith(() => h.run({ type: 'markUnavailable', playerId: m.teamA[0] }), 'PLAYER_IN_MATCH');
    rejectsWith(() => h.run({ type: 'removePlayer', playerId: m.teamA[0] }), 'PLAYER_IN_MATCH');
  });

  it('substitutes a player before the match starts without confirmation', () => {
    const h = new Harness({ players: 8 });
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    const out = h.match(matchId).teamA[0];
    const res = h.run({ type: 'substitutePlayer', matchId, outPlayerId: out, inPlayerId: 'p7' });
    assert.equal(res.inPlayerId, 'p7');
    assert.equal(h.match(matchId).teamA[0], 'p7');
    assert.equal(h.player(out).status, 'waiting');
    assert.equal(h.state.queue[0], out, 'substituted-out player keeps front-of-queue priority');
    assert.equal(h.match(matchId).substitutions[0].phase, 'scheduled');
  });

  it('picks the highest-priority waiting player when no substitute is named', () => {
    const h = new Harness({ players: 8 });
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    const expected = h.priority()[0];
    const res = h.run({ type: 'substitutePlayer', matchId, outPlayerId: h.match(matchId).teamB[1] });
    assert.equal(res.inPlayerId, expected);
  });

  it('player leaving mid-match: replacement requires confirmation and the leaver keeps their stats', () => {
    const h = new Harness({ players: 9 });
    h.playAndFinish('c1', 'A');
    const m = h.play('c1');
    const leaver = m.teamB[0];
    const statsBefore = { ...h.player(leaver) };
    rejectsWith(() => h.run({ type: 'substitutePlayer', matchId: m.id, outPlayerId: leaver, outStatus: 'left' }), 'CONFIRMATION_REQUIRED');
    const { inPlayerId } = h.run({ type: 'substitutePlayer', matchId: m.id, outPlayerId: leaver, outStatus: 'left', confirm: true });
    assert.equal(h.player(leaver).status, 'left');
    assert.equal(h.player(leaver).gamesPlayed, statsBefore.gamesPlayed);
    h.finish(m.id, 'B');
    assert.equal(h.player(leaver).gamesPlayed, statsBefore.gamesPlayed, 'no credit for a match they left');
    assert.equal(h.player(inPlayerId).wins, 1);
    assert.ok(h.player(leaver), 'player record is kept');
  });

  it('rejects substituting in a player who is not waiting (no double assignment across courts)', () => {
    const h = new Harness({ players: 8, courts: 2 });
    const m1 = h.play('c1');
    const m2 = h.play('c2');
    rejectsWith(
      () => h.run({ type: 'substitutePlayer', matchId: m1.id, outPlayerId: m1.teamA[0], inPlayerId: m2.teamA[0], confirm: true }),
      'PLAYER_NOT_AVAILABLE',
    );
    const ids1 = new Set([...m1.teamA, ...m1.teamB]);
    assert.ok([...m2.teamA, ...m2.teamB].every((id) => !ids1.has(id)));
  });

  it('substituting a champion player ends the champion streak only with confirmation', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    const champ = first.match.teamA[0];
    rejectsWith(() => h.run({ type: 'substitutePlayer', matchId, outPlayerId: champ }), 'CONFIRMATION_REQUIRED');
    h.run({ type: 'substitutePlayer', matchId, outPlayerId: champ, confirm: true });
    assert.equal(h.court().champion, null);
    assert.equal(h.match(matchId).championTeam, null);
    h.run({ type: 'startMatch', matchId });
    assert.equal(h.finish(matchId, 'A').outcome, 'champion_crowned');
  });

  it('removing a champion holding the court requires confirmation and sends the partner back to the queue', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const [a, b] = first.match.teamA;
    rejectsWith(() => h.run({ type: 'removePlayer', playerId: a }), 'CONFIRMATION_REQUIRED');
    h.run({ type: 'removePlayer', playerId: a, confirm: true });
    assert.equal(h.player(a).status, 'left');
    assert.equal(h.player(b).status, 'waiting');
    assert.equal(h.court().champion, null);
  });

  it('removes and re-admits a player who left early', () => {
    const h = new Harness({ players: 8 });
    h.run({ type: 'removePlayer', playerId: 'p3' });
    assert.equal(h.player('p3').status, 'left');
    rejectsWith(() => h.run({ type: 'removePlayer', playerId: 'p3' }), 'INVALID_PLAYER_STATE');
    h.run({ type: 'returnToQueue', playerId: 'p3' });
    assert.equal(h.player('p3').status, 'waiting');
  });
});

describe('match cancellation', () => {
  it('cancels without recording a winner and puts players back at the front of the queue', () => {
    const h = new Harness({ players: 8 });
    const m = h.play('c1');
    rejectsWith(() => h.run({ type: 'cancelMatch', matchId: m.id }), 'CONFIRMATION_REQUIRED');
    h.run({ type: 'cancelMatch', matchId: m.id, confirm: true, reason: 'ฝนตก' });
    const cancelled = h.match(m.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.winner, null);
    assert.equal(cancelled.cancelReason, 'ฝนตก');
    assert.deepEqual(h.totals(), { games: 0, wins: 0, losses: 0 });
    assert.deepEqual(h.state.queue.slice(0, 4), [...m.teamA, ...m.teamB]);
    assert.equal(h.court().currentMatchId, null);
  });

  it('scheduled matches can be cancelled without confirmation', () => {
    const h = new Harness({ players: 8 });
    const { matchId } = h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    h.run({ type: 'cancelMatch', matchId });
    assert.equal(h.match(matchId).status, 'cancelled');
  });

  it('keeps champion and streak when their match is cancelled', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const first = h.playAndFinish('c1', 'A');
    const m2 = h.play('c1');
    h.run({ type: 'cancelMatch', matchId: m2.id, confirm: true });
    assert.deepEqual(h.court().champion, { team: first.match.teamA, streak: 1 });
    for (const id of m2.teamB) assert.equal(h.player(id).status, 'waiting');
  });

  it('applies pending mode change and override when a match is cancelled', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    h.playAndFinish('c1', 'A');
    const m2 = h.play('c1');
    h.run({ type: 'setMode', mode: 'fair' });
    h.run({ type: 'cancelMatch', matchId: m2.id, confirm: true });
    assert.equal(h.court().effectiveMode, 'fair');
    assert.equal(h.court().champion, null);
    assert.equal(h.state.queue.length, 8);
  });
});

describe('duplicate submissions and atomicity', () => {
  it('rejects a second result for the same match', () => {
    const h = new Harness({ players: 8 });
    const m = h.play('c1');
    h.finish(m.id, 'A');
    const totals = h.totals();
    rejectsWith(() => h.finish(m.id, 'A'), 'MATCH_ALREADY_FINISHED');
    rejectsWith(() => h.finish(m.id, 'B'), 'MATCH_ALREADY_FINISHED');
    rejectsWith(() => h.run({ type: 'cancelMatch', matchId: m.id, confirm: true }), 'MATCH_ALREADY_FINISHED');
    assert.deepEqual(h.totals(), totals);
  });

  it('rejects scheduling twice on the same court', () => {
    const h = new Harness({ players: 12 });
    h.run({ type: 'scheduleNextMatch', courtId: 'c1' });
    rejectsWith(() => h.run({ type: 'scheduleNextMatch', courtId: 'c1' }), 'COURT_BUSY');
  });

  it('a failed command leaves the original state untouched', () => {
    const h = new Harness({ players: 8 });
    const m = h.play('c1');
    const snapshot = structuredClone(h.state);
    assert.throws(() => applyCommand(h.state, { type: 'completeMatch', matchId: m.id, winner: 'C' }, { now: 1 }));
    assert.deepEqual(h.state, snapshot);
  });

  it('requires enough players and an active session', () => {
    const h = new Harness({ players: 3 });
    rejectsWith(() => h.run({ type: 'scheduleNextMatch', courtId: 'c1' }), 'NOT_ENOUGH_PLAYERS');
    const setup = new Harness({ start: false });
    rejectsWith(() => setup.run({ type: 'scheduleNextMatch', courtId: 'c1' }), 'INVALID_SESSION_STATE');
  });

  it('never assigns a player to two courts at once', () => {
    const h = new Harness({ players: 8, courts: 3 });
    h.play('c1');
    h.play('c2');
    rejectsWith(() => h.run({ type: 'scheduleNextMatch', courtId: 'c3' }), 'NOT_ENOUGH_PLAYERS');
  });

  it('invariant checker catches a player assigned to two matches', () => {
    const h = new Harness({ players: 8, courts: 2 });
    const m1 = h.play('c1');
    const m2 = h.play('c2');
    const broken = structuredClone(h.state);
    broken.matches[m2.id].teamA[0] = m1.teamA[0];
    assert.throws(() => assertInvariants(broken), (e) => e.code === 'INVARIANT_VIOLATION');
  });
});

describe('multi-court session & statistics consistency', () => {
  it('stays consistent through a long mixed session of overrides, cancels, subs and mode switches', () => {
    const h = new Harness({ players: 14, courts: 2 });
    h.playAndFinish('c1', 'A');
    const a = h.play('c1');
    const b = h.play('c2');
    h.run({ type: 'setMode', mode: 'champion' });
    h.finish(a.id, 'B');
    h.run({ type: 'cancelMatch', matchId: b.id, confirm: true });
    h.playAndFinish('c1', 'A'); // crowned on c1
    h.playAndFinish('c2', 'B'); // crowned on c2
    const c = h.play('c1');
    h.run({ type: 'championOverride', courtId: 'c1', action: 'release_after_match', confirm: true });
    h.run({ type: 'substitutePlayer', matchId: c.id, outPlayerId: c.teamB[0], outStatus: 'unavailable', confirm: true });
    h.finish(c.id, 'A');
    h.run({ type: 'addPlayer', name: 'คนใหม่' });
    h.run({ type: 'championOverride', courtId: 'c2', action: 'release_now', confirm: true });
    const d = h.play('c2');
    h.run({ type: 'setMode', mode: 'fair' });
    h.finish(d.id, 'A');

    const completed = completedMatches(h.state);
    const t = h.totals();
    assert.equal(t.games, completed.length * 4, 'games = 4 × completed matches; cancels & overrides add nothing');
    assert.equal(t.wins, completed.length * 2);
    assert.equal(t.losses, completed.length * 2);
    for (const p of Object.values(h.state.players)) {
      const played = completed.filter((m) => [...m.teamA, ...m.teamB].includes(p.id)).length;
      assert.equal(p.gamesPlayed, played, `${p.id} games match history`);
    }
    assert.equal(Object.values(h.state.matches).filter((m) => m.status === 'cancelled').length, 1);
    assert.ok(h.state.courts.every((ct) => ct.effectiveMode === 'fair' && !ct.champion));
    const seqs = h.state.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'event history is ordered');
  });

  it('accrues waiting time only while in the queue', () => {
    const h = new Harness({ players: 8 });
    const m = h.play('c1');
    const p = h.player(m.teamA[0]);
    assert.equal(p.queuedAt, null);
    assert.ok(p.totalWaitMs > 0);
    const bench = h.player(h.state.queue[0]);
    assert.equal(typeof bench.queuedAt, 'number');
  });

  it('ends a session only once all matches are finished', () => {
    const h = new Harness({ players: 8, mode: 'champion' });
    const m = h.play('c1');
    rejectsWith(() => h.run({ type: 'endSession', confirm: true }), 'ACTIVE_MATCHES');
    h.finish(m.id, 'A');
    rejectsWith(() => h.run({ type: 'endSession' }), 'CONFIRMATION_REQUIRED');
    h.run({ type: 'endSession', confirm: true });
    assert.equal(h.state.status, 'ended');
    assert.equal(h.court().champion, null);
    rejectsWith(() => h.run({ type: 'setMode', mode: 'fair' }), 'INVALID_SESSION_STATE');
  });
});
