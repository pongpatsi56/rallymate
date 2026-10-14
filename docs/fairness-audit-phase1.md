# RallyMate Phase 1: Fairness Audit and Matchmaking Hardening

Date: 2026-10-10. Status: **ready for review. Not committed.**

## 1. Audit summary

**Participation fairness was already correct and is unchanged.**
- Fair mode ranks waiting players by fewest completed games, then queue order (wait order).
- Over 4,320 simulated sessions (≈265k matches across both runs), there were 0 priority violations: no player with more games, or a later wait start, ever played ahead of an eligible waiting player.
- There were 0 unjustified back-to-back games.

**Three gaps against the Phase 1 priorities.** All three were in how teams are formed, not in who plays:

| # | Gap | Evidence before the fix |
|---|---|---|
| G1 | No skill model. Players had no skill level, so balance was impossible. | Unequal-skill sessions had a team-skill gap of 2+ in **34%** of matches |
| G2 | The team split was a fixed formula (`[0,3]` vs `[1,2]` by rank) with no teammate history. | It ignored repeat partners entirely |
| G3 | Tie-breaks were arbitrary. Equally eligible players were resolved by enqueue order (team A, then B), never by balance or seeded randomness. | Deterministic patterns that ignored skill and history |

**Fixed:**
- Skill levels added (1/2/3, default 2).
- Lineups are now chosen only among genuinely tied players. The order of preference is skill balance, then teammate variety, then queue order, then seeded random.
- Participation metrics are identical before and after, which confirms the fix cost no fairness.

**Champion mode policy is untouched.** That means max 2 consecutive wins, a winning challenger is crowned, and there is no automatic revocation. Only challenger selection benefits from the balancing.

## 2. Simulation results

**Setup:**
- Grid: players {6, 8, 10, 12, 16, 20, 24, 30} × courts {1–5} × {Fair, Champion} × 9 scenarios × 3 seeds × 24 rounds per usable court.
- That is 2,160 runs per engine version.
- Each run injects chaos: cancellations (3%), substitutions before and during matches, duplicate submissions (5%), and deliberately rejected commands.

**Definitions:**
- *Spread* is max − min games among players present the whole session who never took a break.
- *Max consec. waits* is the most scheduling events in a row a waiting player was passed over.
- *Before → after* compares the old selection rule with the new one, with the same seeds.

### Fair mode, by scenario (after the fix)

| Scenario | Avg games | Min–Max | Spread mean / worst | Max consec. waits | Wait p50 / p90 / max (min) | Teammate repeat | Skill gap avg | Gap ≥2 | Court util. | Priority viol. |
|---|---|---|---|---|---|---|---|---|---|---|
| equal | 16.5 | 3–28 | 1.07 / 6 | 8 | 11.6 / 17.7 / 102 | 65% → 57% | 0.00 → 0.00 | 0% → 0% | 84% | 0 |
| unequal | 16.5 | 3–28 | 1.07 / 6 | 8 | 11.6 / 17.7 / 102 | 65% → 65% | 1.16 → 0.11 | **34% → 2%** | 84% | 0 |
| joiners | 15.5 | 3–26 | 0.89 / 2 | 10 | 8.2 / 20.9 / 137 | 51% → 47% | 1.16 → 0.25 | 34% → 1% | 75% | 0 |
| unavailable | 15.4 | 0–27 | 0.91 / 4 | 11 | 10.3 / 17.0 / 97 | 55% → 52% | 1.15 → 0.18 | 34% → 1% | 84% | 0 |
| leaving | 18.8 | 3–27 | 1.39 / 4 | 8 | 9.0 / 14.2 / 97 | 64% → 59% | 1.15 → 0.19 | 34% → 2% | 84% | 0 |
| championStreaks* | 16.5 | 3–28 | 1.07 / 6 | 8 | 11.6 / 17.7 / 102 | 65% → 65% | 1.16 → 0.11 | 34% → 2% | 84% | 0 |
| staggered | 16.5 | 3–28 | 1.48 / 6 | 9 | 13.3 / 23.1 / 139 | 63% → 67% | 1.14 → 0.13 | 34% → 2% | 84% | 0 |
| oddWaiting | 15.2 | 3–25 | 1.02 / 3 | 9 | 14.3 / 21.1 / 116 | 61% → 40% | 1.18 → 0.18 | 34% → 1% | 84% | 0 |
| excessCourts | 23.1 | 16–28 | 1.88 / 6 | 8 | 0.0 / 3.6 / 32 | 76% → 72% | 1.16 → 0.07 | 35% → 1% | 59% | 0 |

\* In Fair mode the "repeated champion wins" bias has no effect, because there is no champion.

The spread, wait and pass columns are **identical before and after** in every Fair scenario. Skill balancing never changed who played.

### Champion mode, by scenario (after the fix)

| Scenario | Avg games | Min–Max | Spread mean / worst | Max consec. waits | Wait p50 / p90 / max (min) | Teammate repeat† | Skill gap avg | Gap ≥2 | Court util. | Priority viol. |
|---|---|---|---|---|---|---|---|---|---|---|
| equal | 16.5 | 2–27 | 1.52 / 5 | 15 | 18.1 / 27.4 / 202 | 52% → 43% | 0.00 | 0% | 84% | 0 |
| unequal | 16.5 | 3–27 | 1.52 / 5 | 15 | 17.8 / 27.0 / 208 | 51% → 53% | 1.13 → 0.46 | 32% → 9% | 84% | 0 |
| joiners | 15.5 | 3–26 | 1.25 / 3 | 16 | 11.3 / 29.5 / 216 | 43% → 40% | 1.17 → 0.56 | 34% → 10% | 75% | 0 |
| unavailable | 15.1 | 0–27 | 1.06 / 4 | 20 | 13.6 / 26.4 / 190 | 47% → 45% | 1.12 → 0.51 | 32% → 10% | 84% | 0 |
| leaving | 18.8 | 3–28 | 1.69 / 5 | 21 | 12.8 / 22.1 / 289 | 55% → 54% | 1.15 → 0.37 | 34% → 6% | 84% | 0 |
| championStreaks | 16.5 | 3–28 | 1.52 / 6 | 15 | 16.3 / 25.1 / 202 | 50% → 51% | 1.15 → 0.42 | 34% → 8% | 84% | 0 |
| staggered | 16.5 | 2–29 | 2.04 / 8 | 15 | 20.5 / 34.0 / 242 | 52% → 54% | 1.15 → 0.47 | 34% → 10% | 84% | 0 |
| oddWaiting | 15.2 | 2–25 | 1.44 / 3 | 15 | 19.9 / 32.9 / 211 | 42% → 31% | 1.15 → 0.51 | 33% → 8% | 84% | 0 |
| excessCourts | 23.1 | 16–28 | 2.17 / 6 | 9 | 1.8 / 3.9 / 32 | 65% → 67% | 1.11 → 0.32 | 31% → 7% | 59% | 0 |

† A retained champion pair is excluded from the repeat count, because staying together is the mode's rule.

Champion mode shows longer waits (p90 roughly +50%) and more consecutive passes than Fair. **This is expected**: the champion holds 2 of the 4 slots. It is not a defect. Its skill gap stays higher than Fair because the champion pair is fixed and only the challengers can be balanced.

### By player count (all scenarios)

| Players | Fair: spread mean / worst | Fair: max consec. waits | Fair: wait p50 / p90 | Fair: gap ≥2 | Champion: spread mean / worst | Champion: max consec. waits | Champion: wait p50 / p90 | Util |
|---|---|---|---|---|---|---|---|---|
| 6 | 0.81 / 1 | 3 | 1.3 / 14.4 | 34% → 0% | 0.84 / 2 | 4 | 7.8 / 16.6 | 44% |
| 8 | 1.25 / 4 | 3 | 2.0 / 5.2 | 35% → 0% | 1.44 / 4 | 4 | 2.8 / 7.6 | 67% |
| 10 | 0.63 / 4 | 4 | 3.4 / 13.4 | 30% → 0% | 1.24 / 4 | 5 | 6.8 / 17.2 | 67% |
| 12 | 1.74 / 6 | 6 | 5.1 / 9.3 | 31% → 3% | 1.96 / 8 | 8 | 7.2 / 13.9 | 82% |
| 16 | 1.58 / 6 | 6 | 9.0 / 13.4 | 29% → 2% | 1.90 / 7 | 10 | 12.7 / 21.1 | 92% |
| 20 | 1.38 / 6 | 7 | 13.6 / 19.5 | 27% → 1% | 2.08 / 6 | 11 | 18.9 / 29.9 | 96% |
| 24 | 1.21 / 6 | 10 | 18.9 / 26.0 | 30% → 1% | 1.64 / 6 | 15 | 25.6 / 40.3 | 97% |
| 30 | 1.01 / 3 | 11 | 26.5 / 35.0 | 27% → 1% | 1.53 / 4 | 21 | 35.5 / 56.3 | 98% |

### By court count (equal and unequal scenarios)

| Courts | Avg games | Fair: spread mean / worst | Fair: wait p50 / p90 | Champion: spread mean / worst | Champion: wait p50 / p90 | Util |
|---|---|---|---|---|---|---|
| 1 | 8.3 | 0.75 / 1 | 36.2 / 45.3 | 1.29 / 2 | 50.6 / 75.5 | 100% |
| 2 | 14.4 | 0.92 / 3 | 12.7 / 18.9 | 1.31 / 3 | 19.9 / 28.8 | 94% |
| 3 | 17.8 | 0.83 / 3 | 5.5 / 11.3 | 1.58 / 3 | 10.3 / 15.8 | 83% |
| 4 | 20.2 | 1.42 / 5 | 2.5 / 7.6 | 1.77 / 5 | 5.6 / 9.6 | 75% |
| 5 | 21.7 | 1.46 / 6 | 1.0 / 5.4 | 1.65 / 5 | 3.4 / 6.3 | 67% |

Utilization below 100% means courts outnumbered the players available to fill them (for example, 6 players on 5 courts). The engine correctly refuses to schedule with fewer than 4 waiting players.

### Chaos exercised (after-fix run)

| Event | Count |
|---|---|
| Commands | 421,172 |
| Duplicate submissions replayed | 20,550 |
| Rejected commands checked byte-for-byte unchanged | 38,708 |
| Cancellations | 4,290 |
| Substitutions before start / mid-match | 2,740 / 268 |
| Joins / departures / breaks | 634 / 672 / 2,142 |

**Result: 0 invariant failures in 4,320 runs.**

## 3. Issues discovered

| # | Severity | Issue | Root cause |
|---|---|---|---|
| G1 | High (requirement gap) | No skill levels, so balance was impossible. 34% of mixed-skill matches had a gap of 2+ | The player model had no skill field |
| G2 | Medium | Teammate history was ignored | The fixed `[0,3]` vs `[1,2]` split |
| G3 | Low | Ties were broken by arbitrary enqueue order, not seeded randomness | Strict `rankQueue().slice(0, n)` |
| O1 | Observation, not a defect | Spread reaches 4–6 in configurations with **no bench** (players ≤ courts × 4) | A cancelled match costs four players a game. When nobody is ever waiting, there is no one to rotate with, so they can't catch up. Runs where someone always waits: spread ≤ 2 in all but 6 of 1,080 Fair runs (3–4 in thin-bench cases such as 21 players on 5 courts) |
| O2 | Observation, structural | Teammate repeats stay high (~57–65%) in long sessions | With 8 players on 1 court, the same four play together every other round. Only 3 pairings exist among four people. Mixing the groups would make someone play back-to-back while a player with the same games waits longer, which breaks priorities 2 and 3 |
| O3 | Observation, policy | A late joiner or returning player with fewer games plays repeatedly until caught up | This is literally priority 1 ("fewer games play first"). It also explains the higher consecutive-wait numbers in the `joiners` and `unavailable` scenarios |
| S1 | Simulator bug (fixed) | Court utilization showed NaN | The sim passed busy-minutes from the wrong object. Product code was not affected |

**No correctness bugs** were found in the existing engine: invariants, idempotency, atomicity, cancellation and substitution stats, and champion streaks all held under chaos.

## 4. Fixes applied

**`src/engine/session.js`**, minimal and local:
- **Skill model.**
  - `SKILL` constants and `player.skill`, defaulting to 2. `createSession` also accepts `{ name, skill }` entries.
  - `addPlayer` takes a `skill`.
  - New `setPlayerSkill` command, which emits a `PLAYER_SKILL_CHANGED` event.
  - A new invariant validates skill.
- **`chooseLineup`** replaces the fixed split.
  - Everyone ranked strictly ahead of the last open slot always plays.
  - Only the boundary tie group (same games and same wait start, at most 8 candidates) is optimised, by skill difference, then teammate repeats, then queue position, then seeded random.
  - The search is at most C(8,4) × 3 = 210 options.
- **Seeded PRNG** stored in `state.rng`, so the engine stays pure and reproducible. Old saved sessions fall back to a seed hashed from the session id.

**Rest of the codebase:**
- **Store and API:** a random seed per session. `POST /players` accepts `skill`. New route `PUT /players/:pid/skill`.
- **UI (Thai):** a skill picker when adding a player, the `ชื่อ, 3` syntax when creating a session, a skill column with a host-only editor, skill shown in the queue, and history text for skill changes.
- **New `sim/` folder:** `runner.js` (a reusable seeded simulator, metrics and post-run verification) and `cli.js` (the grid and tables). Run them with `npm run sim` or `npm run sim:quick`.
- **New tests:**
  - `test/fairness.test.js`: 8 tests, including regression tests for G1–G3.
  - `test/simulation.test.js`: 6 tests on a 216-run CI slice.
  - One API test for skill.

**Regressions confirmed.** The new tests fail against the old selection rule (4 of 14 fail) and pass on the new one.

## 5. Test results

`npm test` → **68 tests, 16 suites, 68 pass, 0 fail** (≈13 s).

The simulation slice asserts, per run, that every invariant holds, including:
- no double assignment
- no duplicate queue entries
- no player both waiting and playing
- game credit equals completed matches
- cancellations add no games
- substitutions keep stats valid
- streak never exceeds 2
- rejected commands leave state unchanged
- duplicate submissions replay

It also checks these targets:

| Target | Assertion |
|---|---|
| Priority violations | 0 |
| Unjustified back-to-back games | 0 |
| Fair spread, runs with a bench | ≤ 2 |
| Consecutive passes | ≤ one full rotation + 2 |
| Fair matches with a skill gap ≥ 2 | ≤ 10% |
| Equal-skill teammate repeats (CI slice) | ≤ 35% |

## 6. Remaining limitations

1. **Teammate variety is structurally capped** by participation-first rules (O2). The improvement is real (65→57% equal skill, 61→40% odd waiting), but small for "8 players, 1 court" style sessions.
2. **Skill before variety is strict** (lexicographic). With mixed skills, balance wins every time, so teammate repeats do not improve in unequal-skill sessions (65%→65%).
3. **Late joiners and returning players catch up by playing repeatedly** (O3). This follows priority 1, but some clubs would rather they start at the current minimum.
4. **Ties need an exact wait start.** Players enqueued in different commands are never considered tied, even if seconds apart.
5. **Commands slow down as a session grows.** Each command clones the whole state, so per-command cost rises with history. That is fine for real sessions (hundreds of matches), but the full 2,160-run grid takes about 14 minutes.
6. **The simulation's win model is synthetic** (logistic on skill sum, with an optional champion bias). Real outcomes may differ.

## 7. Recommended next steps

1. **Host-selectable catch-up policy for joiners and returners.** For example, "start at the session's current minimum games." This would be a stored offset; real stats stay untouched.
2. **Optional "mix groups" tolerance.** Allow swapping one player between tie-adjacent groups when it removes a repeat partnership, capped so nobody gets an unjustified back-to-back game. Off by default.
3. **Weighted cost** (for example, skill difference × 2 + repeats) as an alternative to strict lexicographic order, tuned using the simulator.
4. **Opponent-repeat metric**, plus "same four again" detection.
5. **Performance.** Keep the event log outside the cloned state, or use structural sharing, if sessions get long.
6. **Real-session replay.** Feed anonymised real session logs through `sim/` to validate the win model and the metrics.
