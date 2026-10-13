#!/usr/bin/env bash
# install.sh — Bootstrap the Pi coding agent global config from this repo.
#
# Safe to run repeatedly. Backs up every file it overwrites.
#
# Usage:
#   bash setup/install.sh            # install, never clobber existing config
#   bash setup/install.sh --force    # overwrite settings.json / web-search.json too
#   bash setup/install.sh --dry-run  # print what would happen, change nothing
#
# What it does:
#   1. Copies extensions/  → ~/.pi/agent/extensions/
#   2. Copies scripts/     → ~/.pi/agent/scripts/
#   3. Installs extensions/quotas.json
#   4. Handles settings.json (install if new, otherwise show a diff)
#   5. Handles web-search.json from web-search.example.json (same rule)
#   6. Verifies and prints the remaining manual steps

set -euo pipefail
shopt -s nullglob

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
dim()    { printf '\033[0;2m%s\033[0m\n' "$*"; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    dim "    would: $*"
  else
    "$@"
  fi
}

backup() {
  local target="$1"
  [ -e "$target" ] || return 0
  run cp -r "$target" "${target}.backup.${TIMESTAMP}"
  yellow "    backed up: ${target/#$HOME/\~}"
}

# Copy src → dest only when contents differ; back up dest first.
sync_file() {
  local src="$1" dest="$2" mode="${3:-}"
  [ -f "$src" ] || return 0
  if [ -e "$dest" ] && cmp -s "$src" "$dest"; then
    dim "    unchanged: ${dest/#$HOME/\~}"
    return 0
  fi
  backup "$dest"
  run mkdir -p "$(dirname "$dest")"
  run cp "$src" "$dest"
  [ -n "$mode" ] && run chmod "$mode" "$dest"
  green "  ✓ ${dest/#$HOME/\~}"
  return 0
}

echo ""
echo "Pi Bootstrap"
echo "============"
echo "Repo:   $REPO_DIR"
echo "Target: ${PI_DIR/#$HOME/\~}"
[ "$DRY_RUN" = 1 ] && yellow "Mode:   DRY RUN (nothing will change)"
echo ""

if [ ! -d "$PI_DIR" ]; then
  red "Target directory does not exist: $PI_DIR"
  red "Install Pi first, or set PI_CODING_AGENT_DIR."
  exit 1
fi

# --- Step 1: directories -----------------------------------------------------
run mkdir -p "$PI_DIR/extensions" "$PI_DIR/scripts"
green "✓ Directories ready"

# --- Step 2: extensions ------------------------------------------------------
echo ""
echo "Extensions"
for f in "$REPO_DIR/extensions/"*.ts; do
  sync_file "$f" "$PI_DIR/extensions/$(basename "$f")"
done
# quotas.json belongs to the @latentminds/pi-quotas package but lives in extensions/
sync_file "$REPO_DIR/config/quotas.json" "$PI_DIR/extensions/quotas.json"

# --- Step 3: scripts ---------------------------------------------------------
echo ""
echo "Scripts"
for f in "$REPO_DIR/scripts/"*; do
  [ -f "$f" ] || continue
  sync_file "$f" "$PI_DIR/scripts/$(basename "$f")" 700
done

# --- Step 4: settings.json ---------------------------------------------------
SETTINGS_SRC="$REPO_DIR/config/settings.json"
SETTINGS_DEST="$PI_DIR/settings.json"
if [ ! -e "$SETTINGS_DEST" ]; then
  sync_file "$SETTINGS_SRC" "$SETTINGS_DEST"
elif [ "$FORCE" = 1 ]; then
  yellow "  settings.json: --force, overwriting"
  sync_file "$SETTINGS_SRC" "$SETTINGS_DEST"
elif cmp -s "$SETTINGS_SRC" "$SETTINGS_DEST"; then
  dim "    unchanged: ${SETTINGS_DEST/#$HOME/\~}"
else
  yellow ""
  yellow "  ⚠  settings.json already exists — not overwriting."
  yellow "     Review the diff and merge what you want:"
  yellow ""
  diff -u "$SETTINGS_DEST" "$SETTINGS_SRC" | sed 's/^/     /' || true
  yellow ""
  yellow "     Template: config/settings.json"
  yellow "     Live:     ${SETTINGS_DEST/#$HOME/\~}"
  yellow "     Re-run with --force to overwrite (a backup is taken)."
fi

# --- Step 5: web-search.json -------------------------------------------------
WS_SRC="$REPO_DIR/config/web-search.example.json"
WS_DEST="$PI_DIR/web-search.json"
if [ ! -e "$WS_DEST" ]; then
  sync_file "$WS_SRC" "$WS_DEST"
  yellow ""
  yellow "  → web-search.json is the EXAMPLE config. Edit it before use:"
  yellow "     • remove any provider you have no key for"
  yellow "     • set allowRemoteHostedProviders to true only if you accept"
  yellow "       sending fetched URLs to third-party hosted services"
elif [ "$FORCE" = 1 ]; then
  yellow "  web-search.json: --force, overwriting"
  sync_file "$WS_SRC" "$WS_DEST"
else
  dim "    unchanged: ${WS_DEST/#$HOME/\~} (not touching your live config)"
fi

# --- Step 6: verify ----------------------------------------------------------
echo ""
echo "Verification"
echo "------------"
count_ext=$(find "$PI_DIR/extensions" -maxdepth 1 -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
echo "  extensions/     : $count_ext TypeScript extensions"
echo "  scripts/        : $(find "$PI_DIR/scripts" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ') scripts"
echo "  settings.json   : $([ -f "$SETTINGS_DEST" ] && echo present || echo MISSING)"
echo "  web-search.json : $([ -f "$WS_DEST" ] && echo present || echo MISSING)"

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  yellow "Dry run complete. Nothing was written."
  exit 0
fi

# --- Step 7: version stamp ---------------------------------------------------
if git -C "$REPO_DIR" rev-parse HEAD >/dev/null 2>&1; then
  REPO_REV="$(git -C "$REPO_DIR" rev-parse HEAD)"
  printf '%s\n' "$REPO_REV" > "$PI_DIR/.bootstrap-version"
  green "✓ Bootstrap version stamped ($REPO_REV)"
fi

echo ""
green "Bootstrap complete."
echo ""
echo "Manual steps that remain:"
echo "  1. Put your API keys in ~/.env (chmod 600), one KEY=value per line."
echo "     At minimum, the providers you enabled in web-search.json."
echo "  2. Restart Pi so it picks up the new settings and env."
echo "  3. Authenticate the model providers you use (e.g. antigravity, openai-codex)."
echo "  4. Optional: point skills at your own skill repo."
echo ""
