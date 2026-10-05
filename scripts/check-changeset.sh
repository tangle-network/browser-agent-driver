#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

# Disable rename detection so moves out of src/ or bench/ still count.
if git diff --cached --quiet --no-ext-diff --no-renames -- src/ bench/; then
  exit 0
elif [ "$?" -ne 1 ]; then
  exit 1
fi

# Inspect the index, not the working tree. Deleted changesets and the README
# are not release notes. Pathspecs also handle quoted or unusual filenames.
changesets=$(git diff --cached --name-only --no-ext-diff --no-renames --diff-filter=AM -- \
  ':(top,glob).changeset/*.md' ':(top,exclude).changeset/README.md')
if [ -n "$changesets" ]; then
  exit 0
fi

printf '%s\n' \
  'Changes under src/ or bench/ require a staged changeset.' \
  'Run pnpm changeset, then git add .changeset/<name>.md and commit again.' \
  'For an intentional exception, use git commit --no-verify (see CLAUDE.md).' >&2
exit 1
