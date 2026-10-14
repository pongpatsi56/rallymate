// Usage: node sim/cli.js [--seeds 3] [--rounds 24] [--json out.json] [--compare baseline.json]
//                        [--quick] [--workers N] [--mix off|on|both]
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { ENGINE_HAS_MIX, PLAYER_COUNTS, SCENARIOS, aggregate, grid } from './runner.js';
import { runParallel } from './pool.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const quick = args.includes('--quick');
const seedCount = Number(opt('seeds', quick ? 1 : 3));
const rounds = Number(opt('rounds', quick ? 12 : 24));
const jsonOut = opt('json', null);
const comparePath = opt('compare', null);
const workers = Number(opt('workers', Math.max(1, availableParallelism() - 1)));
const mixArg = opt('mix', ENGINE_HAS_MIX ? 'both' : 'off');
const mixes = { off: [false], on: [true], both: [false, true] }[mixArg];

const configs = [...grid({ seeds: Array.from({ length: seedCount }, (_, i) => i + 1), rounds, mixes })];
const started = Date.now();

const all = await runParallel(configs, workers);
const failures = all.filter((r) => r.error);
const runs = all.filter((r) => !r.error);
for (const f of failures) console.error(`FAIL ${JSON.stringify(f.cfg)}: ${f.error}`);
const baseline = comparePath ? JSON.parse(readFileSync(comparePath, 'utf8')) : null;

const f1 = (x) => (x == null ? '–' : x.toFixed(1));
const f2 = (x) => (x == null ? '–' : x.toFixed(2));
const p = (x) => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);
const vs = (fmt, a, b) => (b == null ? fmt(a) : `${fmt(b)} → ${fmt(a)}`);

// Three separate tables per group, so queue-decision quality is never conflated with
// outcomes the scheduler does not control (match length, cancellations, absences).
function table(title, groups) {
  const rows = groups.filter(([, rs]) => rs.length).map(([label, rs, base]) => [label, aggregate(rs), base && base.length ? aggregate(base) : null]);
  console.log(`\n### ${title} — rotation fairness (queue decisions)\n`);
  console.log('| Group | Runs | Priority viol. (effective games) | Waiting-order / tolerance viol. | Unjustified back-to-back | Max consec. waits | Wait p50 / p90 (min) | Champion rule viol. |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [label, a] of rows) {
    console.log(`| ${label} | ${a.runs} | ${a.hardViolations} | ${a.waitViolations} | ${a.unjustifiedConsecutive} | ${a.maxConsecutivePassesMax} | ${f1(a.waitP50)} / ${f1(a.waitP90)} | ${a.championViolations} |`);
  }
  console.log(`\n### ${title} — participation statistics (outcomes)\n`);
  console.log('| Group | Actual games spread mean / worst | Effective games spread | Elapsed match duration spread (max-min)/max | Court util. |');
  console.log('|---|---|---|---|---|');
  for (const [label, a] of rows) {
    console.log(`| ${label} | ${f2(a.spread)} / ${a.spreadMax} | ${f2(a.effSpread)} | ${p(a.elapsedSpreadRatio)} | ${p(a.utilization)} |`);
  }
  console.log(`\n### ${title} — match quality (diversity & skill)\n`);
  console.log('| Group | Teammate repeat | Teammate recent | Opponent recent | Group-of-4 recent | Exact comp. recent | Skill gap avg | Gap ≥2 | Gap ≥3 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const [label, a, b] of rows) {
    console.log(`| ${label} | ${vs(p, a.teammateRepeatRate, b?.teammateRepeatRate)} | ${vs(p, a.teammateRecentRate, b?.teammateRecentRate)} | ${vs(p, a.opponentRecentRate, b?.opponentRecentRate)} | ${vs(p, a.groupRecentRate, b?.groupRecentRate)} | ${vs(p, a.exactRecentRate, b?.exactRecentRate)} | ${vs(f2, a.skillDiffAvg, b?.skillDiffAvg)} | ${vs(p, a.skillDiffGe2, b?.skillDiffGe2)} | ${p(a.skillDiffGe3)} |`);
  }
}

const match = (r, mode, mix) => r.cfg.mode === mode && Boolean(r.cfg.mix) === mix;
for (const mode of ['fair', 'champion']) {
  for (const mix of mixes) {
    const rs = runs.filter((r) => match(r, mode, mix));
    const bs = baseline?.filter((r) => r.cfg.mode === mode); // baseline engine has no Mix Groups
    const name = `${mode === 'fair' ? 'Fair' : 'Champion'} · Mix ${mix ? 'ON' : 'OFF'}${baseline ? ' (baseline → now)' : ''}`;
    table(`${name} — by scenario`, Object.keys(SCENARIOS).map((s) => [s, rs.filter((r) => r.cfg.scenario === s), bs?.filter((r) => r.cfg.scenario === s)]));
    table(`${name} — by player count`, PLAYER_COUNTS.map((n) => [`${n} players`, rs.filter((r) => r.cfg.players === n), bs?.filter((r) => r.cfg.players === n)]));
  }
}

console.log(`\n${all.length} runs, ${failures.length} failures, ${workers} workers, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(runs));
process.exitCode = failures.length ? 1 : 0;
