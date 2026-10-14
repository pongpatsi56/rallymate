// Seeded, deterministic session simulator. Drives the real SessionStore (so
// idempotency, optimistic concurrency, atomic commits and invariants are
// exercised exactly as in production) and measures fairness from the outside.
// Feature-detects the engine, so the same runner can replay older engine
// snapshots for before/after comparisons.

import * as engine from '../src/engine/session.js';
import { DomainError } from '../src/engine/errors.js';
import { SessionStore } from '../src/store.js';

const MINUTE = 60_000;
const ENGINE_HAS_SKILL = 'SKILL' in engine;
export const ENGINE_HAS_MIX = engine.COMMAND_TYPES.includes('updateSettings');

export const PLAYER_COUNTS = [6, 8, 10, 12, 16, 20, 24, 30];
export const COURT_COUNTS = [1, 2, 3, 4, 5];
export const MODES = ['fair', 'champion'];
export const MIX = [false, true];

/**
 * Scenario knobs. Every run also injects low-rate chaos (cancellations,
 * substitutions, duplicate submissions, stale writes, rejected commands).
 */
export const SCENARIOS = {
  equal: { label: 'ฝีมือเท่ากัน', skills: 'equal' },
  unequal: { label: 'ฝีมือต่างกัน', skills: 'unequal' },
  lateJoiners: { label: 'มาระหว่างก๊วน', skills: 'unequal', joinFraction: 0.3 },
  returning: { label: 'พักแล้วกลับมา / ออกแล้วกลับมา', skills: 'unequal', breakRate: 0.05, rejoinRate: 0.01 },
  substitutions: { label: 'เปลี่ยนตัวบ่อย', skills: 'unequal', subBeforeRate: 0.15, subDuringRate: 0.05 },
  cancellations: { label: 'ยกเลิกแมตช์บ่อย', skills: 'unequal', cancelRate: 0.12 },
  staggered: { label: 'คอร์ทจบไม่พร้อมกัน', skills: 'unequal', duration: [5, 25] },
  championOverrides: { label: 'แชมป์ชนะซ้ำ + override', skills: 'unequal', championWinProb: 0.85, overrideRate: 0.04 },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SimFailure extends Error {}
const check = (cond, msg) => {
  if (!cond) throw new SimFailure(msg);
};
const eff = (p) => p.gamesPlayed + (p.fairnessBaseline ?? 0);

/**
 * @param {{ players: number, courts: number, mode: 'fair'|'champion', mix?: boolean, scenario: string, seed: number, rounds?: number, teamWeights?: object }} cfg
 */
export function runSimulation(cfg) {
  const sc = SCENARIOS[cfg.scenario];
  if (!sc) throw new Error(`Unknown scenario ${cfg.scenario}`);
  const mix = Boolean(cfg.mix) && ENGINE_HAS_MIX;
  // Same rng stream with mix ON/OFF so the two arms see identical host behaviour where possible.
  const rng = mulberry32(cfg.seed * 7919 + cfg.players * 31 + cfg.courts);
  const rand = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const rounds = cfg.rounds ?? 24;

  const nPlayers = cfg.players;
  const courts = cfg.courts;
  const joinCount = Math.round(nPlayers * (sc.joinFraction ?? 0));
  const initialCount = nPlayers - joinCount;

  // ---- roster -------------------------------------------------------------
  const skillOf = new Map();
  const names = Array.from({ length: nPlayers }, (_, i) => `P${String(i + 1).padStart(2, '0')}`);
  const skills = names.map((_, i) => (sc.skills === 'equal' ? 2 : [1, 2, 2, 3][i % 4]));
  for (let i = skills.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [skills[i], skills[j]] = [skills[j], skills[i]];
  }
  names.forEach((n, i) => skillOf.set(n, skills[i]));
  const rosterEntry = (n) => (ENGINE_HAS_SKILL ? { name: n, skill: skillOf.get(n) } : n);

  // ---- store --------------------------------------------------------------
  let now = 0;
  const store = new SessionStore({ clock: () => now * MINUTE });
  const { state: created } = store.create({
    name: 'sim',
    courtCount: courts,
    playerNames: names.slice(0, initialCount).map(rosterEntry),
    mode: cfg.mode,
    ...(ENGINE_HAS_SKILL ? { seed: cfg.seed } : {}),
    ...(cfg.teamWeights ? { teamWeights: cfg.teamWeights } : {}),
  });
  const sid = created.id;
  let keyCounter = 0;
  const S = () => store.get(sid);
  const stats = {
    commands: 0, replays: 0, rejectedChecked: 0, staleChecked: 0, cancels: 0, subsBefore: 0, subsDuring: 0,
    joins: 0, rejoins: 0, breaks: 0, overrides: 0, busyCourtMinutes: 0,
  };

  const dispatch = (command) => {
    const key = `k${++keyCounter}`;
    const out = store.dispatch(sid, command, { idempotencyKey: key });
    stats.commands++;
    if (rng() < 0.05) {
      const before = S();
      const replay = store.dispatch(sid, command, { idempotencyKey: key });
      check(replay.replayed === true, 'duplicate submission was not replayed');
      check(S() === before && S().version === out.version, 'duplicate submission changed state');
      stats.replays++;
    }
    return out.result;
  };

  /** A command that must be rejected must leave state byte-for-byte unchanged. */
  const expectRejected = (command, opts = {}) => {
    const before = S();
    const snapshot = JSON.stringify(before);
    try {
      store.dispatch(sid, command, { idempotencyKey: `bad${++keyCounter}`, ...opts });
    } catch (err) {
      check(err instanceof DomainError, `unexpected error type: ${err}`);
      check(S() === before && JSON.stringify(S()) === snapshot, `rejected ${command.type} mutated state`);
      stats.rejectedChecked++;
      return err;
    }
    throw new SimFailure(`expected ${command.type} to be rejected`);
  };

  if (mix) dispatch({ type: 'updateSettings', mixGroups: true });
  dispatch({ type: 'startSession' });

  // ---- fairness tracking ----------------------------------------------------
  const track = new Map();
  const ensure = (id) => {
    if (!track.has(id)) {
      track.set(id, { passes: 0, maxPasses: 0, fromMatch: false, joinedAt: now, everAway: false });
    }
    return track.get(id);
  };
  const waits = [];
  let hardViolations = 0; // picked player had MORE effective games than an unpicked waiting player
  let waitViolations = 0; // waiting-order rule broken (strict when mix OFF, tolerance when mix ON)
  let unjustifiedConsecutive = 0;
  let consecutivePicks = 0;
  let picks = 0;
  let championViolations = 0;

  const courtEnd = new Map();
  const usableCourts = Math.max(1, Math.min(courts, Math.floor(initialCount / 4)));
  const targetMatches = rounds * usableCourts;
  const timeLimit = targetMatches * 40 + 200;
  const joinTimes = Array.from({ length: joinCount }, () => rand(Math.floor(timeLimit * 0.05), Math.floor(timeLimit * 0.25))).sort((a, b) => a - b);
  let nextJoin = 0;
  const returnsAt = new Map();
  const durationRange = sc.duration ?? [10, 16];
  const cancelRate = sc.cancelRate ?? 0.03;
  const subBeforeRate = sc.subBeforeRate ?? 0.03;
  const subDuringRate = sc.subDuringRate ?? 0;
  let completedCount = 0;

  const schedule = (courtId) => {
    const pre = S();
    const preCourt = pre.courts.find((c) => c.id === courtId);
    const ranked = engine.rankQueue(pre);
    const info = new Map(pre.queue.map((id, idx) => {
      const p = pre.players[id];
      return [id, { idx, eff: eff(p), queuedAt: p.queuedAt, passes: p.waitPasses ?? ensure(id).passes }];
    }));
    const mixSettings = pre.config?.mix;
    let res;
    try {
      res = dispatch({ type: 'scheduleNextMatch', courtId });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'NOT_ENOUGH_PLAYERS') return false;
      throw err;
    }
    const post = S();
    const match = post.matches[res.matchId];
    const all = [...match.teamA, ...match.teamB];
    const fromQueue = all.filter((id) => info.has(id));
    check(fromQueue.length === (match.championTeam ? 2 : 4), 'wrong number of players taken from queue');
    if (preCourt.champion) {
      if ([...match.teamA].sort().join() !== [...preCourt.champion.team].sort().join()) championViolations++;
    }

    const unpicked = ranked.filter((id) => !fromQueue.includes(id));
    // Protect threshold as documented for Mix Groups (ceil(queue/4) + extraWaits).
    const protectAt = mix ? Math.ceil(pre.queue.length / 4) + (mixSettings?.extraWaitsBeforeProtect ?? 1) : Infinity;
    const tolerance = mixSettings?.waitTolerance ?? 1;
    for (const p of fromQueue) {
      const a = info.get(p);
      for (const q of unpicked) {
        const b = info.get(q);
        if (b.eff < a.eff) {
          hardViolations++;
        } else if (b.eff === a.eff) {
          if (!mix) {
            if (b.idx < a.idx && b.queuedAt !== a.queuedAt) waitViolations++;
          } else if (b.passes > a.passes + tolerance || (b.passes >= protectAt && a.passes < protectAt)) {
            waitViolations++;
          }
        }
      }
    }
    for (const id of fromQueue) {
      const t = ensure(id);
      picks++;
      waits.push(now - info.get(id).queuedAt / MINUTE);
      if (t.fromMatch && t.passes === 0) {
        consecutivePicks++;
        const e = info.get(id).eff;
        if (unpicked.some((q) => info.get(q).eff < e)) unjustifiedConsecutive++;
      }
      t.passes = 0;
      t.fromMatch = false;
    }
    for (const id of unpicked) {
      const t = ensure(id);
      t.passes++;
      t.maxPasses = Math.max(t.maxPasses, t.passes);
    }

    if (rng() < subBeforeRate && post.queue.length > 0) {
      const outId = match.teamB[rand(0, 1)];
      dispatch({ type: 'substitutePlayer', matchId: match.id, outPlayerId: outId, confirm: true });
      stats.subsBefore++;
    }
    dispatch({ type: 'startMatch', matchId: match.id });
    courtEnd.set(courtId, now + rand(durationRange[0], durationRange[1]));
    return true;
  };

  const complete = (courtId) => {
    const s = S();
    const court = s.courts.find((c) => c.id === courtId);
    const match = s.matches[court.currentMatchId];
    courtEnd.delete(courtId);
    if (rng() < cancelRate) {
      const before = court.champion;
      dispatch({ type: 'cancelMatch', matchId: match.id, confirm: true, reason: 'sim' });
      stats.cancels++;
      // A cancel without overrides/mode switch must keep the champion and streak intact.
      const after = S().courts.find((c) => c.id === courtId).champion;
      if (before && !court.pendingOverride && !court.pendingMode && JSON.stringify(before) !== JSON.stringify(after)) championViolations++;
      expectRejected({ type: 'completeMatch', matchId: match.id, winner: 'A' });
    } else {
      const sumSkill = (ids) => ids.reduce((n, id) => n + skillOf.get(s.players[id].name), 0);
      let pA = 1 / (1 + Math.exp(-(sumSkill(match.teamA) - sumSkill(match.teamB)) * 0.8));
      if (sc.championWinProb && match.championTeam) {
        pA = match.championTeam === 'A' ? sc.championWinProb : 1 - sc.championWinProb;
      }
      const winner = rng() < pA ? 'A' : 'B';
      const expected = expectedChampion(s, court, match, winner);
      dispatch({ type: 'completeMatch', matchId: match.id, winner });
      completedCount++;
      const actual = S().courts.find((c) => c.id === courtId).champion;
      if (JSON.stringify(expected) !== JSON.stringify(actual && { team: [...actual.team].sort(), streak: actual.streak })) championViolations++;
      if (rng() < 0.05) expectRejected({ type: 'completeMatch', matchId: match.id, winner: 'B' });
    }
    for (const id of [...match.teamA, ...match.teamB]) {
      const p = S().players[id];
      const t = ensure(id);
      if (p.status === 'waiting') {
        t.fromMatch = true;
        t.passes = 0;
      }
    }
  };

  Object.keys(S().players).forEach(ensure);

  // ---- main loop ------------------------------------------------------------
  while (completedCount < targetMatches && now < timeLimit) {
    while (nextJoin < joinTimes.length && joinTimes[nextJoin] <= now) {
      const name = names[initialCount + nextJoin];
      const { playerId } = dispatch({ type: 'addPlayer', name, ...(ENGINE_HAS_SKILL ? { skill: skillOf.get(name) } : {}) });
      ensure(playerId).joinedAt = now;
      nextJoin++;
      stats.joins++;
    }
    for (const [id, at] of [...returnsAt]) {
      if (at <= now) {
        dispatch({ type: 'returnToQueue', playerId: id });
        returnsAt.delete(id);
      }
    }
    if (sc.breakRate && rng() < sc.breakRate && S().queue.length > 0) {
      const q = S().queue;
      const id = q[rand(0, q.length - 1)];
      // Some leave "permanently" and come back later (rejoin policy), most just take a break.
      const leaving = rng() < (sc.rejoinRate ?? 0) / sc.breakRate;
      dispatch({ type: leaving ? 'removePlayer' : 'markUnavailable', playerId: id });
      ensure(id).everAway = true;
      returnsAt.set(id, now + (leaving ? rand(40, 90) : rand(15, 40)));
      if (leaving) stats.rejoins++;
      else stats.breaks++;
    }
    if (subDuringRate && rng() < subDuringRate) {
      const s = S();
      const inMatch = Object.values(s.players).filter((p) => p.status === 'in_match' && s.matches[p.matchId].status === 'in_progress');
      if (inMatch.length && s.queue.length) {
        const p = inMatch[rand(0, inMatch.length - 1)];
        dispatch({ type: 'substitutePlayer', matchId: p.matchId, outPlayerId: p.id, outStatus: 'waiting', confirm: true });
        stats.subsDuring++;
      }
    }
    if (sc.overrideRate && cfg.mode === 'champion' && rng() < sc.overrideRate) {
      const s = S();
      const withChamp = s.courts.filter((c) => c.champion && !c.pendingOverride);
      if (withChamp.length) {
        const c = withChamp[rand(0, withChamp.length - 1)];
        const action = !c.currentMatchId ? 'release_now' : (rng() < 0.5 ? 'release_after_match' : 'force_rotate_after_match');
        dispatch({ type: 'championOverride', courtId: c.id, action, confirm: true });
        stats.overrides++;
      }
    }
    for (const [courtId, end] of [...courtEnd].sort((a, b) => a[1] - b[1])) {
      if (end <= now) complete(courtId);
    }
    for (const court of S().courts) {
      if (!court.currentMatchId) schedule(court.id);
    }
    if (rng() < 0.02) {
      const s = S();
      const busy = s.courts.find((c) => c.currentMatchId);
      if (busy) expectRejected({ type: 'scheduleNextMatch', courtId: busy.id });
      const playing = Object.values(s.players).find((p) => p.status === 'in_match');
      if (playing) expectRejected({ type: 'markUnavailable', playerId: playing.id });
      // Stale write: a request based on an older version must not overwrite newer state.
      const err = expectRejected({ type: 'addPlayer', name: `stale${keyCounter}` }, { expectedVersion: s.version - 1 });
      check(err.code === 'VERSION_CONFLICT', 'stale write was not rejected with VERSION_CONFLICT');
      stats.staleChecked++;
    }
    stats.busyCourtMinutes += S().courts.filter((c) => c.currentMatchId).length;
    now++;
  }
  const sessionMinutes = now;
  for (const [courtId] of [...courtEnd].sort((a, b) => a[1] - b[1])) complete(courtId);

  const final = S();
  championViolations += verifyFinalState(final, cfg);
  return {
    cfg: { ...cfg, mix },
    metrics: computeMetrics(final, {
      track, waits, hardViolations, waitViolations, unjustifiedConsecutive, consecutivePicks, picks, skillOf,
      sessionMinutes, courts, busyCourtMinutes: stats.busyCourtMinutes, championViolations,
      // No bench = the starting roster exactly fills the usable courts, so at full
      // occupancy nobody ever has to wait (e.g. 8 players on 2+ courts). 6 players on
      // 2 courts still has a bench of 2: only one court can be filled.
      noBench: cfg.players % 4 === 0 && cfg.players / 4 <= courts,
    }),
    stats,
  };
}

/** Independent re-statement of the Champion Mode rules, for checking each completion. */
function expectedChampion(s, court, match, winner) {
  const max = s.config.maxChampionWins;
  const modeAfter = court.pendingMode ?? court.effectiveMode;
  const winners = [...(winner === 'A' ? match.teamA : match.teamB)].sort();
  if (match.mode !== 'champion' || modeAfter !== 'champion' || court.pendingOverride === 'force_rotate') return null;
  if (match.championTeam === winner) {
    const streak = match.championStreakAtStart + 1;
    if (court.pendingOverride === 'release' || streak >= max) return null;
    return { team: winners, streak };
  }
  return max <= 1 ? null : { team: winners, streak: 1 };
}

// ---------------------------------------------------------------------------
// Post-run verification
// ---------------------------------------------------------------------------

function verifyFinalState(s, cfg) {
  engine.assertInvariants(s);
  let championViolations = 0;
  const completed = s.matchOrder.map((id) => s.matches[id]).filter((m) => m.status === 'completed');
  const credit = new Map();
  for (const m of completed) {
    const ids = [...m.teamA, ...m.teamB];
    check(new Set(ids).size === 4, `${m.id} has duplicate players`);
    for (const id of ids) credit.set(id, (credit.get(id) ?? 0) + 1);
  }
  for (const p of Object.values(s.players)) {
    check(p.gamesPlayed === (credit.get(p.id) ?? 0), `${p.id} has ${p.gamesPlayed} games but ${credit.get(p.id) ?? 0} completed matches`);
    check(p.wins + p.losses === p.gamesPlayed, `${p.id} W/L does not add up`);
  }
  const max = s.config.maxChampionWins;
  for (const court of s.courts) {
    for (const m of completed.filter((x) => x.courtId === court.id && x.mode === 'champion')) {
      if (m.championTeam === m.winner && m.championStreakAtStart + 1 > max) championViolations++;
    }
  }
  if (cfg.mode === 'fair' && completed.some((m) => m.championTeam !== null)) championViolations++;
  return championViolations;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

/**
 * Elapsed match duration per player, from recorded match timestamps only:
 * endedAt - startedAt of each COMPLETED match the player finished, starting from
 * the player's substitution time if they came on mid-match. This is the time the
 * match was open on the scoreboard (host pressed start -> recorded result), NOT
 * verified active playing time. Matches without both timestamps are skipped and
 * counted in `missing`. Appearances that ended in substitution-out or cancellation
 * earn no game credit and are not included.
 */
export function elapsedMatchMinutesByPlayer(state, minuteMs = 60_000) {
  const minutes = new Map();
  let missing = 0;
  for (const id of state.matchOrder) {
    const m = state.matches[id];
    if (m.status !== 'completed') continue;
    if (typeof m.startedAt !== 'number' || typeof m.endedAt !== 'number') {
      missing++;
      continue;
    }
    for (const pid of [...m.teamA, ...m.teamB]) {
      const subIn = (m.substitutions ?? []).filter((x) => x.inPlayerId === pid && x.phase === 'in_progress').map((x) => x.at);
      const from = subIn.length ? Math.max(m.startedAt, ...subIn) : m.startedAt;
      minutes.set(pid, (minutes.get(pid) ?? 0) + Math.max(0, m.endedAt - from) / minuteMs);
    }
  }
  return { minutes, missing };
}
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function computeMetrics(s, t) {
  const players = Object.values(s.players);
  const core = players.filter((p) => {
    const tr = t.track.get(p.id);
    return tr && tr.joinedAt === 0 && !tr.everAway && p.status !== 'left';
  });
  const games = core.map((p) => p.gamesPlayed);
  const minG = games.length ? Math.min(...games) : 0;
  const maxG = games.length ? Math.max(...games) : 0;
  const active = players.filter((p) => p.status !== 'left');
  const effs = active.map(eff);
  const late = active.filter((p) => (t.track.get(p.id)?.joinedAt ?? 0) > 0);

  // Diversity: "recent" = within the previous 2 x courts completed matches (≈ two rounds).
  const completed = s.matchOrder.map((id) => s.matches[id]).filter((m) => m.status === 'completed');
  const recentWindow = Math.max(2, 2 * t.courts);
  const teammateSeen = new Map();
  const opponentLast = new Map();
  const teammateLast = new Map();
  const groupSeen = new Map();
  let pairs = 0;
  let teammateRepeats = 0;
  let teammateRecent = 0;
  let oppPairs = 0;
  let oppRecent = 0;
  let groupRepeats = 0;
  let groupRecent = 0;
  let exactRecent = 0;
  const compositionLast = new Map();
  const skillDiffs = [];
  completed.forEach((m, i) => {
    const skill = (id) => t.skillOf.get(s.players[id].name);
    skillDiffs.push(Math.abs(skill(m.teamA[0]) + skill(m.teamA[1]) - skill(m.teamB[0]) - skill(m.teamB[1])));
    for (const key of ['A', 'B']) {
      if (m.championTeam === key) continue; // a retained champion pair is the mode's rule
      const team = key === 'A' ? m.teamA : m.teamB;
      const pk = pairKey(team[0], team[1]);
      pairs++;
      if (teammateSeen.has(pk)) teammateRepeats++;
      if (teammateLast.has(pk) && i - teammateLast.get(pk) <= recentWindow) teammateRecent++;
      teammateSeen.set(pk, true);
      teammateLast.set(pk, i);
    }
    for (const a of m.teamA) {
      for (const b of m.teamB) {
        const ok = pairKey(a, b);
        oppPairs++;
        if (opponentLast.has(ok) && i - opponentLast.get(ok) <= recentWindow) oppRecent++;
        opponentLast.set(ok, i);
      }
    }
    const gk = [...m.teamA, ...m.teamB].sort().join('|');
    if (groupSeen.has(gk)) {
      groupRepeats++;
      if (i - groupSeen.get(gk) <= recentWindow) groupRecent++;
    }
    groupSeen.set(gk, i);
    const ck = [pairKey(...m.teamA), pairKey(...m.teamB)].sort().join('||');
    if (compositionLast.has(ck) && i - compositionLast.get(ck) <= recentWindow) exactRecent++;
    compositionLast.set(ck, i);
  });
  const sortedWaits = [...t.waits].sort((a, b) => a - b);
  const sortedDiffs = [...skillDiffs].sort((a, b) => a - b);
  const n = completed.length || 1;
  const { minutes: elapsed, missing: elapsedMissing } = elapsedMatchMinutesByPlayer(s);
  const coreElapsed = core.map((p) => elapsed.get(p.id) ?? 0);

  // Metrics are grouped deliberately:
  //  - ROTATION FAIRNESS: were queue decisions correct given who was waiting?
  //    (violations, consecutive passes, waiting time). Unequal match lengths never
  //    count here.
  //  - PARTICIPATION STATISTICS: what players ended up with (games, effective games,
  //    elapsed match duration). These also reflect match lengths, cancellations and
  //    absences, which the scheduler does not control.
  return {
    completedMatches: completed.length,
    cancelledMatches: Object.values(s.matches).filter((m) => m.status === 'cancelled').length,
    coreCount: core.length,
    minGames: minG,
    maxGames: maxG,
    spread: maxG - minG,
    avgGames: games.length ? games.reduce((a, b) => a + b, 0) / games.length : 0,
    effSpread: effs.length ? Math.max(...effs) - Math.min(...effs) : 0,
    lateCount: late.length,
    lateAvgGames: late.length ? late.reduce((a, p) => a + p.gamesPlayed, 0) / late.length : null,
    maxConsecutivePasses: Math.max(0, ...[...t.track.values()].map((x) => x.maxPasses)),
    waitP50: pct(sortedWaits, 0.5),
    waitP90: pct(sortedWaits, 0.9),
    waitMax: sortedWaits.at(-1) ?? 0,
    teammateRepeatRate: pairs ? teammateRepeats / pairs : 0,
    teammateRecentRate: pairs ? teammateRecent / pairs : 0,
    opponentRecentRate: oppPairs ? oppRecent / oppPairs : 0,
    groupRepeatRate: groupRepeats / n,
    groupRecentRate: groupRecent / n,
    exactRecentRate: exactRecent / n,
    skillDiffAvg: skillDiffs.length ? skillDiffs.reduce((a, b) => a + b, 0) / skillDiffs.length : 0,
    skillDiff0: skillDiffs.filter((d) => d === 0).length / n,
    skillDiffGe2: skillDiffs.filter((d) => d >= 2).length / n,
    skillDiffGe3: skillDiffs.filter((d) => d >= 3).length / n,
    skillDiffP90: pct(sortedDiffs, 0.9),
    utilization: t.sessionMinutes ? t.busyCourtMinutes / (t.courts * t.sessionMinutes) : 0,
    hardViolations: t.hardViolations,
    waitViolations: t.waitViolations,
    unjustifiedConsecutive: t.unjustifiedConsecutive,
    consecutivePickRate: t.picks ? t.consecutivePicks / t.picks : 0,
    championViolations: t.championViolations,
    noBench: t.noBench,
    elapsedMinMinutes: coreElapsed.length ? Math.min(...coreElapsed) : 0,
    elapsedMaxMinutes: coreElapsed.length ? Math.max(...coreElapsed) : 0,
    elapsedSpreadRatio: coreElapsed.length && Math.max(...coreElapsed) > 0 ? (Math.max(...coreElapsed) - Math.min(...coreElapsed)) / Math.max(...coreElapsed) : 0,
    elapsedMissing,
  };
}

/** Which metric keys belong to which family (used by reports and tests). */
export const METRIC_GROUPS = Object.freeze({
  rotationFairness: ['hardViolations', 'waitViolations', 'unjustifiedConsecutive', 'maxConsecutivePasses', 'waitP50', 'waitP90', 'waitMax', 'championViolations'],
  participation: ['minGames', 'maxGames', 'spread', 'avgGames', 'effSpread', 'lateAvgGames', 'elapsedMinMinutes', 'elapsedMaxMinutes', 'elapsedSpreadRatio'],
});

// ---------------------------------------------------------------------------
// Grid + aggregation
// ---------------------------------------------------------------------------

export function* grid({
  players = PLAYER_COUNTS, courts = COURT_COUNTS, modes = MODES, mixes = MIX,
  scenarios = Object.keys(SCENARIOS), seeds = [1, 2, 3], rounds, teamWeights,
} = {}) {
  for (const mode of modes) {
    for (const mix of mixes) {
      for (const scenario of scenarios) {
        for (const p of players) {
          for (const c of courts) {
            for (const seed of seeds) yield { players: p, courts: c, mode, mix, scenario, seed, rounds, teamWeights };
          }
        }
      }
    }
  }
}

const SUM_KEYS = ['hardViolations', 'waitViolations', 'unjustifiedConsecutive', 'championViolations', 'completedMatches'];
const MAX_KEYS = ['spread', 'effSpread', 'maxConsecutivePasses', 'waitMax', 'maxGames'];

/** Aggregates runs: mean for rates/averages, worst case for spreads/passes, sums for violations. */
export function aggregate(runs) {
  const n = runs.length;
  const out = { runs: n };
  if (!n) return out;
  for (const k of Object.keys(runs[0].metrics)) {
    const vals = runs.map((r) => r.metrics[k]).filter((v) => v !== null);
    if (!vals.length) {
      out[k] = null;
      continue;
    }
    if (SUM_KEYS.includes(k)) out[k] = vals.reduce((a, b) => a + b, 0);
    else out[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (MAX_KEYS.includes(k)) out[`${k}Max`] = Math.max(...vals);
  }
  out.minGames = Math.min(...runs.map((r) => r.metrics.minGames));
  return out;
}
