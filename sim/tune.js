// Compares stage-2 team weight sets on identical seeds/scenarios (Mix Groups OFF,
// so only team formation differs). Usage: node sim/tune.js [--seeds 2] [--rounds 20]
import { aggregate, grid } from './runner.js';
import { runParallel } from './pool.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const seeds = Array.from({ length: opt('seeds', 2) }, (_, i) => i + 1);
const rounds = opt('rounds', 20);

const ROUND_1 = {
  'skill-first (≈Phase 1)': { skillGap: 100, recentTeammate: 1, olderTeammate: 0.1, recentOpponent: 0.01 },
  'gap 8 / tm 4 / old 1 / opp 1': { skillGap: 8, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 5 / tm 4 / old 1 / opp 1 (spec start)': { skillGap: 5, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 4 / tm 4 / old 1 / opp 1': { skillGap: 4, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 3 / tm 4 / old 1 / opp 1': { skillGap: 3, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 2 / tm 4 / old 1 / opp 1': { skillGap: 2, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 5 / tm 6 / old 2 / opp 1': { skillGap: 5, recentTeammate: 6, olderTeammate: 2, recentOpponent: 1 },
  'gap 5 / tm 4 / old 1 / opp 2': { skillGap: 5, recentTeammate: 4, olderTeammate: 1, recentOpponent: 2 },
};

// Round 2 narrows in on the gap-weight range where gap>=2 stays near Phase 1 levels.
const ROUND_2 = {
  'gap 6 / tm 4 / old 1 / opp 1': { skillGap: 6, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 7 / tm 4 / old 1 / opp 1': { skillGap: 7, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 10 / tm 4 / old 1 / opp 1': { skillGap: 10, recentTeammate: 4, olderTeammate: 1, recentOpponent: 1 },
  'gap 7 / tm 4 / old 1 / opp 0.5': { skillGap: 7, recentTeammate: 4, olderTeammate: 1, recentOpponent: 0.5 },
  'gap 6 / tm 3 / old 1 / opp 0.5': { skillGap: 6, recentTeammate: 3, olderTeammate: 1, recentOpponent: 0.5 },
};
export const CANDIDATES = args.includes('--round2') ? ROUND_2 : ROUND_1;

const base = {
  players: [8, 10, 12, 16, 24], courts: [1, 2, 3], modes: ['fair', 'champion'], mixes: [false],
  scenarios: ['equal', 'unequal', 'lateJoiners', 'staggered'], seeds, rounds,
};

const p = (x) => `${(x * 100).toFixed(1)}%`;
console.log('| Weights | Mode | Skill gap avg | Gap ≥2 | Gap ≥3 | Teammate repeat | Teammate recent | Opponent recent | Group-of-4 recent | Hard viol. |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const [label, teamWeights] of Object.entries(CANDIDATES)) {
  const runs = await runParallel([...grid({ ...base, teamWeights })]);
  const failed = runs.filter((r) => r.error);
  if (failed.length) console.error(`${label}: ${failed.length} failed runs, e.g. ${failed[0].error}`);
  for (const mode of ['fair', 'champion']) {
    const a = aggregate(runs.filter((r) => !r.error && r.cfg.mode === mode && r.cfg.scenario !== 'equal'));
    const eq = aggregate(runs.filter((r) => !r.error && r.cfg.mode === mode && r.cfg.scenario === 'equal'));
    console.log(`| ${label} | ${mode} | ${a.skillDiffAvg.toFixed(3)} | ${p(a.skillDiffGe2)} | ${p(a.skillDiffGe3)} | ${p(a.teammateRepeatRate)} (equal: ${p(eq.teammateRepeatRate)}) | ${p(a.teammateRecentRate)} (equal: ${p(eq.teammateRecentRate)}) | ${p(a.opponentRecentRate)} | ${p(a.groupRecentRate)} | ${a.hardViolations + eq.hardViolations} |`);
  }
}
