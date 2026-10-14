// Skill-weight experiment (Phase 2 hardening). Runs the full grid for each
// candidate on identical seeds/scenarios and prints comparison tables.
//
// Usage:
//   node sim/skill-experiment.js --seeds 1,2,3 --candidates w7,w8,w9,w10 --out dir
//   node sim/skill-experiment.js --seeds 4,5,6 --candidates w7,w10 --out dir   (held-out check)
//
// An adaptive policy (skillGap 10 for <=8 active players, 9 for <=12, else 7) was also
// tested through a temporary engine hook and rejected; see docs/fairness-audit-phase2.md
// ("Phase 2 hardening"). The hook was removed so production code carries no unused policy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COUNTS, aggregate, grid } from './runner.js';
import { runParallel } from './pool.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const seeds = opt('seeds', '1,2,3').split(',').map(Number);
const rounds = Number(opt('rounds', 24));
const out = opt('out', null);

const base = { recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 };
export const CANDIDATES = {
  w7: { teamWeights: { ...base, skillGap: 7 } },
  w8: { teamWeights: { ...base, skillGap: 8 } },
  w9: { teamWeights: { ...base, skillGap: 9 } },
  w10: { teamWeights: { ...base, skillGap: 10 } },
};
const names = opt('candidates', 'w7,w8,w9,w10').split(',');

const p = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
const results = {};
for (const name of names) {
  const c = CANDIDATES[name];
  if (!c) throw new Error(`unknown candidate ${name}`);
  const started = Date.now();
  const runs = await runParallel([...grid({ seeds, rounds })].map((cfg) => ({ ...cfg, ...c })));
  const failed = runs.filter((r) => r.error);
  if (failed.length) throw new Error(`${name}: ${failed.length} failed runs, e.g. ${failed[0].error}`);
  results[name] = runs;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}-seeds${seeds.join('')}.json`), JSON.stringify(runs));
  }
  console.error(`${name}: ${runs.length} runs in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

function row(label, rs) {
  const a = aggregate(rs);
  return `| ${label} | ${p(a.skillDiff0)} | ${p(a.skillDiffGe2)} | ${p(a.skillDiffGe3)} | ${p(a.teammateRecentRate)} | ${p(a.exactRecentRate)} | ${a.hardViolations + a.waitViolations + a.unjustifiedConsecutive} | ${a.maxConsecutivePassesMax} | ${a.waitP90.toFixed(1)} | ${a.championViolations} |`;
}
const header = '| Candidate | Gap 0 | Gap ≥2 | Gap ≥3 | Teammate recent | Repeated full match (recent) | Rotation violations | Max consec. waits | Wait p90 | Champion viol. |\n|---|---|---|---|---|---|---|---|---|---|';

for (const mode of ['fair', 'champion']) {
  for (const mix of [false, true]) {
    console.log(`\n### ${mode} · Mix ${mix ? 'ON' : 'OFF'} · all player counts (seeds ${seeds.join(',')})\n`);
    console.log(header);
    for (const name of names) console.log(row(name, results[name].filter((r) => r.cfg.mode === mode && r.cfg.mix === mix)));
  }
  console.log(`\n### ${mode} · Mix OFF · by active player count (gap ≥2 / teammate recent / repeated full match)\n`);
  console.log(`| Players | ${names.join(' | ')} |\n|---|${names.map(() => '---').join('|')}|`);
  for (const n of PLAYER_COUNTS) {
    const cells = names.map((name) => {
      const a = aggregate(results[name].filter((r) => r.cfg.mode === mode && !r.cfg.mix && r.cfg.players === n));
      return `${p(a.skillDiffGe2)} / ${p(a.teammateRecentRate)} / ${p(a.exactRecentRate)}`;
    });
    console.log(`| ${n} | ${cells.join(' | ')} |`);
  }
}
