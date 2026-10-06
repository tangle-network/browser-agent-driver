# Local signoff

Before merging, run the complete signoff against the committed revision:

```bash
nvm use
pnpm signoff --source head --json /tmp/browser-agent-driver-signoff.json
```

Attach the resulting revision, verdict, and proof to the pull request.
The default working-tree mode is useful during edits but does not prove that every required file was committed.
A failed, interrupted, or narrowed run cannot authorize a merge.

The runner comes from `@tangle-network/agent-app`.
Read [its maintained documentation](https://github.com/tangle-network/agent-app/blob/main/docs/local-signoff.md) for execution and replay options.
[signoff.config.mjs](../signoff.config.mjs) owns this repository's checks and dependencies.
Keep those commands aligned with the corresponding [CI job](../.github/workflows/ci.yml).

## What it checks

The runner checks the selected revision in a clean worktree with a frozen dependency install.
It runs type checking, module boundary checks, a build, a Chromium binary installation, and unit tests.
The test suite runs twice with recorded randomized ordering.
Tests depend on both the completed build and browser installation.

Keep `pnpm run test` so the runner's test flags reach the test command.
Keep `--ignore-scripts=false` on the install command so a host setting cannot silently suppress dependency setup.
A cache can reuse downloaded package bytes; it does not replace the fresh install.

## Limits

The local configuration uses the runtime in `.nvmrc` through its explicit `nodeVersion` setting.
CI currently also tests Node 20; the local Node 22 run does not cover that additional runtime.
Read the current workflow before changing the supported runtime set.

Host operating system, architecture, libraries, filesystem, and resource contention remain outside the worktree.
Record the actual environment when comparing failures or timing.
The local browser step installs Chromium but does not install operating-system dependencies; CI runs the same command on self-hosted runners whose browser libraries come from the host.
A pass on one host does not prove a clean host has those dependencies.

No configured check runs the credentialed Tier 1 or staging browser evaluations (`pnpm bench:tier1:gate`, `pnpm bench:tier2:repeat`).
Their workflows were removed because the repository has neither `OPENAI_API_KEY` nor `AI_TANGLE_STORAGE_STATE`, so every run skipped the evaluation.
Local signoff cannot establish deployment health, live task quality, or behavior that no configured check exercises.

The CI workflow runs after pushes to `main`.
It does not provide pull-request checks.
Failures create or update the shared post-merge failure issue.
Inspect that result before claiming the corresponding hosted verification passed.
