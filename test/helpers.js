import { applyCommand, createSession, rankQueue } from '../src/engine/session.js';

/** Small mutable wrapper around the pure engine to keep tests readable. */
export class Harness {
  constructor({ players = 8, courts = 1, mode = 'fair', start = true } = {}) {
    this.now = 1_000_000;
    const playerNames = Array.from({ length: players }, (_, i) => `ผู้เล่น${i + 1}`);
    this.state = createSession({ id: 's1', name: 'ทดสอบ', courtCount: courts, playerNames, mode, now: this.now });
    if (start) this.run({ type: 'startSession' });
  }

  run(command) {
    this.now += 1000;
    const { state, result } = applyCommand(this.state, command, { now: this.now });
    this.state = state;
    return result;
  }

  court(id = 'c1') {
    return this.state.courts.find((c) => c.id === id);
  }

  match(id) {
    return this.state.matches[id];
  }

  currentMatch(courtId = 'c1') {
    const c = this.court(courtId);
    return c.currentMatchId ? this.state.matches[c.currentMatchId] : null;
  }

  player(id) {
    return this.state.players[id];
  }

  /** Schedules, starts and returns the match on a court. */
  play(courtId = 'c1') {
    const { matchId } = this.run({ type: 'scheduleNextMatch', courtId });
    this.run({ type: 'startMatch', matchId });
    return this.match(matchId);
  }

  finish(matchId, winner) {
    return this.run({ type: 'completeMatch', matchId, winner });
  }

  /** Plays a full match on a court and returns { match, result }. */
  playAndFinish(courtId, winner) {
    const match = this.play(courtId);
    const result = this.finish(match.id, winner);
    return { match: this.match(match.id), result };
  }

  eventTypes() {
    return this.state.events.map((e) => e.type);
  }

  priority() {
    return rankQueue(this.state);
  }

  totals() {
    const ps = Object.values(this.state.players);
    return {
      games: ps.reduce((n, p) => n + p.gamesPlayed, 0),
      wins: ps.reduce((n, p) => n + p.wins, 0),
      losses: ps.reduce((n, p) => n + p.losses, 0),
    };
  }
}

export function completedMatches(state) {
  return Object.values(state.matches).filter((m) => m.status === 'completed');
}
