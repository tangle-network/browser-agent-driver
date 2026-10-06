/**
 * browser-agent-driver's sign-off gate — the local replacement for the
 * `build` job in `.github/workflows/ci.yml` as the merge gate.
 *
 * Step names and commands mirror that job, so a green run here means what a
 * green CI run meant. Two things differ deliberately: the suite runs twice
 * under randomized file order with every seed recorded, and the steps run as
 * a dependency graph instead of a line.
 *
 * This file and that job's step list are meant to stay identical. Adding a
 * step to one without the other makes the sign-off proof a weaker claim than
 * it reads as.
 *
 * `ci.yml` matrix-tests Node 20 AND 22; this gate verifies 22 only (the pin
 * `.nvmrc` and every other workflow in this repo carries). A Node-20-only
 * regression is a real gap this gate cannot see — see docs/SIGNOFF.md.
 *
 * `nodeVersion` is declared explicitly rather than left to be read off a
 * workflow: `ci.yml`'s matrix covers Node 20 and 22, while `.nvmrc` and
 * `changesets.yml`/`publish-npm.yml`/`release.yml` pin 22. 22 is the pin this
 * repo declares everywhere; docs/SIGNOFF.md names the Node 20 gap.
 */
export default {
  nodeVersion: '22',
  install: {
    // `--ignore-scripts=false` has to be on the command line, and it is not a
    // preference. A developer machine can carry `ignore-scripts=true` in
    // `~/.npmrc` (this fleet's signing host does) and pnpm honours it for
    // dependency lifecycle scripts, while a CI runner has no such file. An
    // install that inherits it verifies a DIFFERENT dependency tree than the
    // one CI verifies and reports the result as if it were CI's. The
    // environment spellings of the same setting are ignored by pnpm, so the
    // flag is the only form that takes effect.
    run: 'pnpm install --frozen-lockfile --ignore-scripts=false',
  },
  maxParallel: 4,
  steps: [
    {
      name: 'lint',
      run: 'pnpm run lint',
      timeoutMs: 15 * 60_000,
    },
    {
      name: 'check boundaries',
      run: 'pnpm run check:boundaries',
      timeoutMs: 15 * 60_000,
    },
    {
      name: 'build',
      run: 'pnpm run build',
      timeoutMs: 15 * 60_000,
    },
    {
      // Browser BINARY version only, not `--with-deps`. `--with-deps` shells
      // out to `apt-get install` for OS-level libraries, which needs root and
      // is host package-manager state — exactly the class of thing Decision
      // "what this does not claim" #1 puts out of scope (system libraries are
      // the host's, not the checked-out tree's). CI runs on a fresh
      // `ubuntu-latest` image where those libraries do not pre-exist, so it
      // needs `--with-deps` every run; a persistent dev box generally already
      // has them from a prior install. If a step in this list ever fails with
      // a missing shared library, that gap is real and this comment is why
      // the gate did not catch it — see docs/SIGNOFF.md.
      name: 'playwright browsers',
      run: 'pnpm exec playwright install chromium',
      timeoutMs: 15 * 60_000,
    },
    {
      // `run` is load-bearing, not a style choice. pnpm's own option parser
      // sits in front of a shorthand script name: measured on pnpm 10, both
      // `pnpm test <flags>` and `pnpm --filter x test <flags>` either exit
      // non-zero on the flags or exit 0 having never run the suite. Only
      // `pnpm run test <flags>` reliably forwards the shuffle flags this gate
      // appends. A green step that executed zero tests is the failure class
      // this module exists to prevent.
      //
      // `needs: ['build']` is load-bearing, not conservative padding: measured
      // directly. tests/cli-attach-command.test.ts spawns `node dist/cli.js`
      // via child_process, and without this edge the scheduler is free to
      // start the suite before `build` finishes writing `dist/`, which failed
      // exactly that file, exactly this way, on the first run of this config
      // — `Cannot find module '.../dist/cli.js'`. CI's serial step order hid
      // this: `pnpm build` always runs to completion before `pnpm test`
      // starts, so the missing edge was invisible there and only visible once
      // the steps were allowed to run as a graph.
      name: 'unit tests',
      run: 'pnpm run test',
      needs: ['playwright browsers', 'build'],
      shuffle: true,
      timeoutMs: 15 * 60_000,
    },
  ],
}
