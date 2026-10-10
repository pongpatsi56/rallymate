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

export const DEFAULT_MAX_CHAMPION_WINS = 2;
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

  const state = {
    id,
    name: sessionName,
    status: SESSION_STATUS.SETUP,
    version: 0,
    createdAt: now,
    updatedAt: now,
    mode,
    config: { maxChampionWins },
    courts: [],
    players: {},
    queue: [],
    matches: {},
    matchOrder: [],
    events: [],
    counters: { player: 0, match: 0, event: 0 },
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
  for (const playerName of playerNames) addPlayerInternal(state, playerName, ctx);
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
  scheduleNextMatch,
  startMatch,
  completeMatch,
  cancelMatch,
  substitutePlayer,
  championOverride,
  addPlayer,
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

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

function scheduleNextMatch(s, cmd, ctx) {
  assertActive(s);
  const court = getCourt(s, cmd.courtId);
  if (court.currentMatchId) throw new DomainError('COURT_BUSY', `${court.id} already has a match`);

  const champion = court.champion;
  const needed = champion ? 2 : 4;
  const picked = rankQueue(s).slice(0, needed);
  if (picked.length < needed) {
    throw new DomainError('NOT_ENOUGH_PLAYERS', `Need ${needed} waiting players, have ${s.queue.length}`, {
      needed,
      waiting: s.queue.length,
    });
  }

  let teamA;
  let teamB;
  if (champion) {
    teamA = [...champion.team];
    teamB = picked;
  } else {
    // Split the top four so the two highest-priority players are not partners.
    teamA = [picked[0], picked[3]];
    teamB = [picked[1], picked[2]];
  }

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
  const id = addPlayerInternal(s, cmd.name, ctx);
  emit(s, 'PLAYER_ADDED', { playerId: id, name: s.players[id].name, midSession: s.status === SESSION_STATUS.ACTIVE }, ctx);
  return { playerId: id };
}

function addPlayerInternal(s, rawName, ctx) {
  const name = cleanName(rawName, 'player name');
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
    status: PLAYER_STATUS.WAITING,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
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
  enqueue(s, p.id, ctx.now);
  emit(s, 'PLAYER_RETURNED', { playerId: p.id, from }, ctx);
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
// Queue helpers
// ---------------------------------------------------------------------------

/** Waiting players by fairness priority: fewest games first, then queue order. */
export function rankQueue(s) {
  return s.queue
    .map((id, idx) => ({ id, idx, games: s.players[id].gamesPlayed }))
    .sort((a, b) => a.games - b.games || a.idx - b.idx)
    .map((e) => e.id);
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

function enqueueFront(s, ids, now) {
  s.queue.unshift(...ids);
  for (const id of ids) markWaiting(s.players[id], now);
}

function markWaiting(p, now) {
  p.status = PLAYER_STATUS.WAITING;
  p.queuedAt = now;
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
