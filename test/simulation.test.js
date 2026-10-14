// CI-sized slice of the simulation grid (the full grid runs via `npm run sim`).
// Every run already fails hard on any invariant break, duplicate credit, a
// non-idempotent replay, a stale write that got through, or a rejected command
// that mutated state.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { METRIC_GROUPS, SCENARIOS, aggregate, grid } from '../sim/runner.js';
import { runParallel } from '../sim/pool.js';

let runs;
before(async () => {
  // 8 players is included so the slice contains true no-bench sessions (8p on 3 or 5 courts).
  const all = await runParallel([...grid({ players: [6, 8, 10, 16, 24], courts: [1, 3, 5], seeds: [1], rounds: 8 })]);
  const failed = all.filter((r) => r.error);
  assert.deepEqual(failed.map((r) => `${JSON.stringify(r.cfg)}: ${r.error}`), []);
  runs = all;
});

const pick = (mode, mix, scenarios) => runs.filter((r) => r.cfg.mode === mode && r.cfg.mix === mix && (!scenarios || scenarios.includes(r.cfg.scenario)));
const hasBench = (r) => !r.metrics.noBench; // someone has to sit out at full occupancy
const label = (r) => JSON.stringify(r.cfg);

describe('simulation grid (both modes, Mix ON/OFF, every scenario)', () => {
  it('covers every scenario and exercises the chaos paths', () => {
    for (const mode of ['fair', 'champion']) {
      for (const mix of [false, true]) {
        for (const scenario of Object.keys(SCENARIOS)) {
          const rs = pick(mode, mix, [scenario]);
          assert.ok(rs.length > 0 && rs.every((r) => r.metrics.completedMatches > 0), `${mode}/${mix}/${scenario}`);
        }
      }
    }
    const total = (k) => runs.reduce((n, r) => n + r.stats[k], 0);
    for (const k of ['replays', 'rejectedChecked', 'staleChecked', 'cancels', 'subsBefore', 'subsDuring', 'joins', 'rejoins', 'breaks', 'overrides']) {
      assert.ok(total(k) > 0, `${k} exercised`);
    }
  });

  it('rotation fairness: zero priority, waiting-tolerance, back-to-back and Champion Mode rule violations', () => {
    for (const r of runs) {
      assert.equal(r.metrics.hardViolations, 0, `effective-games priority: ${label(r)}`);
      assert.equal(r.metrics.waitViolations, 0, `waiting order / tolerance: ${label(r)}`);
      assert.equal(r.metrics.unjustifiedConsecutive, 0, `back-to-back: ${label(r)}`);
      assert.equal(r.metrics.championViolations, 0, `champion rules: ${label(r)}`);
    }
  });
});

describe('rotation fairness vs participation statistics', () => {
  it('keeps the two metric families separate', () => {
    for (const k of METRIC_GROUPS.rotationFairness) assert.ok(!METRIC_GROUPS.participation.includes(k), k);
    for (const k of [...METRIC_GROUPS.rotationFairness, ...METRIC_GROUPS.participation]) {
      assert.ok(k in runs[0].metrics, `metric ${k} is reported`);
    }
  });

  it('no-bench sessions: nobody ever waits, so unequal games reflect match lengths, not queue decisions', () => {
    // Fixed-roster scenarios only: joiners, breaks and departures change the bench mid-session.
    const stable = ['equal', 'unequal', 'staggered', 'championOverrides'];
    const noBench = runs.filter((r) => r.cfg.mode === 'fair' && r.metrics.noBench && stable.includes(r.cfg.scenario));
    assert.ok(noBench.length >= 16, `need enough no-bench runs, got ${noBench.length}`);
    for (const r of noBench) {
      assert.equal(r.metrics.hardViolations + r.metrics.waitViolations, 0, label(r));
      assert.equal(r.metrics.waitMax, 0, `${label(r)}: someone waited although every player fits on court`);
      assert.equal(r.metrics.elapsedMissing, 0, 'every completed match has both timestamps');
    }
    // With everyone always on court, elapsed match duration is more even than games played.
    const a = aggregate(noBench);
    const gamesRatio = noBench.reduce((n, r) => n + (r.metrics.maxGames ? r.metrics.spread / r.metrics.maxGames : 0), 0) / noBench.length;
    assert.ok(a.elapsedSpreadRatio < gamesRatio, `elapsed ${a.elapsedSpreadRatio.toFixed(3)} vs games ${gamesRatio.toFixed(3)}`);
  });
});

describe('Fair Mode targets', () => {
  it('participation statistic: actual games spread of always-present players within 2 when a bench exists', () => {
    for (const mix of [false, true]) {
      for (const r of pick('fair', mix, ['equal', 'unequal', 'championOverrides']).filter(hasBench)) {
        assert.ok(r.metrics.spread <= 2, `${label(r)} spread ${r.metrics.spread}`);
      }
    }
  });

  it('bounds consecutive waits: about one rotation with Mix OFF, at most one more with Mix ON', () => {
    for (const r of pick('fair', false, ['equal', 'unequal', 'staggered'])) {
      assert.ok(r.metrics.maxConsecutivePasses <= Math.ceil(r.cfg.players / 4) + 2, `${label(r)} passes ${r.metrics.maxConsecutivePasses}`);
    }
    for (const r of pick('fair', true, ['equal', 'unequal', 'staggered'])) {
      assert.ok(r.metrics.maxConsecutivePasses <= Math.ceil(r.cfg.players / 4) + 3, `${label(r)} passes ${r.metrics.maxConsecutivePasses}`);
    }
  });

  it('weighted teams: gap ≥3 stays rare and gap ≥2 stays bounded', () => {
    for (const mix of [false, true]) {
      const a = aggregate(pick('fair', mix, ['unequal']));
      assert.ok(a.skillDiffGe3 <= 0.01, `gap ≥3 in ${(a.skillDiffGe3 * 100).toFixed(1)}%`);
      assert.ok(a.skillDiffGe2 <= 0.15, `gap ≥2 in ${(a.skillDiffGe2 * 100).toFixed(1)}%`);
    }
  });

  it('late joiners start level: effective participation spread stays small', () => {
    const a = aggregate(pick('fair', false, ['lateJoiners']));
    assert.ok(a.effSpread <= 3, `effective spread ${a.effSpread.toFixed(2)}`);
  });

  it('Mix Groups reduces repeated groups of four and recent teammates', () => {
    const off = aggregate(pick('fair', false));
    const on = aggregate(pick('fair', true));
    assert.ok(on.groupRecentRate < off.groupRecentRate, `group-of-4 recent OFF ${off.groupRecentRate} ON ${on.groupRecentRate}`);
    assert.ok(on.teammateRecentRate <= off.teammateRecentRate, `teammate recent OFF ${off.teammateRecentRate} ON ${on.teammateRecentRate}`);
  });
});
