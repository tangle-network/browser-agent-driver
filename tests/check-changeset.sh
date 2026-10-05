#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Never inherit the caller's index, worktree, hooks, or signing configuration.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
mkdir -p "$tmp/repo/scripts" "$tmp/repo/.githooks"
cd "$tmp/repo"
cp "$root/package.json" .
# Optional copies let the same regression test demonstrate the missing gate on main.
for file in scripts/check-changeset.sh scripts/install-git-hooks.mjs .githooks/pre-commit; do
  if [ -f "$root/$file" ]; then cp -p "$root/$file" "$file"; fi
done
git init -q --template=
git config user.name 'Changeset test'
git config user.email 'changeset-test@example.invalid'
mkdir -p src bench .changeset docs
printf 'original\n' > src/example.ts
printf 'original\n' > bench/example.ts
printf 'original\n' > README.md
printf '%s\n' '---' '---' > .changeset/existing.md
printf 'instructions\n' > .changeset/README.md
git add .
git -c core.hooksPath=/dev/null commit -qm baseline
baseline=$(git rev-parse HEAD)
npm run --if-present prepare > "$tmp/prepare.log" 2>&1 || { cat "$tmp/prepare.log"; exit 1; }

count=0
expect_status() {
  expected=$1
  description=$2
  shift 2
  actual=0
  "$@" > "$tmp/output" 2>&1 || actual=$?
  if [ "$actual" -ne "$expected" ]; then
    printf 'FAIL: %s (expected %s, got %s)\n' "$description" "$expected" "$actual" >&2
    cat "$tmp/output" >&2
    exit 1
  fi
  count=$((count + 1))
  printf 'PASS: %s\n' "$description"
}
reset_case() {
  git reset --hard -q "$baseline"
  git clean -fdq
  mkdir -p docs
}
stage_code() {
  printf 'changed\n' >> "$1"
  git add -- "$1"
}
stage_changeset() {
  printf '%s\n' '---' '---' 'Test change.' > .changeset/new.md
  git add .changeset/new.md
}
check() { sh "$root/scripts/check-changeset.sh"; }

stage_code src/example.ts
expect_status 1 'git commit rejects src without a changeset' git commit -qm 'must be blocked'
grep -q 'Commit blocked: staged src/ or bench/' "$tmp/output"
stage_changeset
expect_status 0 'git commit accepts a staged changeset' git commit -qm 'with changeset'
reset_case
stage_code bench/example.ts
expect_status 1 'git commit rejects bench without a changeset' git commit -qm 'must be blocked'
expect_status 0 'git commit --no-verify deliberately bypasses the hook' git commit --no-verify -qm bypass

for path in src/example.ts bench/example.ts; do
  reset_case
  stage_code "$path"
  expect_status 1 "$path without a staged changeset" check
  stage_changeset
  expect_status 0 "$path with a staged changeset" check
done
reset_case
stage_code README.md
expect_status 0 'documentation-only staging needs no changeset' check
reset_case
printf 'unstaged\n' >> src/example.ts
expect_status 0 'unstaged source changes are ignored' check
reset_case
stage_code src/example.ts
printf '%s\n' '---' '---' > .changeset/untracked.md
printf 'unstaged\n' >> .changeset/existing.md
expect_status 1 'untracked and unstaged changesets do not count' check
git add .changeset/existing.md
expect_status 0 'a staged modification to a changeset counts' check
reset_case
stage_code bench/example.ts
git rm -q .changeset/existing.md
expect_status 1 'deleting a changeset does not count' check
reset_case
stage_code src/example.ts
stage_code .changeset/README.md
expect_status 1 'the changeset README does not count' check
mkdir -p .changeset/nested
printf 'nested\n' > .changeset/nested/note.md
git add .changeset/nested
expect_status 1 'nested Markdown does not count' check
reset_case
git rm -q src/example.ts
expect_status 1 'source deletions require a changeset' check
reset_case
git mv bench/example.ts docs/example.ts
expect_status 1 'renaming out of bench requires a changeset' check
reset_case
stage_code src/example.ts
git mv .changeset/existing.md docs/old-changeset.md
expect_status 1 'renaming a changeset out does not count' check
reset_case
stage_code 'src/file with spaces.ts'
expect_status 1 'spaces in paths cannot bypass the check' check
cd src
expect_status 1 'the direct check works from a subdirectory' check
cd ..
reset_case
# Running the installer in a package nested inside a consumer must be a no-op.
mkdir -p node_modules/consumer/scripts
cp scripts/install-git-hooks.mjs node_modules/consumer/scripts/
git config core.hooksPath personal-hooks
expect_status 0 'installer skips a package without its own .git' node node_modules/consumer/scripts/install-git-hooks.mjs
[ "$(git config core.hooksPath)" = personal-hooks ]
printf '%s checks passed\n' "$count"
