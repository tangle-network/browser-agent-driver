// Gen 8: planner config tuned for real public-web tasks (gauntlet runs).
//
// Differences vs planner-on.mjs:
// - supervisor.maxInterventions: 4 (was 2) — real sites have more anti-bot
//   surprises, dynamic loading races, and unexpected modals; the supervisor
//   needs more chances to recover before we declare a failure
// - supervisor.minTurnsBeforeInvoke: 3 (was 5) — react sooner on stuck states
// - supervisor.hardStallWindow: 6 (was 4) — be more patient on heavy SPAs
//   that legitimately take a few turns to load (npm, github, reddit)
// - supervisor.maxConsecutiveFails: 3 (was implicit) — short-circuit faster
//   when site is fully refusing us so we don't waste budget on a captcha wall
// Gen 11 evolve round 1 (2026-04-09): default model upgraded gpt-5.2 -> gpt-5.4.
// At 5-rep matched same-day vs browser-use 0.12.6:
//   bad gpt-5.2: 34/50 = 68% pass, $0.047 cost-per-pass, 14.6s mean wall
//   bad gpt-5.4: 43/50 = 86% pass, $0.042 cost-per-pass, 8.8s mean wall
//   browser-use: 41/50 = 82% pass, $0.031 cost-per-pass, 65.3s mean wall
// gpt-5.4 is the strict winner on pass rate AND speed (7.4x faster mean wall,
// 9.3x faster p95). Cost-per-pass is +35% vs browser-use but we're ~7x faster.
// Per-task: w3c 2/5->5/5 (+3), python-docs 3/5->5/5 (+2), npm 2/5->5/5 (+3),
// mdn 2/5->3/5 (+1). These are structural fixes from a smarter model on
// extraction tasks where the planner-emitted runScript needs more reasoning
// to write the right selector first try.
export default {
  provider: 'openai',
  model: 'gpt-5.4',
  plannerEnabled: true,
  // Public browser-use comparisons exposed the planner's weak spot:
  // extraction tasks where the final JSON depends on values read after page
  // load. In auto mode BAD keeps the planner for workflow/form tasks, but
  // routes extraction-shaped tasks through the per-action observe-act loop.
  plannerMode: 'auto',
  // Gen 8: real public-web pages need a settle wait before the planner
  // observes them. SPAs (npmjs.com, github.com PR list, MDN) load their
  // dynamic content via JS after DOMContentLoaded — without this wait the
  // planner snapshots a half-loaded page and emits runScript queries
  // against selectors that don't exist yet, returning null/empty.
  // 3000ms is a reasonable upper bound; the runner races this against
  // page.waitForLoadState('networkidle') and uses whichever finishes first.
  initialObserveSettleMs: 3000,
  supervisor: {
    enabled: true,
    minTurnsBeforeInvoke: 3,
    cooldownTurns: 2,
    maxInterventions: 4,
    hardStallWindow: 6,
  },
};
