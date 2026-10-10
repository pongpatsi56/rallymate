export class DomainError extends Error {
  /**
   * @param {string} code machine-readable error code (mapped to HTTP status + Thai text by callers)
   * @param {string} message developer-facing description
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const ERROR_HTTP_STATUS = Object.freeze({
  VALIDATION_ERROR: 400,
  UNKNOWN_COMMAND: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  MATCH_NOT_FOUND: 404,
  COURT_NOT_FOUND: 404,
  INVALID_SESSION_STATE: 409,
  INVALID_MATCH_STATE: 409,
  MATCH_ALREADY_FINISHED: 409,
  INVALID_PLAYER_STATE: 409,
  PLAYER_IN_MATCH: 409,
  PLAYER_NOT_IN_MATCH: 409,
  PLAYER_NOT_AVAILABLE: 409,
  COURT_BUSY: 409,
  COURT_IDLE: 409,
  NO_CHAMPION: 409,
  NOT_CHAMPION_MODE: 409,
  NO_PENDING_OVERRIDE: 409,
  NOT_ENOUGH_PLAYERS: 409,
  DUPLICATE_NAME: 409,
  ACTIVE_MATCHES: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 422,
  CONFIRMATION_REQUIRED: 428,
  PAYLOAD_TOO_LARGE: 413,
  INVARIANT_VIOLATION: 500,
});

export function httpStatusFor(code) {
  return ERROR_HTTP_STATUS[code] ?? 500;
}
