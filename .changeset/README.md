# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — small markdown files that describe what changed in a PR. They drive automated versioning and changelog generation.

## Workflow for contributors

Every PR that changes runtime behavior, fixes a bug, adds a feature, or otherwise affects users **should include a changeset**. PRs that are docs-only, internal refactors, test-only, or CI-only do not need one.

### Add a changeset to your PR

```bash
pnpm changeset
```

You'll be prompted to:
1. Pick the bump type:
   - **patch** — bug fix, no API change (e.g. `fix: viewer crash on malformed URL`)
   - **minor** — new feature, no breaking change (e.g. `feat: add SteelDriver`)
   - **major** — breaking change (e.g. removed flag, renamed export, changed default behavior)
2. Write a one-line summary of the change. This goes straight into `CHANGELOG.md`.

The CLI creates a file like `.changeset/witty-pandas-dance.md` — commit it with the rest of your PR.

### What happens next

1. PR merges to `main`
2. The release workflow opens (or updates) a **"Version Packages"** PR that:
   - Aggregates every unreleased changeset into the next version bump
   - Updates `package.json` version
   - Updates `CHANGELOG.md` with all the changeset summaries grouped by bump type
   - Deletes the consumed changeset files
3. When you're ready to ship a release, merge the Version Packages PR
4. The same workflow detects the merge and runs `npm publish` automatically using the `NPM_TOKEN` repo secret

You stay in control of *when* releases ship; the bump math, changelog, and publish are automated.

## Bump type cheat sheet

| Change | Bump |
|---|---|
| Add a new CLI flag, exported function, or driver | minor |
| Fix a bug, improve an error message, fix docs that affect behavior | patch |
| Remove or rename a flag/export, change default that breaks existing scripts | major |
| Pre-1.0: every minor bump can be backwards-incompatible if the changeset says so. Use major when you want to mark intent for the eventual 1.0 line. | — |

## Multiple changesets per PR

You can add more than one changeset to a single PR if it bundles unrelated changes — each one becomes its own line in the changelog. Generally one PR = one changeset is cleanest.
