#!/bin/sh
set -eu

# Let Git match paths: quoted filenames and renames must not bypass the check.
code=$(git diff --cached --name-only --no-renames -- ':(top)src/' ':(top)bench/')
[ -n "$code" ] || exit 0

changesets=$(git diff --cached --name-only --no-renames --diff-filter=ACM -- \
  ':(top,glob).changeset/*.md' ':(top,exclude).changeset/README.md')
[ -z "$changesets" ] || exit 0

printf '%s\n' \
  'Commit blocked: staged src/ or bench/ changes require a staged .changeset/*.md.' \
  'Run pnpm changeset, then git add .changeset. See CLAUDE.md for --no-verify.' >&2
exit 1
