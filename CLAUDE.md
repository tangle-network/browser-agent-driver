# Browser Agent Driver

Keep browser automation general-purpose; app-specific personas and hints remain optional.
Resolve current commands, models, and defaults from [package.json](package.json), CLI help, and the selected runtime configuration.

## Read for the task

- Before experiments or performance claims, read [evaluation rigor](docs/EVAL-RIGOR.md).
- Before merging, use the canonical admitted local command in [sign-off](docs/SIGNOFF.md), with the runtime in `.nvmrc`.
  Attach proof for the exact committed revision.
  Keep [signoff.config.mjs](signoff.config.mjs) aligned with the checks it mirrors.
  Report local proof separately from credentialed browser and staging checks.
- For wallet setup, RPC interception, or extension failures, read [the wallet guide](docs/guides/wallet.md) and inspect the scripts in `bench/wallet/`.
  Historical app results and extension walkthroughs require a fresh check before reuse.
- For planned work, read [the roadmap](docs/roadmap/browser-agent-ops.md).
- For repository skills, note that `skills/macros/` and `skills/domain/` are runtime data loaded by the agent loop (`src/skills/macro-loader.ts`, `src/cli/commands/run.ts`) and ship in the npm package; the old installable prompt packs and the `skills:install` script were removed.

## Browser and experiment constraints

Verify interactions through observable page state and retained artifacts.
After an overlay dismissal, check that the intended action took effect.
Detect repeated navigation or menu loops and change the strategy.
Bound actions, observations, and initial model calls within the case's total budget.
The completion check must receive the same bounded observation available to the agent.

Separate unreachable sites, authentication failures, and bot challenges from task-completion failures while reporting both totals.
Stop paid work when provider quota or credentials prevent a valid comparison.
Benchmark repetitions need isolated memory and comparable machine, model, scenario, and evidence settings.
Adaptive routing and trace-scoring changes stay behind their existing flags until the required comparison supports promotion.
Open-web results do not excuse deterministic or staging regressions.

Wallet tests use a dedicated browser profile and disposable test keys on a local fork.
Confirm both page and extension RPC paths use the intended test network before enabling transaction approval.
Keep production wallets and credentials outside the test profile.
Use the maintained configuration script instead of rewriting extension state from a copied walkthrough.

## Release

Consumer-visible changes require a changeset with the correct compatibility level.
Documentation and internal changes without consumer impact do not.
Metric claims in the PR, changeset, and report must agree with the same checked evidence.
Verify the published artifact before claiming a release is available.

## Notes: committing changes

Keep the configured Git hooks enabled. `scripts/install-git-hooks.mjs` owns repository hook installation. If the configured path resolves to missing hook files, repair the maintained authoring setup before committing; do not replace or bypass the hooks.

Commits touching `src/` or `bench/` must stage an added or modified
`.changeset/*.md` alongside the code (`pnpm changeset`, then `git add .changeset`).
Unstaged files, deleted changesets, nested Markdown, and `.changeset/README.md` do not satisfy the check. For changes without consumer impact, use an empty changeset (`pnpm changeset --empty`). Preserve normal hooks for every commit.
