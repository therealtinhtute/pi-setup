#!/usr/bin/env bash
# install-git-hooks.sh — install the repo's git hooks into .git/hooks/.
#
# Hooks are not tracked by git, so a clone has none until this runs. Idempotent:
# re-running overwrites the managed hooks and leaves anything else alone.
#
# Usage:  bash setup/install-git-hooks.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$REPO_DIR/.git/hooks"
SRC_DIR="$REPO_DIR/setup/git-hooks"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Not a git checkout: $REPO_DIR" >&2
  exit 1
fi
if [ ! -d "$SRC_DIR" ]; then
  echo "No hooks to install in $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$HOOK_DIR"
for src in "$SRC_DIR"/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dest="$HOOK_DIR/$name"

  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    printf '  unchanged: %s\n' "${dest/#$REPO_DIR/~repo}"
    continue
  fi
  if [ -f "$dest" ]; then
    cp "$dest" "$dest.backup.$(date +%Y%m%d_%H%M%S)"
    printf '  backed up: %s\n' "$name"
  fi
  cp "$src" "$dest"
  chmod +x "$dest"
  printf '  installed: %s\n' "$name"
done

printf '\nHooks installed. Direct pushes to main are now refused.\n'
printf 'Workflow: git switch -c feat/<name> && git push -u origin feat/<name> && gh pr create --fill\n'
