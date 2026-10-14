# จัดก๊วนแบด — Badminton matchmaking

Zero-dependency Node.js (≥20) app: pure session engine, JSON HTTP API, Thai-first web UI.

```bash
npm start            # http://localhost:3000  (PORT, DATA_FILE env vars optional)
npm test             # node:test — engine, HTTP API, fairness + CI-sized simulation slice
npm run sim          # full seeded grid: 8 player counts x 5 courts x 2 modes x Mix ON/OFF x 8 scenarios x 3 seeds (parallel)
npm run sim:quick    # 1 seed, 12 rounds
npm run sim:tune     # compares team-weight candidates on identical seeds
node sim/skill-experiment.js --seeds 1,2,3 --candidates w7,w10   # full-grid skill-weight experiment (Phase 2 hardening)
```

`node sim/cli.js --json out.json --compare baseline.json` writes every run's metrics and prints before → after tables.

`DATA_FILE=./data.json npm start` persists sessions (atomic temp-file + rename) across restarts.

## Layout

| Path | Purpose |
| --- | --- |
| `src/engine/session.js` | Session state model, commands, invariants. Pure: `applyCommand(state, cmd) → { state, result }` |
| `src/engine/errors.js` | `DomainError` codes → HTTP status |
| `src/store.js` | In-memory store, host-token auth, idempotency keys, optimistic versioning, persistence |
| `src/server.js` | `node:http` routes + static files |
| `public/` | Thai UI (vanilla JS, polls every 3 s) |
| `sim/runner.js` | Seeded simulator. Drives the real store, injects chaos, verifies invariants, computes fairness metrics |
| `sim/cli.js` | Runs the grid on worker threads and prints Markdown tables (optionally vs a baseline JSON) |
| `sim/tune.js` | Weight-tuning harness for stage-2 team scoring |
| `sim/skill-experiment.js` | Full-grid skill-weight comparison on identical seeds (tuning + held-out) |
| `docs/` | Fairness audit reports (Phase 1, Phase 2) |

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

**Fair mode** (default): both teams rotate out after every match.

**Effective games** = `gamesPlayed + fairnessBaseline`. Every fairness comparison uses it; the UI always shows real `gamesPlayed`.

**Late joiners.**
- A player added to a session gets `fairnessBaseline` = the minimum effective games among *active* players, meaning `waiting`, `in_match` or `champion_hold`. Unavailable and departed players don't count. If no one is active, the baseline is 0.
- The baseline is computed once, when the player joins. Existing baselines and queue order are untouched.
- The joiner goes to the back of the queue with no inherited waiting time.

**Breaks and rejoins.**
- Returning from `unavailable` keeps the player's baseline.
- Rejoining after `left`, via **กลับเข้าคิว** on the same record, keeps the same identity and real stats. The baseline is raised to `max(old, currentMin − gamesPlayed)`, so it is never lowered.
- Adding a *new* player with a departed player's name creates a new identity, treated as a late joiner.

**Who plays next — stage 1, fairness first** (in Champion mode this picks the challengers):
1. Anyone with fewer effective games than the last open slot always plays.
2. **Mix Groups OFF** (default): the remaining slots come only from players tied on effective games *and* wait start (capped at the first 8 in queue order).
3. **Mix Groups ON**: the remaining slots can come from anyone in the boundary effective-games tier, under two limits. The first is a **waiting tolerance**: no bypassed player may have more than `waitTolerance` (1) extra wait passes than a picked one. A wait pass is one match scheduled while the player was waiting and was not picked. The second is **protection**: a player with `waitPasses ≥ ceil(queue/4) + 1` is never bypassed for an unprotected one. Inside these limits, the group is chosen to avoid recently repeated groups of four and exact compositions. Each pass of wait deficit is penalised, so normal rotation wins when mixing gains little.
4. Among the allowed groups, the engine picks the one whose best match (stage 2) scores lowest. Remaining exact ties are broken by queue order, then by the seeded random.

**How they pair up — stage 2, weighted:** every 2v2 split is scored as `7·skillGap + 4·recentTeammate + 1·olderTeammate + 1·recentOpponent`, plus `8·recentExactComposition` when Mix Groups is on.
- "Recent" means within the last `max(2, 2 × courts)` completed matches. "Older" covers the rest of a 50-match window.
- **Guardrail:** a split with a skill gap above `max(minimum gap, 2)` is never chosen.
- Weights live in `config.teamWeights` (validated, internal). They were tuned with `npm run sim:tune`; see `docs/fairness-audit-phase2.md`.

**Mix Groups** is a host setting (`config.mixGroups`, default off). It takes effect from the next line-up and never alters running matches, champion pairs or champion streaks.

**Skill levels:** 1 Beginner, 2 Intermediate (default), 3 Advanced. Set them at creation (UI line format `ชื่อ, 3`), when adding a player, or later with `setPlayerSkill`. Sessions saved before skills existed default to 2.

**Randomness:** the session stores a seeded PRNG state (`state.rng`), so commands stay pure and reproducible.

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
| `POST /api/sessions` | `{ name, courtCount, playerNames[], mode?, mixGroups? }` → `{ session, hostToken }` |
| `GET ` | → `{ session, role }` |
| `GET /events?since=<seq>` | session event history |
| `POST /start` · `POST /end` | `/end` needs `{ confirm: true }` |
| `PUT /mode` | `{ mode: 'fair' \| 'champion' }` |
| `PUT /settings` | `{ mixGroups: boolean }` |
| `POST /courts/:courtId/next` | schedules the next match by fairness priority |
| `POST /courts/:courtId/champion-override` | `{ action, confirm }` |
| `POST /matches/:matchId/start` | |
| `POST /matches/:matchId/result` | `{ winner: 'A' \| 'B' }` |
| `POST /matches/:matchId/cancel` | `{ confirm?, reason? }` |
| `POST /matches/:matchId/substitute` | `{ outPlayerId, inPlayerId?, outStatus?, confirm? }` |
| `POST /players` | `{ name, skill? }` |
| `PUT /players/:pid/skill` | `{ skill: 1 \| 2 \| 3 }` |
| `POST /players/:pid/unavailable` · `POST /players/:pid/return` · `DELETE /players/:pid` | `{ confirm? }` |

Errors come back as `{ error: { code, message } }`. Status codes: 400 validation, 401/403 auth, 404 not found, 409 state conflict, 422 idempotency-key reuse, 428 `CONFIRMATION_REQUIRED`.
