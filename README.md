# จัดก๊วนแบด — Badminton matchmaking

Zero-dependency Node.js (≥20) app: pure session engine, JSON HTTP API, Thai-first web UI.

```bash
npm start            # http://localhost:3000  (PORT, DATA_FILE env vars optional)
npm test             # node:test — engine + HTTP API
```

`DATA_FILE=./data.json npm start` persists sessions (atomic temp-file + rename) across restarts.

## Layout

| Path | Purpose |
| --- | --- |
| `src/engine/session.js` | Session state model, commands, invariants. Pure: `applyCommand(state, cmd) → { state, result }` |
| `src/engine/errors.js` | `DomainError` codes → HTTP status |
| `src/store.js` | In-memory store, host-token auth, idempotency keys, optimistic versioning, persistence |
| `src/server.js` | `node:http` routes + static files |
| `public/` | Thai UI (vanilla JS, polls every 3 s) |

## State model

- **Session:** `setup → active → ended`. Matches can only run while `active`; mode can change in `setup` or `active`.
- **Court:** `effectiveMode`, `pendingMode`, `champion { team, streak }`, `pendingOverride`, `currentMatchId`.
- **Match:** `scheduled → in_progress → completed | cancelled`. Each match records the `mode` it was scheduled under.
- **Player:** `waiting` (in queue) · `in_match` · `champion_hold` (champion pair holding an idle court) · `unavailable` · `left`. Player records and stats are never deleted.

**Atomicity.** Every command runs on a `structuredClone` of the state. `assertInvariants` must pass before the store swaps it in. Commands dispatch synchronously in a single Node process, so no two can interleave.

The invariants guarantee:
- no player appears on two courts, in two matches, or twice in the queue
- player status matches their actual location
- `wins + losses = gamesPlayed`
- champion streaks stay in range

## Rules as implemented

**Fair mode** (default): both teams rotate out after every match. Next players are chosen by fewest games played, then by queue order.

**Champion mode** (max 2 consecutive wins):
- The first winner on a court is crowned with streak 1.
- If the champion wins again, the streak reaches 2 and **both** teams rotate out.
- If the challenger wins, they become the new champion with streak 1, and the old champion goes back to the queue.
- Fairness metrics never revoke a champion.
- Streaks are tracked per court.

**Mode switching:**
- The switch applies immediately on idle courts.
- On busy courts it is stored as `pendingMode` and applied after that match completes or is cancelled. The running match is never touched.
- A winner is retained only if the match was played under Champion rules **and** the court is still in Champion mode after the pending switch. So:
  - Fair → Champion mid-match: the current match finishes under Fair rules, and the next completed match crowns the first champion.
  - Champion → Fair mid-match: the result counts in stats, but nobody is retained.
- Switching back before the match ends withdraws the pending change.
- Queue order, stats and history are preserved.

**Champion override** (host-only, needs `confirm: true`):

| Action | When | Effect |
| --- | --- | --- |
| `release_now` | Court idle, champion holding | Champion pair returns to the queue |
| `release_after_match` | Champion is playing | Champion is not retained. A winning challenger can still be crowned |
| `force_rotate_after_match` | Match under Champion rules | Both teams rotate out, nobody is crowned |
| `cancel_pending` | A pending override exists | Withdraws it |

Overrides never count as wins or losses and never delete match records. Each one is logged as `CHAMPION_OVERRIDE_REQUESTED` / `_APPLIED`.

**Emergency controls:**
- **Substitute:** before a match starts, no confirmation is needed. During a match, `confirm: true` is required. If no substitute is named, the top-priority waiting player comes in.
  - The player taken out can return to the front of the queue, become unavailable, or leave. They get no game credit.
  - Substituting a champion player ends that court's streak, so it also needs confirmation.
- **Cancel a match:** no winner and no stats are recorded. The non-champion players go back to the front of the queue. An intact champion keeps its streak. Cancelling an in-progress match needs confirmation.
- **Unavailable / remove:** only for players who are not in a match. Use substitute for anyone on court. Applying either to a champion holding a court needs confirmation and dissolves the pair.
- **Return to queue:** works for unavailable or departed players; they rejoin at the end of the queue.
- **Add a player mid-session:** they join the end of the queue. With 0 games they get fairness priority.

## API

Admin routes need an `X-Host-Token` header (returned once when the session is created). Viewers only get the `GET` routes.
Optional headers: `Idempotency-Key` (a duplicate submit replays the first response instead of applying twice) and `If-Match: <version>` (a stale write gets 409 `VERSION_CONFLICT`).

| Method & path (`/api/sessions/:id…`) | Body |
| --- | --- |
| `POST /api/sessions` | `{ name, courtCount, playerNames[], mode? }` → `{ session, hostToken }` |
| `GET ` | → `{ session, role }` |
| `GET /events?since=<seq>` | session event history |
| `POST /start` · `POST /end` | `/end` needs `{ confirm: true }` |
| `PUT /mode` | `{ mode: 'fair' \| 'champion' }` |
| `POST /courts/:courtId/next` | schedules the next match by fairness priority |
| `POST /courts/:courtId/champion-override` | `{ action, confirm }` |
| `POST /matches/:matchId/start` | |
| `POST /matches/:matchId/result` | `{ winner: 'A' \| 'B' }` |
| `POST /matches/:matchId/cancel` | `{ confirm?, reason? }` |
| `POST /matches/:matchId/substitute` | `{ outPlayerId, inPlayerId?, outStatus?, confirm? }` |
| `POST /players` | `{ name }` |
| `POST /players/:pid/unavailable` · `POST /players/:pid/return` · `DELETE /players/:pid` | `{ confirm? }` |

Errors come back as `{ error: { code, message } }`. Status codes: 400 validation, 401/403 auth, 404 not found, 409 state conflict, 422 idempotency-key reuse, 428 `CONFIRMATION_REQUIRED`.
