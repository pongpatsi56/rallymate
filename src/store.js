import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DomainError } from './engine/errors.js';
import { applyCommand, createSession, rankQueue } from './engine/session.js';

const IDEMPOTENCY_CACHE_SIZE = 500;

/**
 * Holds sessions in memory and is the single place state is swapped.
 * Node runs each dispatch synchronously, so validate → apply → commit cannot interleave.
 */
export class SessionStore {
  constructor({ dataFile = null, clock = () => Date.now() } = {}) {
    this.dataFile = dataFile;
    this.clock = clock;
    /** @type {Map<string, { state: object, hostToken: string, idempotency: Map<string, object> }>} */
    this.sessions = new Map();
    if (dataFile) this.#load();
  }

  create(input) {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const state = createSession({ ...input, id, now: this.clock() });
    const hostToken = randomBytes(24).toString('base64url');
    this.sessions.set(id, { state, hostToken, idempotency: new Map() });
    this.#persist();
    return { state, hostToken };
  }

  get(id) {
    const entry = this.sessions.get(id);
    if (!entry) throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`);
    return entry.state;
  }

  isHost(id, token) {
    const entry = this.sessions.get(id);
    if (!entry || typeof token !== 'string' || !token) return false;
    const a = Buffer.from(entry.hostToken);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * @param {string} id
   * @param {object} command
   * @param {{ idempotencyKey?: string, expectedVersion?: number }} [opts]
   */
  dispatch(id, command, { idempotencyKey, expectedVersion } = {}) {
    const entry = this.sessions.get(id);
    if (!entry) throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`);

    if (idempotencyKey) {
      const cached = entry.idempotency.get(idempotencyKey);
      if (cached) {
        if (cached.fingerprint !== JSON.stringify(command)) {
          throw new DomainError('IDEMPOTENCY_MISMATCH', 'Idempotency key was already used for a different request');
        }
        return { ...cached.response, replayed: true };
      }
    }
    if (expectedVersion !== undefined && expectedVersion !== entry.state.version) {
      throw new DomainError('VERSION_CONFLICT', `Session is at version ${entry.state.version}, expected ${expectedVersion}`, {
        currentVersion: entry.state.version,
      });
    }

    const { state, result } = applyCommand(entry.state, command, { now: this.clock(), actor: 'host' });
    entry.state = state;
    const response = { result, version: state.version };
    if (idempotencyKey) {
      entry.idempotency.set(idempotencyKey, { fingerprint: JSON.stringify(command), response });
      if (entry.idempotency.size > IDEMPOTENCY_CACHE_SIZE) {
        entry.idempotency.delete(entry.idempotency.keys().next().value);
      }
    }
    this.#persist();
    return { ...response, replayed: false };
  }

  #persist() {
    if (!this.dataFile) return;
    const data = [...this.sessions.values()].map(({ state, hostToken }) => ({ state, hostToken }));
    const tmp = `${this.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: data }));
    renameSync(tmp, this.dataFile);
  }

  #load() {
    if (!existsSync(this.dataFile)) return;
    const { sessions } = JSON.parse(readFileSync(this.dataFile, 'utf8'));
    for (const { state, hostToken } of sessions) {
      this.sessions.set(state.id, { state, hostToken, idempotency: new Map() });
    }
  }
}

/** Read-only projection for viewers and hosts alike; never contains the host token. */
export function publicView(state, now = Date.now()) {
  return {
    ...state,
    priorityQueue: rankQueue(state),
    serverTime: now,
  };
}
