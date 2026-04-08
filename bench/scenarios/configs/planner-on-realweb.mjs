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
export default {
  provider: 'openai',
  model: 'gpt-5.2',
  plannerEnabled: true,
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
