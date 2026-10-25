# Local signoff

Before merging, run the complete signoff against the committed revision through the admitted Beelink gate. It owns the outer frozen install; the maintained signoff runner retains its own clean-worktree frozen install:

```bash
beelink-gate auto https://github.com/tangle-network/browser-agent-driver.git <full-sha> -- bash -lc 'mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/browser-agent-driver" && pnpm signoff --source head --json "${XDG_STATE_HOME:-$HOME/.local/state}/browser-agent-driver/$(git rev-parse HEAD)-signoff.json"'
```

Attach the resulting revision, verdict, and proof to the pull request.
The default working-tree mode is useful during edits but does not prove that every required file was committed.
A failed, interrupted, or narrowed run cannot authorize a merge.

The runner comes from `@tangle-network/agent-app`.
Read [its maintained documentation](https://github.com/tangle-network/agent-app/blob/main/docs/local-signoff.md) for execution and replay options.
[signoff.config.mjs](../signoff.config.mjs) owns this repository's checks and dependencies.
The configuration is the single local check owner; publication retains its own qualification.

## What it checks

The runner checks the selected revision in a clean worktree with a frozen dependency install.
It runs the Changesets release-plan parser, module boundary checks, a type-checked build, a Chromium binary installation, and unit tests.
The build invokes `tsc`, so a separate `tsc --noEmit` pass would repeat the same type checking.
`pnpm lint` remains available as a no-output developer check.
`pnpm run check:changesets` uses the same release-plan API as Changesets, accepts empty release plans, and rejects malformed frontmatter or unknown package names before merge.
It does not impose a new changeset requirement on documentation or already-versioned release PRs, and does not need a local base-branch ref.
The test suite runs twice with recorded randomized ordering.
Tests depend on both the completed build and browser installation.

Keep `pnpm run test` so the runner's test flags reach the test command.
Keep `--ignore-scripts=false` on the install command so a host setting cannot silently suppress dependency setup.
A cache can reuse downloaded package bytes; it does not replace the fresh install.

## Limits

The local configuration uses the runtime in `.nvmrc` through its explicit `nodeVersion` setting.
The local signoff does not prove every runtime accepted by `package.json` engines; no additional runtime matrix is implied.

Host operating system, architecture, libraries, filesystem, and resource contention remain outside the worktree.
Record the actual environment when comparing failures or timing.
The local browser step installs Chromium but does not install operating-system dependencies. The Beelink host must already provide those libraries; the retained npm publisher provisions its own browser dependencies.
A pass on one host does not prove a clean host has those dependencies.

No configured check runs credentialed or staging browser evaluations.
The retired tier-gate workflows were superseded by `pnpm bench:compete`; that credentialed benchmark is outside local signoff.
Local signoff cannot establish deployment health, live task quality, or behavior that no configured check exercises.

Generic PR/push CI and its failure-issue reporter are retired. Local signoff does not establish a served-release or publication result.

## Release handoff

The Changesets workflow dispatches `publish-npm.yml` at the created version tag,
so a later push to `main` cannot silently change the requested publish revision.
The workflow filename and OIDC permissions stay unchanged; npm documents
[tag-based trusted publishing](https://docs.npmjs.com/trusted-publishers/).
A version tag avoids advancing with `main`; it is not a claim that tags cannot be moved.
The publish workflow checks the requested version and npm availability before
installing dependencies, building, installing Chromium, or running tests.
The existing build and complete browser-enabled test suite still run before publishing.
Only an explicit npm `E404` permits an unpublished version; registry failures stop the job.
A release-target rejection saves that work; it is not a successful qualification.
