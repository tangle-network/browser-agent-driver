# Browser Agent Driver

Keep browser automation general-purpose; app-specific personas and hints remain optional.
Resolve current commands, models, and defaults from [package.json](package.json), CLI help, and the selected runtime configuration.

## Read for the task

- Before experiments or performance claims, read [evaluation rigor](docs/EVAL-RIGOR.md).
- Before merging, read [sign-off](docs/SIGNOFF.md) and run `pnpm signoff --source head` with the runtime in `.nvmrc`.
  Attach proof for the exact committed revision.
  Keep [signoff.config.mjs](signoff.config.mjs) aligned with the checks it mirrors.
  Report local proof separately from credentialed browser and staging checks.
- For wallet setup, RPC interception, or extension failures, read [the wallet guide](docs/guides/wallet.md) and inspect the scripts in `bench/wallet/`.
  Historical app results and extension walkthroughs require a fresh check before reuse.
- For planned work, read [the roadmap](docs/roadmap/browser-agent-ops.md).
- For repository skills, inspect `skills/` and the current `skills:install` script.

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

## Notes

`pnpm install` runs `prepare`, which sets this checkout's local `core.hooksPath` to `.githooks`.
After an install with lifecycle scripts disabled, run `pnpm run prepare` to enable the hook.
The installer skips directories without their own `.git` entry, including published package installs.

The pre-commit hook runs `scripts/check-changeset.sh` before allowing staged changes under `src/` or `bench/`.
Stage an added or modified `.changeset/*.md` in the same commit (use `pnpm changeset`, then `git add .changeset/<name>.md`).
Unstaged changesets, deleted changesets, nested files, and `.changeset/README.md` do not satisfy the check.
For an intentional exception, such as an internal-only change, use `git commit --no-verify`.
This bypasses all pre-commit and commit-msg hooks for that commit; it does not remove the release changeset requirement.
