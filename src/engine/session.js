// Pure session engine. Every command runs against a structured clone of the
// state; the clone is only returned after invariants pass, so a failed command
// never leaves a partially-applied state behind (atomic transitions).

import { DomainError } from './errors.js';

export const MODE = Object.freeze({ FAIR: 'fair', CHAMPION: 'champion' });
export const SESSION_STATUS = Object.freeze({ SETUP: 'setup', ACTIVE: 'active', ENDED: 'ended' });
export const PLAYER_STATUS = Object.freeze({
  WAITING: 'waiting',
  IN_MATCH: 'in_match',
  CHAMPION_HOLD: 'champion_hold', // champion pair holding the court between matches
  UNAVAILABLE: 'unavailable',
  LEFT: 'left',
});
export const MATCH_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});
export const OVERRIDE = Object.freeze({
  RELEASE_AFTER_MATCH: 'release_after_match',
  RELEASE_NOW: 'release_now',
  FORCE_ROTATE_AFTER_MATCH: 'force_rotate_after_match',
  CANCEL_PENDING: 'cancel_pending',
});
// What a court remembers until its current match ends.
const PENDING_OVERRIDE = Object.freeze({ RELEASE: 'release', FORCE_ROTATE: 'force_rotate' });

export const SKILL = Object.freeze({ BEGINNER: 1, INTERMEDIATE: 2, ADVANCED: 3 });
const DEFAULT_SKILL = SKILL.INTERMEDIATE;
// How many equally-eligible players (same games, same wait start) are considered
// when choosing who fills the last slots. Keeps queue order meaningful and the
// search tiny: at most C(8,4) = 70 combinations x 3 pairings.
const CANDIDATE_WINDOW = 8;

export const DEFAULT_MAX_CHAMPION_WINS = 2;

/**
 * Stage-2 team formation weights (score = sum of weight x count; lower is better).
 * Tuned with sim/ — see docs/fairness-audit-phase2.md.
 */
export const DEFAULT_TEAM_WEIGHTS = Object.freeze({
  skillGap: 7, // per point of |sum(teamA) - sum(teamB)| (spec start was 5; see tuning in the Phase 2 report)
  recentTeammate: 4, // per pair that partnered within the recent window
  olderTeammate: 1, // per pair that partnered earlier in the history window
  recentOpponent: 1, // per cross pair that faced each other within the recent window
});
/** Guardrail: never pick a split with a gap above this unless no split is within it. */
export const SKILL_GAP_CAP = 2;
export const DEFAULT_MIX = Object.freeze({
  waitTolerance: 1, // a picked player may have at most this many fewer wait passes than a bypassed one
  extraWaitsBeforeProtect: 1, // protected once waitPasses >= ceil(queue / 4) + this
  historyWindow: 50, // completed matches considered for diversity
  weights: Object.freeze({ groupRecent: 6, groupOlder: 1, exactComposition: 8, waitDeficit: 3 }),
});
export const LIMITS = Object.freeze({ maxNameLength: 40, maxCourts: 12, maxPlayers: 200 });

const ACTIVE_MATCH = new Set([MATCH_STATUS.SCHEDULED, MATCH_STATUS.IN_PROGRESS]);

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function createSession({
  id,
  name,
  courtCount = 1,
  playerNames = [],
  mode = MODE.FAIR,
  maxChampionWins = DEFAULT_MAX_CHAMPION_WINS,
  seed,
  mixGroups = false,
  teamWeights,
  now = Date.now(),
}) {
  if (typeof id !== 'string' || !id) throw validation('id is required');
  const sessionName = cleanName(name ?? 'ก๊วนแบดมินตัน', 'session name');
  if (!Number.isInteger(courtCount) || courtCount < 1 || courtCount > LIMITS.maxCourts) {
    throw validation(`courtCount must be an integer between 1 and ${LIMITS.maxCourts}`);
  }
  assertMode(mode);
  if (!Number.isInteger(maxChampionWins) || maxChampionWins < 1 || maxChampionWins > 10) {
    throw validation('maxChampionWins must be an integer between 1 and 10');
  }
  if (!Array.isArray(playerNames)) throw validation('playerNames must be an array');
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) throw validation('seed must be a non-negative integer');
  if (typeof mixGroups !== 'boolean') throw validation('mixGroups must be a boolean');
  const weights = validateTeamWeights(teamWeights);

  const state = {
    id,
    name: sessionName,
    status: SESSION_STATUS.SETUP,
    version: 0,
    createdAt: now,
    updatedAt: now,
    mode,
    config: { maxChampionWins, mixGroups, teamWeights: weights, mix: structuredClone(DEFAULT_MIX) },
    courts: [],
    players: {},
    queue: [],
    matches: {},
    matchOrder: [],
    events: [],
    counters: { player: 0, match: 0, event: 0 },
    rng: (seed ?? hashSeed(id)) >>> 0, // seeded PRNG state, so tie-breaks are reproducible
  };
  for (let i = 1; i <= courtCount; i++) {
    state.courts.push({
      id: `c${i}`,
      name: `คอร์ท ${i}`,
      effectiveMode: mode,
      pendingMode: null,
      champion: null, // { team: [playerId, playerId], streak }
      pendingOverride: null,
      currentMatchId: null,
    });
  }
  const ctx = { now, actor: 'host' };
  for (const entry of playerNames) {
    const { name: playerName, skill } = typeof entry === 'string' ? { name: entry } : (entry ?? {});
    addPlayerInternal(state, playerName, ctx, skill);
  }
  emit(state, 'SESSION_CREATED', { name: sessionName, courtCount, mode, playerIds: [...state.queue] }, ctx);
  assertInvariants(state);
  return state;
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * Applies a command atomically.
 * @returns {{ state: object, result: object }} a new state object; input is never mutated.
 */
export function applyCommand(state, command, ctx = {}) {
  const handler = HANDLERS[command?.type];
  if (!handler) throw new DomainError('UNKNOWN_COMMAND', `Unknown command: ${command?.type}`);
  const fullCtx = { now: ctx.now ?? Date.now(), actor: ctx.actor ?? 'host' };
  const draft = structuredClone(state);
  const result = handler(draft, command, fullCtx) ?? {};
  assertInvariants(draft);
  draft.version += 1;
  draft.updatedAt = fullCtx.now;
  return { state: draft, result };
}

const HANDLERS = {
  startSession,
  endSession,
  setMode,
  updateSettings,
  scheduleNextMatch,
  startMatch,
  completeMatch,
  cancelMatch,
  substitutePlayer,
  championOverride,
  addPlayer,
  setPlayerSkill,
  markUnavailable,
  returnToQueue,
  removePlayer,
};

export const COMMAND_TYPES = Object.freeze(Object.keys(HANDLERS));

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function startSession(s, _cmd, ctx) {
  if (s.status !== SESSION_STATUS.SETUP) {
    throw new DomainError('INVALID_SESSION_STATE', `Cannot start a session that is ${s.status}`);
  }
  s.status = SESSION_STATUS.ACTIVE;
  emit(s, 'SESSION_STARTED', {}, ctx);
  return { status: s.status };
}

function endSession(s, cmd, ctx) {
  assertNotEnded(s);
  const active = activeMatches(s);
  if (active.length > 0) {
    throw new DomainError('ACTIVE_MATCHES', 'Finish or cancel all matches before ending the session', {
      matchIds: active.map((m) => m.id),
    });
  }
  requireConfirm(cmd, 'Ending the session');
  for (const court of s.courts) {
    if (court.champion) releaseChampion(s, court, 'session_ended', ctx);
  }
  // Freeze waiting time so stats stop accruing.
  for (const id of [...s.queue]) {
    const p = s.players[id];
    p.totalWaitMs += Math.max(0, ctx.now - p.queuedAt);
    p.queuedAt = ctx.now;
  }
  s.status = SESSION_STATUS.ENDED;
  emit(s, 'SESSION_ENDED', {}, ctx);
  return { status: s.status };
}

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

function setMode(s, cmd, ctx) {
  assertNotEnded(s);
  assertMode(cmd.mode);
  const from = s.mode;
  const applied = [];
  const pending = [];
  s.mode = cmd.mode;
  for (const court of s.courts) {
    if (court.currentMatchId) {
      // Never touch a running match: queue the change for when it finishes.
      // Switching back to the court's current mode just withdraws the pending change.
      court.pendingMode = cmd.mode === court.effectiveMode ? null : cmd.mode;
      if (court.pendingMode) pending.push(court.id);
    } else if (court.effectiveMode !== cmd.mode) {
      applyCourtMode(s, court, cmd.mode, ctx);
      applied.push(court.id);
    }
  }
  const changed = from !== cmd.mode || applied.length > 0 || pending.length > 0;
  if (changed) {
    emit(s, 'MODE_CHANGE_REQUESTED', { from, to: cmd.mode, appliedCourts: applied, pendingCourts: pending }, ctx);
  }
  return { mode: s.mode, appliedCourts: applied, pendingCourts: pending, changed };
}

function applyCourtMode(s, court, mode, ctx) {
  if (court.effectiveMode === mode) return;
  const from = court.effectiveMode;
  court.effectiveMode = mode;
  court.pendingMode = null;
  if (mode === MODE.FAIR) {
    court.pendingOverride = null;
    if (court.champion) releaseChampion(s, court, 'mode_fair', ctx);
  }
  emit(s, 'MODE_CHANGE_APPLIED', { courtId: court.id, from, to: mode }, ctx);
}

/** Host settings. Mix Groups affects only the next line-up chosen; running matches are untouched. */
function updateSettings(s, cmd, ctx) {
  assertNotEnded(s);
  if (typeof cmd.mixGroups !== 'boolean') throw validation('mixGroups must be a boolean');
  if (!s.config.mix) s.config.mix = structuredClone(DEFAULT_MIX); // sessions saved before Phase 2
  const from = s.config.mixGroups === true;
  s.config.mixGroups = cmd.mixGroups;
  const changed = from !== cmd.mixGroups;
  if (changed) emit(s, 'SETTINGS_CHANGED', { mixGroups: { from, to: cmd.mixGroups } }, ctx);
  return { mixGroups: cmd.mixGroups, changed };
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

function scheduleNextMatch(s, cmd, ctx) {
  assertActive(s);
  const court = getCourt(s, cmd.courtId);
  if (court.currentMatchId) throw new DomainError('COURT_BUSY', `${court.id} already has a match`);

  const champion = court.champion;
  const needed = champion ? 2 : 4;
  if (s.queue.length < needed) {
    throw new DomainError('NOT_ENOUGH_PLAYERS', `Need ${needed} waiting players, have ${s.queue.length}`, {
      needed,
      waiting: s.queue.length,
    });
  }
  const { picked, teamA, teamB } = chooseLineup(s, needed, champion ? [...champion.team] : null);

  const matchId = `m${++s.counters.match}`;
  const match = {
    id: matchId,
    no: s.counters.match,
    courtId: court.id,
    status: MATCH_STATUS.SCHEDULED,
    mode: court.effectiveMode,
    teamA,
    teamB,
    championTeam: champion ? 'A' : null,
    championStreakAtStart: champion ? champion.streak : 0,
    winner: null,
    outcome: null,
    substitutions: [],
    scheduledAt: ctx.now,
    startedAt: null,
    endedAt: null,
    cancelReason: null,
  };
  s.matches[matchId] = match;
  s.matchOrder.push(matchId);
  court.currentMatchId = matchId;

  for (const id of picked) removeFromQueue(s, id, ctx.now);
  // Everyone still waiting was eligible for this match and was passed over.
  for (const id of s.queue) s.players[id].waitPasses = (s.players[id].waitPasses ?? 0) + 1;
  for (const id of [...teamA, ...teamB]) {
    const p = s.players[id];
    p.status = PLAYER_STATUS.IN_MATCH;
    p.matchId = matchId;
    p.courtId = court.id;
  }
  emit(s, 'MATCH_SCHEDULED', { matchId, courtId: court.id, teamA, teamB, mode: match.mode, championTeam: match.championTeam }, ctx);
  return { matchId };
}

function startMatch(s, cmd, ctx) {
  assertActive(s);
  const match = getMatch(s, cmd.matchId);
  assertMatchStatus(match, [MATCH_STATUS.SCHEDULED]);
  match.status = MATCH_STATUS.IN_PROGRESS;
  match.startedAt = ctx.now;
  emit(s, 'MATCH_STARTED', { matchId: match.id, courtId: match.courtId }, ctx);
  return { matchId: match.id };
}

function completeMatch(s, cmd, ctx) {
  assertActive(s);
  const match = getMatch(s, cmd.matchId);
  assertMatchStatus(match, [MATCH_STATUS.IN_PROGRESS]);
  if (cmd.winner !== 'A' && cmd.winner !== 'B') throw validation("winner must be 'A' or 'B'");

  const court = getCourt(s, match.courtId);
  const winners = cmd.winner === 'A' ? match.teamA : match.teamB;
  const losers = cmd.winner === 'A' ? match.teamB : match.teamA;

  match.status = MATCH_STATUS.COMPLETED;
  match.winner = cmd.winner;
  match.endedAt = ctx.now;
  for (const id of winners) {
    s.players[id].gamesPlayed += 1;
    s.players[id].wins += 1;
  }
  for (const id of losers) {
    s.players[id].gamesPlayed += 1;
    s.players[id].losses += 1;
  }

  const override = court.pendingOverride;
  const modeAfter = court.pendingMode ?? court.effectiveMode;
  const max = s.config.maxChampionWins;

  // Retention only applies when the match was played under Champion rules AND the
  // court is still in Champion mode once any pending switch lands. This makes
  // Fair→Champion start tracking with the *next* match, and Champion→Fair clear
  // retention right after the current one.
  let stay = null;
  let outcome;
  if (match.mode !== MODE.CHAMPION) {
    outcome = 'rotate_fair';
  } else if (modeAfter !== MODE.CHAMPION) {
    outcome = 'rotate_mode_switched';
  } else if (override === PENDING_OVERRIDE.FORCE_ROTATE) {
    outcome = 'rotate_override_force';
  } else if (match.championTeam === cmd.winner) {
    const streak = match.championStreakAtStart + 1;
    if (override === PENDING_OVERRIDE.RELEASE) {
      outcome = 'rotate_override_release';
    } else if (streak >= max) {
      outcome = 'rotate_max_wins';
    } else {
      stay = { team: [...winners], streak };
      outcome = 'champion_retained';
    }
  } else if (max <= 1) {
    outcome = 'rotate_max_wins';
  } else {
    stay = { team: [...winners], streak: 1 };
    outcome = match.championTeam ? 'challenger_crowned' : 'champion_crowned';
  }
  match.outcome = outcome;

  const previousChampion = court.champion;
  court.champion = stay;
  court.currentMatchId = null;
  court.pendingOverride = null;

  const stayIds = new Set(stay ? stay.team : []);
  for (const id of [...match.teamA, ...match.teamB]) {
    const p = s.players[id];
    if (stayIds.has(id)) {
      p.status = PLAYER_STATUS.CHAMPION_HOLD;
      p.matchId = null;
    } else {
      enqueue(s, id, ctx.now);
    }
  }

  emit(s, 'MATCH_COMPLETED', { matchId: match.id, courtId: court.id, winner: cmd.winner, winners, losers, outcome }, ctx);
  if (override) {
    emit(s, 'CHAMPION_OVERRIDE_APPLIED', { courtId: court.id, matchId: match.id, override }, ctx);
  }
  if (stay && (outcome === 'champion_crowned' || outcome === 'challenger_crowned')) {
    emit(s, 'CHAMPION_CROWNED', { courtId: court.id, team: stay.team, streak: stay.streak, replaced: previousChampion?.team ?? null }, ctx);
  } else if (stay) {
    emit(s, 'CHAMPION_RETAINED', { courtId: court.id, team: stay.team, streak: stay.streak }, ctx);
  } else if (previousChampion) {
    emit(s, 'CHAMPION_ROTATED', { courtId: court.id, team: previousChampion.team, reason: outcome }, ctx);
  }

  if (court.pendingMode) applyCourtMode(s, court, court.pendingMode, ctx);
  return { matchId: match.id, outcome, champion: court.champion };
}

function cancelMatch(s, cmd, ctx) {
  assertActive(s);
  const match = getMatch(s, cmd.matchId);
  assertMatchStatus(match, [MATCH_STATUS.SCHEDULED, MATCH_STATUS.IN_PROGRESS]);
  if (match.status === MATCH_STATUS.IN_PROGRESS) requireConfirm(cmd, 'Cancelling a match in progress');

  const court = getCourt(s, match.courtId);
  match.status = MATCH_STATUS.CANCELLED;
  match.endedAt = ctx.now;
  match.cancelReason = typeof cmd.reason === 'string' ? cmd.reason.slice(0, 200) : null;

  // No winner: champions (if still intact) keep their streak and hold the court;
  // everyone else goes back to the front of the queue since they never got to play.
  const championIds = new Set(match.championTeam && court.champion ? court.champion.team : []);
  const returning = [];
  for (const id of [...match.teamA, ...match.teamB]) {
    const p = s.players[id];
    if (championIds.has(id)) {
      p.status = PLAYER_STATUS.CHAMPION_HOLD;
      p.matchId = null;
    } else {
      returning.push(id);
    }
  }
  enqueueFront(s, returning, ctx.now);
  court.currentMatchId = null;
  emit(s, 'MATCH_CANCELLED', { matchId: match.id, courtId: court.id, reason: match.cancelReason }, ctx);

  const override = court.pendingOverride;
  court.pendingOverride = null;
  if (override) {
    if (court.champion) releaseChampion(s, court, `override_${override}`, ctx);
    emit(s, 'CHAMPION_OVERRIDE_APPLIED', { courtId: court.id, matchId: match.id, override }, ctx);
  }
  if (court.pendingMode) applyCourtMode(s, court, court.pendingMode, ctx);
  return { matchId: match.id };
}

function substitutePlayer(s, cmd, ctx) {
  assertActive(s);
  const match = getMatch(s, cmd.matchId);
  assertMatchStatus(match, [MATCH_STATUS.SCHEDULED, MATCH_STATUS.IN_PROGRESS]);
  const outStatus = cmd.outStatus ?? PLAYER_STATUS.WAITING;
  if (![PLAYER_STATUS.WAITING, PLAYER_STATUS.UNAVAILABLE, PLAYER_STATUS.LEFT].includes(outStatus)) {
    throw validation("outStatus must be 'waiting', 'unavailable' or 'left'");
  }
  const outPlayer = getPlayer(s, cmd.outPlayerId);
  const slot = findSlot(match, outPlayer.id);
  if (!slot) throw new DomainError('PLAYER_NOT_IN_MATCH', `${outPlayer.id} is not in ${match.id}`);

  const inId = cmd.inPlayerId ?? rankQueue(s)[0];
  if (!inId) throw new DomainError('NOT_ENOUGH_PLAYERS', 'No waiting player available to substitute in');
  const inPlayer = getPlayer(s, inId);
  if (inPlayer.status !== PLAYER_STATUS.WAITING) {
    throw new DomainError('PLAYER_NOT_AVAILABLE', `${inPlayer.id} is not waiting in the queue`, { status: inPlayer.status });
  }

  const court = getCourt(s, match.courtId);
  const breaksChampion = match.championTeam === slot.team;
  if (match.status === MATCH_STATUS.IN_PROGRESS) requireConfirm(cmd, 'Replacing a player during a match');
  if (breaksChampion) requireConfirm(cmd, 'Substituting a champion player ends the champion streak');

  const teamKey = slot.team === 'A' ? 'teamA' : 'teamB';
  match[teamKey][slot.index] = inPlayer.id;
  match.substitutions.push({ outPlayerId: outPlayer.id, inPlayerId: inPlayer.id, phase: match.status, at: ctx.now, outStatus });

  removeFromQueue(s, inPlayer.id, ctx.now);
  inPlayer.status = PLAYER_STATUS.IN_MATCH;
  inPlayer.matchId = match.id;
  inPlayer.courtId = match.courtId;

  if (breaksChampion) {
    match.championTeam = null;
    match.championStreakAtStart = 0;
    const formerTeam = court.champion.team;
    court.champion = null;
    court.pendingOverride = null;
    emit(s, 'CHAMPION_RELEASED', { courtId: court.id, team: formerTeam, reason: 'substitution' }, ctx);
  }

  if (outStatus === PLAYER_STATUS.WAITING) {
    enqueueFront(s, [outPlayer.id], ctx.now);
  } else {
    parkPlayer(outPlayer, outStatus);
  }
  emit(s, 'PLAYER_SUBSTITUTED', {
    matchId: match.id,
    courtId: match.courtId,
    outPlayerId: outPlayer.id,
    inPlayerId: inPlayer.id,
    phase: match.status,
    outStatus,
  }, ctx);
  return { matchId: match.id, inPlayerId: inPlayer.id };
}

// ---------------------------------------------------------------------------
// Champion override
// ---------------------------------------------------------------------------

function championOverride(s, cmd, ctx) {
  assertActive(s);
  const court = getCourt(s, cmd.courtId);
  const match = court.currentMatchId ? s.matches[court.currentMatchId] : null;

  switch (cmd.action) {
    case OVERRIDE.RELEASE_NOW: {
      if (match) throw new DomainError('COURT_BUSY', 'Court has a match; use release_after_match instead');
      if (!court.champion) throw new DomainError('NO_CHAMPION', `${court.id} has no champion`);
      requireConfirm(cmd, 'Releasing the champion');
      emit(s, 'CHAMPION_OVERRIDE_REQUESTED', { courtId: court.id, action: cmd.action }, ctx);
      releaseChampion(s, court, 'override_release_now', ctx);
      emit(s, 'CHAMPION_OVERRIDE_APPLIED', { courtId: court.id, matchId: null, override: cmd.action }, ctx);
      return { applied: true };
    }
    case OVERRIDE.RELEASE_AFTER_MATCH: {
      if (!match) throw new DomainError('COURT_IDLE', 'Court has no match; use release_now instead');
      if (!match.championTeam) throw new DomainError('NO_CHAMPION', 'Current match has no champion pair');
      requireConfirm(cmd, 'Releasing the champion');
      court.pendingOverride = PENDING_OVERRIDE.RELEASE;
      emit(s, 'CHAMPION_OVERRIDE_REQUESTED', { courtId: court.id, matchId: match.id, action: cmd.action }, ctx);
      return { applied: false, pendingOverride: court.pendingOverride };
    }
    case OVERRIDE.FORCE_ROTATE_AFTER_MATCH: {
      if (!match) throw new DomainError('COURT_IDLE', 'Court has no match; use release_now instead');
      if (match.mode !== MODE.CHAMPION) throw new DomainError('NOT_CHAMPION_MODE', 'Current match is played under Fair rules');
      requireConfirm(cmd, 'Forcing both teams to rotate');
      court.pendingOverride = PENDING_OVERRIDE.FORCE_ROTATE;
      emit(s, 'CHAMPION_OVERRIDE_REQUESTED', { courtId: court.id, matchId: match.id, action: cmd.action }, ctx);
      return { applied: false, pendingOverride: court.pendingOverride };
    }
    case OVERRIDE.CANCEL_PENDING: {
      if (!court.pendingOverride) throw new DomainError('NO_PENDING_OVERRIDE', `${court.id} has no pending override`);
      const previous = court.pendingOverride;
      court.pendingOverride = null;
      emit(s, 'CHAMPION_OVERRIDE_WITHDRAWN', { courtId: court.id, previous }, ctx);
      return { applied: false, pendingOverride: null };
    }
    default:
      throw validation(`action must be one of ${Object.values(OVERRIDE).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

function addPlayer(s, cmd, ctx) {
  assertNotEnded(s);
  const id = addPlayerInternal(s, cmd.name, ctx, cmd.skill);
  const p = s.players[id];
  emit(s, 'PLAYER_ADDED', { playerId: id, name: p.name, skill: p.skill, midSession: s.status === SESSION_STATUS.ACTIVE }, ctx);
  return { playerId: id };
}

/** Skill only affects future pairings; it never changes queue priority. */
function setPlayerSkill(s, cmd, ctx) {
  assertNotEnded(s);
  const p = getPlayer(s, cmd.playerId);
  assertSkill(cmd.skill);
  const from = skillOf(p);
  p.skill = cmd.skill;
  if (from !== cmd.skill) emit(s, 'PLAYER_SKILL_CHANGED', { playerId: p.id, from, to: cmd.skill }, ctx);
  return { playerId: p.id, skill: p.skill };
}

function addPlayerInternal(s, rawName, ctx, rawSkill) {
  const name = cleanName(rawName, 'player name');
  const skill = rawSkill ?? DEFAULT_SKILL;
  assertSkill(skill);
  const lower = name.toLocaleLowerCase('th');
  const activePlayers = Object.values(s.players).filter((p) => p.status !== PLAYER_STATUS.LEFT);
  if (activePlayers.some((p) => p.name.toLocaleLowerCase('th') === lower)) {
    throw new DomainError('DUPLICATE_NAME', `A player named "${name}" is already in the session`);
  }
  if (Object.keys(s.players).length >= LIMITS.maxPlayers) throw validation(`At most ${LIMITS.maxPlayers} players`);
  const id = `p${++s.counters.player}`;
  s.players[id] = {
    id,
    name,
    skill,
    status: PLAYER_STATUS.WAITING,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    // Priority-only offset so a late joiner starts level with the current minimum
    // instead of jumping the queue with 0 games. Never touches real stats.
    fairnessBaseline: minActiveEffectiveGames(s),
    waitPasses: 0,
    totalWaitMs: 0,
    queuedAt: ctx.now,
    joinedAt: ctx.now,
    matchId: null,
    courtId: null,
  };
  s.queue.push(id);
  return id;
}

function markUnavailable(s, cmd, ctx) {
  assertNotEnded(s);
  const p = getPlayer(s, cmd.playerId);
  detachIdlePlayer(s, p, cmd, ctx, 'Marking a champion player unavailable');
  parkPlayer(p, PLAYER_STATUS.UNAVAILABLE);
  emit(s, 'PLAYER_UNAVAILABLE', { playerId: p.id }, ctx);
  return { playerId: p.id, status: p.status };
}

function removePlayer(s, cmd, ctx) {
  assertNotEnded(s);
  const p = getPlayer(s, cmd.playerId);
  if (p.status === PLAYER_STATUS.UNAVAILABLE) {
    parkPlayer(p, PLAYER_STATUS.LEFT);
  } else {
    detachIdlePlayer(s, p, cmd, ctx, 'Removing a champion player');
    parkPlayer(p, PLAYER_STATUS.LEFT);
  }
  emit(s, 'PLAYER_REMOVED', { playerId: p.id }, ctx);
  return { playerId: p.id, status: p.status };
}

function returnToQueue(s, cmd, ctx) {
  assertNotEnded(s);
  const p = getPlayer(s, cmd.playerId);
  if (p.status !== PLAYER_STATUS.UNAVAILABLE && p.status !== PLAYER_STATUS.LEFT) {
    throw new DomainError('INVALID_PLAYER_STATE', `${p.id} is ${p.status}; only unavailable or departed players can return`);
  }
  const lower = p.name.toLocaleLowerCase('th');
  if (p.status === PLAYER_STATUS.LEFT
    && Object.values(s.players).some((o) => o.id !== p.id && o.status !== PLAYER_STATUS.LEFT && o.name.toLocaleLowerCase('th') === lower)) {
    throw new DomainError('DUPLICATE_NAME', `Another active player is named "${p.name}"`);
  }
  const from = p.status;
  if (from === PLAYER_STATUS.LEFT) {
    // Rejoin after leaving keeps the same identity and real stats, but is levelled
    // up like a late joiner (never down). A temporary break keeps its baseline.
    const floor = minActiveEffectiveGames(s);
    p.fairnessBaseline = Math.max(p.fairnessBaseline ?? 0, floor - p.gamesPlayed);
  }
  enqueue(s, p.id, ctx.now);
  emit(s, 'PLAYER_RETURNED', { playerId: p.id, from, fairnessBaseline: p.fairnessBaseline ?? 0 }, ctx);
  return { playerId: p.id, status: p.status };
}

/** Takes a player who is not in a match out of the queue / champion slot. */
function detachIdlePlayer(s, p, cmd, ctx, confirmLabel) {
  switch (p.status) {
    case PLAYER_STATUS.WAITING:
      removeFromQueue(s, p.id, ctx.now);
      return;
    case PLAYER_STATUS.CHAMPION_HOLD: {
      requireConfirm(cmd, confirmLabel);
      const court = getCourt(s, p.courtId);
      const partners = court.champion.team.filter((id) => id !== p.id);
      const formerTeam = court.champion.team;
      court.champion = null;
      court.pendingOverride = null;
      for (const id of partners) enqueue(s, id, ctx.now);
      emit(s, 'CHAMPION_RELEASED', { courtId: court.id, team: formerTeam, reason: 'player_unavailable' }, ctx);
      return;
    }
    case PLAYER_STATUS.IN_MATCH:
      throw new DomainError('PLAYER_IN_MATCH', `${p.id} is in ${p.matchId}; substitute them first`, { matchId: p.matchId });
    default:
      throw new DomainError('INVALID_PLAYER_STATE', `${p.id} is already ${p.status}`);
  }
}

// ---------------------------------------------------------------------------
// Lineup selection
// ---------------------------------------------------------------------------

/**
 * Two separate stages:
 *
 * Stage 1 — who plays (fairness first). Everyone with fewer effective games than
 * the last open slot always plays. The remaining slots are filled from the
 * boundary tier:
 *   - Mix Groups OFF: only players tied on effective games AND wait start
 *     (Phase 1 behaviour).
 *   - Mix Groups ON: any player in the boundary effective-games tier, provided no
 *     bypassed tier player has more than `waitTolerance` extra wait passes than a
 *     picked one, and no protected player (waitPasses >= ceil(queue/4) +
 *     extraWaitsBeforeProtect) is bypassed for an unprotected one.
 *   Among allowed groups we prefer the one whose best match (stage 2) scores
 *   lowest, plus group-repeat and wait-deficit penalties when Mix Groups is ON.
 *
 * Stage 2 — how they pair up. All 2v2 splits are scored with DEFAULT_TEAM_WEIGHTS;
 * splits with a gap above max(min gap, SKILL_GAP_CAP) are never chosen. Exact ties
 * are broken with the session's seeded PRNG.
 */
function chooseLineup(s, needed, fixedTeam) {
  const cfg = settings(s);
  const history = matchHistory(s, cfg);
  const mw = cfg.mix.weights;
  const evaluated = candidateGroups(s, needed, cfg).map((g) => {
    const splits = scoreSplits(s, g.chosen, fixedTeam, cfg, history).filter((x) => x.allowed);
    const best = Math.min(...splits.map((x) => x.score));
    const bestSplits = splits.filter((x) => x.score === best);
    let cost = best;
    if (cfg.mixGroups) {
      const key = groupKey(fixedTeam ? [...fixedTeam, ...g.chosen] : g.chosen);
      cost += mw.groupRecent * countOf(history.group, key, 'recent')
        + mw.groupOlder * countOf(history.group, key, 'older')
        + mw.waitDeficit * g.waitDeficit;
    }
    return { ...g, cost, bestSplits, gap: Math.max(...bestSplits.map((x) => x.gap)) };
  });
  // Group-level guardrail: same cap as for splits.
  const cap = Math.max(Math.min(...evaluated.map((e) => e.gap)), SKILL_GAP_CAP);
  const allowed = evaluated.filter((e) => e.gap <= cap);
  let finalists = [];
  let bestCost = null;
  for (const e of allowed) {
    const c = [e.cost, e.order];
    const cmp = bestCost === null ? -1 : (c[0] - bestCost[0]) || (c[1] - bestCost[1]);
    if (cmp < 0) {
      bestCost = c;
      finalists = e.bestSplits.map((x) => ({ picked: e.chosen, teamA: x.teamA, teamB: x.teamB }));
    } else if (cmp === 0) {
      finalists.push(...e.bestSplits.map((x) => ({ picked: e.chosen, teamA: x.teamA, teamB: x.teamB })));
    }
  }
  return finalists[Math.floor(nextRandom(s) * finalists.length)];
}

/** Stage 1: the groups of waiting players fairness allows to take the open slots. */
function candidateGroups(s, needed, cfg) {
  const ranked = rankQueue(s);
  const effOf = (id) => effectiveGames(s.players[id]);
  const passes = (id) => s.players[id].waitPasses ?? 0;
  const groups = [];

  if (!cfg.mixGroups) {
    const tier = (id) => `${effOf(id)}@${s.players[id].queuedAt}`;
    const boundary = tier(ranked[needed - 1]);
    let start = needed - 1;
    while (start > 0 && tier(ranked[start - 1]) === boundary) start--;
    let end = needed;
    while (end < ranked.length && tier(ranked[end]) === boundary) end++;
    const must = ranked.slice(0, start);
    const k = needed - must.length;
    const pool = ranked.slice(start, Math.min(end, start + Math.max(CANDIDATE_WINDOW, k)));
    for (const combo of combinations(pool.map((id, i) => [id, i]), k)) {
      groups.push({ chosen: [...must, ...combo.map(([id]) => id)], order: combo.reduce((n, [, i]) => n + i, 0), waitDeficit: 0 });
    }
    return groups;
  }

  const boundary = effOf(ranked[needed - 1]);
  const must = ranked.filter((id) => effOf(id) < boundary);
  const queueIdx = new Map(s.queue.map((id, i) => [id, i]));
  const tier = ranked
    .filter((id) => effOf(id) === boundary)
    .sort((a, b) => passes(b) - passes(a) || queueIdx.get(a) - queueIdx.get(b));
  const k = needed - must.length;
  const pool = tier.slice(0, Math.max(CANDIDATE_WINDOW, k));
  const protectAt = Math.ceil(s.queue.length / 4) + cfg.mix.extraWaitsBeforeProtect;
  const strictPasses = tier.slice(0, k).reduce((n, id) => n + passes(id), 0);
  for (const combo of combinations(pool.map((id, i) => [id, i]), k)) {
    const ids = combo.map(([id]) => id);
    const picked = new Set(ids);
    const minPicked = Math.min(...ids.map(passes));
    const anyUnprotected = ids.some((id) => passes(id) < protectAt);
    const ok = tier.every((b) => picked.has(b)
      || (passes(b) <= minPicked + cfg.mix.waitTolerance && !(anyUnprotected && passes(b) >= protectAt)));
    if (!ok) continue;
    groups.push({
      chosen: [...must, ...ids],
      order: combo.reduce((n, [, i]) => n + i, 0),
      waitDeficit: strictPasses - ids.reduce((n, id) => n + passes(id), 0),
    });
  }
  return groups;
}

/** Stage 2: every 2v2 split of the chosen players, scored. */
function scoreSplits(s, chosen, fixedTeam, cfg, history) {
  const w = cfg.teamWeights;
  const skillSum = (team) => team.reduce((n, id) => n + skillOf(s.players[id]), 0);
  const splits = pairings(chosen, fixedTeam).map(([teamA, teamB]) => {
    const gap = Math.abs(skillSum(teamA) - skillSum(teamB));
    const tA = pairKey(teamA[0], teamA[1]);
    const tB = pairKey(teamB[0], teamB[1]);
    const recentTeammate = countOf(history.teammate, tA, 'recent') + countOf(history.teammate, tB, 'recent');
    const olderTeammate = countOf(history.teammate, tA, 'older') + countOf(history.teammate, tB, 'older');
    let recentOpponent = 0;
    for (const a of teamA) for (const b of teamB) recentOpponent += countOf(history.opponent, pairKey(a, b), 'recent');
    const exactRecent = countOf(history.composition, compositionKey(teamA, teamB), 'recent');
    const score = w.skillGap * gap + w.recentTeammate * recentTeammate + w.olderTeammate * olderTeammate
      + w.recentOpponent * recentOpponent + (cfg.mixGroups ? cfg.mix.weights.exactComposition * exactRecent : 0);
    return { teamA, teamB, gap, recentTeammate, olderTeammate, recentOpponent, exactRecent, score };
  });
  const cap = Math.max(Math.min(...splits.map((x) => x.gap)), SKILL_GAP_CAP);
  for (const x of splits) x.allowed = x.gap <= cap;
  return splits;
}

/** Read-only view of stage 2 for a given set of players (exposed for tests and tooling). */
export function evaluateTeamSplits(state, playerIds, fixedTeam = null) {
  const cfg = settings(state);
  return scoreSplits(state, playerIds, fixedTeam, cfg, matchHistory(state, cfg));
}

/**
 * Recency-bucketed counts over the last `historyWindow` completed matches.
 * "recent" = within the last max(2, 2 x courts) completed matches (about two rounds).
 */
function matchHistory(s, cfg) {
  const recentWindow = Math.max(2, 2 * s.courts.length);
  const h = { teammate: new Map(), opponent: new Map(), group: new Map(), composition: new Map() };
  const bump = (map, key, slot) => {
    const v = map.get(key) ?? { recent: 0, older: 0 };
    v[slot] += 1;
    map.set(key, v);
  };
  let age = 0;
  for (let i = s.matchOrder.length - 1; i >= 0 && age < cfg.mix.historyWindow; i--) {
    const m = s.matches[s.matchOrder[i]];
    if (m.status !== MATCH_STATUS.COMPLETED) continue;
    const slot = age < recentWindow ? 'recent' : 'older';
    bump(h.teammate, pairKey(m.teamA[0], m.teamA[1]), slot);
    bump(h.teammate, pairKey(m.teamB[0], m.teamB[1]), slot);
    for (const a of m.teamA) for (const b of m.teamB) bump(h.opponent, pairKey(a, b), slot);
    bump(h.group, groupKey([...m.teamA, ...m.teamB]), slot);
    bump(h.composition, compositionKey(m.teamA, m.teamB), slot);
    age++;
  }
  return h;
}

const countOf = (map, key, slot) => map.get(key)?.[slot] ?? 0;
const groupKey = (ids) => [...ids].sort().join('|');
const compositionKey = (a, b) => [pairKey(a[0], a[1]), pairKey(b[0], b[1])].sort().join('||');

/** Effective settings, filling defaults for sessions saved before Phase 2. */
function settings(s) {
  const mix = s.config.mix ?? DEFAULT_MIX;
  return {
    mixGroups: s.config.mixGroups === true,
    teamWeights: { ...DEFAULT_TEAM_WEIGHTS, ...(s.config.teamWeights ?? {}) },
    mix: { ...DEFAULT_MIX, ...mix, weights: { ...DEFAULT_MIX.weights, ...(mix.weights ?? {}) } },
  };
}

function validateTeamWeights(raw) {
  if (raw === undefined) return { ...DEFAULT_TEAM_WEIGHTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validation('teamWeights must be an object');
  for (const [k, v] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_TEAM_WEIGHTS, k)) throw validation(`Unknown team weight "${k}"`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw validation(`team weight ${k} must be a number between 0 and 100`);
  }
  return { ...DEFAULT_TEAM_WEIGHTS, ...raw };
}

function pairings(chosen, fixedTeam) {
  if (fixedTeam) return [[fixedTeam, chosen]];
  const [a, b, c, d] = chosen;
  return [[[a, b], [c, d]], [[a, c], [b, d]], [[a, d], [b, c]]];
}

function* combinations(items, k, from = 0, acc = []) {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = from; i <= items.length - (k - acc.length); i++) {
    acc.push(items[i]);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const skillOf = (p) => p.skill ?? DEFAULT_SKILL; // sessions saved before skills existed

/** mulberry32 step; the PRNG state lives in the session so commands stay pure. */
function nextRandom(s) {
  if (typeof s.rng !== 'number') s.rng = hashSeed(s.id);
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

/** Waiting players by fairness priority: fewest effective games first, then queue order. */
export function rankQueue(s) {
  return s.queue
    .map((id, idx) => ({ id, idx, games: effectiveGames(s.players[id]) }))
    .sort((a, b) => a.games - b.games || a.idx - b.idx)
    .map((e) => e.id);
}

/** Participation used for every fairness comparison: real games + join baseline. */
export function effectiveGames(p) {
  return p.gamesPlayed + (p.fairnessBaseline ?? 0);
}

const ACTIVE_FOR_BASELINE = new Set([PLAYER_STATUS.WAITING, PLAYER_STATUS.IN_MATCH, PLAYER_STATUS.CHAMPION_HOLD]);

/** Minimum effective games among active players (waiting, playing, holding a court); 0 if none. */
function minActiveEffectiveGames(s) {
  let min = null;
  for (const p of Object.values(s.players)) {
    if (!ACTIVE_FOR_BASELINE.has(p.status)) continue;
    const e = effectiveGames(p);
    if (min === null || e < min) min = e;
  }
  return min ?? 0;
}

function removeFromQueue(s, id, now) {
  const idx = s.queue.indexOf(id);
  if (idx === -1) throw new DomainError('INVARIANT_VIOLATION', `${id} is not in the queue`);
  s.queue.splice(idx, 1);
  const p = s.players[id];
  p.totalWaitMs += Math.max(0, now - p.queuedAt);
  p.queuedAt = null;
}

function enqueue(s, id, now) {
  s.queue.push(id);
  markWaiting(s.players[id], now);
}

/** Front-of-queue return (cancelled match / substituted out): keeps top waiting priority. */
function enqueueFront(s, ids, now) {
  const topPasses = Math.max(0, ...s.queue.map((id) => s.players[id].waitPasses ?? 0));
  s.queue.unshift(...ids);
  for (const id of ids) {
    markWaiting(s.players[id], now);
    s.players[id].waitPasses = topPasses;
  }
}

function markWaiting(p, now) {
  p.status = PLAYER_STATUS.WAITING;
  p.queuedAt = now;
  p.waitPasses = 0;
  p.matchId = null;
  p.courtId = null;
}

function parkPlayer(p, status) {
  p.status = status;
  p.queuedAt = null;
  p.matchId = null;
  p.courtId = null;
}

function releaseChampion(s, court, reason, ctx) {
  const team = court.champion.team;
  court.champion = null;
  court.pendingOverride = null;
  for (const id of team) {
    if (s.players[id].status === PLAYER_STATUS.CHAMPION_HOLD) enqueue(s, id, ctx.now);
  }
  emit(s, 'CHAMPION_RELEASED', { courtId: court.id, team, reason }, ctx);
}

// ---------------------------------------------------------------------------
// Lookups & guards
// ---------------------------------------------------------------------------

function getCourt(s, id) {
  const court = s.courts.find((c) => c.id === id);
  if (!court) throw new DomainError('COURT_NOT_FOUND', `Court ${id} not found`);
  return court;
}

function getMatch(s, id) {
  const match = Object.hasOwn(s.matches, id ?? '') ? s.matches[id] : null;
  if (!match) throw new DomainError('MATCH_NOT_FOUND', `Match ${id} not found`);
  return match;
}

function getPlayer(s, id) {
  const p = Object.hasOwn(s.players, id ?? '') ? s.players[id] : null;
  if (!p) throw new DomainError('PLAYER_NOT_FOUND', `Player ${id} not found`);
  return p;
}

function findSlot(match, playerId) {
  let index = match.teamA.indexOf(playerId);
  if (index !== -1) return { team: 'A', index };
  index = match.teamB.indexOf(playerId);
  if (index !== -1) return { team: 'B', index };
  return null;
}

function activeMatches(s) {
  return s.courts.filter((c) => c.currentMatchId).map((c) => s.matches[c.currentMatchId]);
}

function assertMatchStatus(match, allowed) {
  if (allowed.includes(match.status)) return;
  if (match.status === MATCH_STATUS.COMPLETED || match.status === MATCH_STATUS.CANCELLED) {
    throw new DomainError('MATCH_ALREADY_FINISHED', `${match.id} is already ${match.status}`, { status: match.status });
  }
  throw new DomainError('INVALID_MATCH_STATE', `${match.id} is ${match.status}; expected ${allowed.join(' or ')}`, { status: match.status });
}

function assertActive(s) {
  if (s.status !== SESSION_STATUS.ACTIVE) {
    throw new DomainError('INVALID_SESSION_STATE', `Session is ${s.status}; it must be active`);
  }
}

function assertNotEnded(s) {
  if (s.status === SESSION_STATUS.ENDED) throw new DomainError('INVALID_SESSION_STATE', 'Session has ended');
}

function assertMode(mode) {
  if (mode !== MODE.FAIR && mode !== MODE.CHAMPION) throw validation("mode must be 'fair' or 'champion'");
}

function assertSkill(skill) {
  if (!Object.values(SKILL).includes(skill)) {
    throw validation('skill must be 1 (beginner), 2 (intermediate) or 3 (advanced)');
  }
}

function requireConfirm(cmd, what) {
  if (cmd.confirm !== true) throw new DomainError('CONFIRMATION_REQUIRED', `${what} requires confirm: true`);
}

function cleanName(raw, label) {
  if (typeof raw !== 'string') throw validation(`${label} must be a string`);
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw validation(`${label} is required`);
  if ([...name].length > LIMITS.maxNameLength) throw validation(`${label} must be at most ${LIMITS.maxNameLength} characters`);
  return name;
}

function validation(message) {
  return new DomainError('VALIDATION_ERROR', message);
}

function emit(s, type, data, ctx) {
  s.events.push({ seq: ++s.counters.event, type, at: ctx.now, actor: ctx.actor, data });
}

// ---------------------------------------------------------------------------
// Invariants — checked after every command, before it is committed.
// ---------------------------------------------------------------------------

export function assertInvariants(s) {
  const fail = (msg) => {
    throw new DomainError('INVARIANT_VIOLATION', msg);
  };

  const queued = new Set();
  for (const id of s.queue) {
    if (queued.has(id)) fail(`${id} appears twice in the queue`);
    queued.add(id);
  }

  // Each active match: one per court, four distinct players, none shared across courts.
  const inMatch = new Map();
  for (const court of s.courts) {
    if (!court.currentMatchId) continue;
    const m = s.matches[court.currentMatchId];
    if (!m || !ACTIVE_MATCH.has(m.status) || m.courtId !== court.id) fail(`${court.id} points at an invalid match`);
    const ids = [...m.teamA, ...m.teamB];
    if (ids.length !== 4 || new Set(ids).size !== 4) fail(`${m.id} must have four distinct players`);
    for (const id of ids) {
      if (inMatch.has(id)) fail(`${id} is assigned to ${inMatch.get(id)} and ${m.id}`);
      inMatch.set(id, m.id);
    }
  }
  for (const m of Object.values(s.matches)) {
    if (ACTIVE_MATCH.has(m.status) && s.courts.find((c) => c.id === m.courtId)?.currentMatchId !== m.id) {
      fail(`${m.id} is active but not on its court`);
    }
  }

  const holding = new Map();
  for (const court of s.courts) {
    if (!court.champion) {
      if (court.pendingOverride === PENDING_OVERRIDE.RELEASE) fail(`${court.id} has a release override without a champion`);
      continue;
    }
    if (court.effectiveMode !== MODE.CHAMPION) fail(`${court.id} has a champion outside Champion mode`);
    const { team, streak } = court.champion;
    if (team.length !== 2 || team[0] === team[1]) fail(`${court.id} champion must be a pair`);
    if (!Number.isInteger(streak) || streak < 1 || streak >= s.config.maxChampionWins) fail(`${court.id} champion streak ${streak} out of range`);
    for (const id of team) {
      if (court.currentMatchId) {
        if (inMatch.get(id) !== court.currentMatchId) fail(`champion ${id} is not in ${court.id}'s match`);
      } else {
        if (holding.has(id)) fail(`${id} holds two courts`);
        holding.set(id, court.id);
      }
    }
  }

  for (const p of Object.values(s.players)) {
    if (p.wins + p.losses !== p.gamesPlayed) fail(`${p.id} stats are inconsistent`);
    if (p.skill !== undefined && !Object.values(SKILL).includes(p.skill)) fail(`${p.id} has invalid skill ${p.skill}`);
    if (p.fairnessBaseline !== undefined && !(Number.isInteger(p.fairnessBaseline) && p.fairnessBaseline >= 0)) fail(`${p.id} has invalid fairnessBaseline`);
    if (p.waitPasses !== undefined && !(Number.isInteger(p.waitPasses) && p.waitPasses >= 0)) fail(`${p.id} has invalid waitPasses`);
    const inQueue = queued.has(p.id);
    switch (p.status) {
      case PLAYER_STATUS.WAITING:
        if (!inQueue || inMatch.has(p.id) || holding.has(p.id)) fail(`${p.id} waiting state is inconsistent`);
        if (typeof p.queuedAt !== 'number') fail(`${p.id} waiting without queuedAt`);
        break;
      case PLAYER_STATUS.IN_MATCH:
        if (inQueue || inMatch.get(p.id) !== p.matchId || holding.has(p.id)) fail(`${p.id} in_match state is inconsistent`);
        if (s.matches[p.matchId].courtId !== p.courtId) fail(`${p.id} court mismatch`);
        break;
      case PLAYER_STATUS.CHAMPION_HOLD:
        if (inQueue || inMatch.has(p.id) || holding.get(p.id) !== p.courtId) fail(`${p.id} champion_hold state is inconsistent`);
        break;
      case PLAYER_STATUS.UNAVAILABLE:
      case PLAYER_STATUS.LEFT:
        if (inQueue || inMatch.has(p.id) || holding.has(p.id)) fail(`${p.id} ${p.status} but still assigned`);
        break;
      default:
        fail(`${p.id} has unknown status ${p.status}`);
    }
  }
  for (const id of queued) if (!s.players[id]) fail(`queue references unknown player ${id}`);
}
