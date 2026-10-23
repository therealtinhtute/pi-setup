---
status: done
lane: normal
---
# Confirm gate for destructive commands

## Goal
- outcome: when the agent is about to run a command matching a configured pattern (starting with `git push`), Pi asks for confirmation before the command executes; Enter accepts, any other choice blocks the call and tells the model why.
- success_signal: `git push` issued by the agent shows a Yes/No dialog in the TUI; accepting runs it, declining blocks it and the model receives the reason string. Headless `pi -p` runs pass through untouched.
- actors: the operator at the keyboard (protected from an unintended push); the agent (receives a block reason instead of silent failure).
- authority: `dist/core/extensions/types.d.ts:76` (`ctx.ui.confirm`), `:1089-1098` (`ToolCallEventResult.block/reason`), `:942-945` (`BashToolCallEvent.input`); `interactive-mode.js:2157-2163` (confirm is a Yes/No selector defaulting to Yes).
- requirements:
  - R1: a bash call whose command matches a pattern in the guard config prompts `ctx.ui.confirm` before execution | acceptance: unit test drives the handler with a fake UI and asserts confirm was called with the matched command; live check in TUI | source: types.d.ts:76
  - R2: declining (confirm returns false) returns `{ block: true, reason }` so the tool does not run and the model sees why | acceptance: unit test asserts the handler result equals a block result containing the pattern | source: types.d.ts:1089-1098
  - R3: accepting (confirm returns true) returns undefined so the call proceeds unchanged | acceptance: unit test asserts the handler returns undefined and the input object is not mutated | source: types.d.ts:1091 note that argument changes are done by mutating `event.input`, which this must not do
  - R4: patterns come from a JSON file, validated strictly; a malformed or missing file falls back to a safe default (`["git push"]`) and never throws | acceptance: unit test with missing file, invalid JSON, wrong types, empty array; each yields the default and no exception | source: user decision 2026-10-23 (configurable via JSON)
  - R5: without UI (`ctx.hasUI === false`, i.e. `pi -p`) the handler returns undefined and never blocks | acceptance: unit test with `hasUI: false` asserts confirm is not called and nothing is blocked | source: user decision 2026-10-23 (pass through when no UI)
  - R6: matching is substring-based on the literal command text, case-sensitive, and does not evaluate regex or shell | acceptance: unit test with metacharacters in the pattern and in the command asserts literal behaviour | source: simplicity — a regex engine here would be a footgun
- non-goals:
  - NG1: policing tools other than bash (write/edit/read are out of scope; file writes are already reversible via git in this repo)
  - NG2: an allowlist or long-lived approval ("don't ask again") — every match prompts
  - NG3: blocking in headless mode, or any CI integration
  - NG4: replacing `git`'s own protections, branch protection, or the pre-push hook added in PR #10

## Phases and Verification
- approach: one extension file reading a JSON pattern list and gating `tool_call` for bash; rejected: a full permission-policy engine with per-tool rules and approval caching, which is more surface than the request needs
- phase_slug: `main`
  status: planned
  - goal: R1, R2, R3, R4, R5, R6 | depends_on: none
  - surfaces: `extensions/confirm-guard.ts` (new), `tests/test-confirm-guard.mjs` (new), `config/confirm-guard.example.json` (new), `setup/install.sh` unchanged, README section | avoided: pi core, pi-pretty, rewind, any pinned package
  - phase check: `node tests/test-confirm-guard.mjs` covers R1–R6 with a fake UI; `pi` in a TUI must show the dialog for a real `git push`

## Log
- 2026-10-23 ui: replaced the generic selector with a Claude-Code-shaped dialog in `box.ts`. The design was measured from a real Claude Code permission screenshot (OCR + pixel sampling) rather than guessed, which corrected two assumptions: there is **no box** (a single continuous dim rail runs down the left edge), and the command is **plain bright text**, not a tinted code block. Colours sampled: rail #666666, title #6c9ccc, meta #848484, command #d8d8d8, selection #6c9ccc. Mapped to pi theme tokens dim/accent/muted/text.
- 2026-10-23 ui: the extension had to become a directory (`extensions/confirm-guard/{index.ts,box.ts}`) because Pi loads *every* top-level `.ts` in `extensions/` as an extension, so a sibling `confirm-box.ts` failed with "does not export a valid factory function". `setup/install.sh` only syncs subdirectories that contain `index.ts`, which matches that loader rule.
- 2026-10-23 test: assertions rewritten for the measured design (rail continuity, no box glyphs, no background fill on the script, four distinct colour registers). Colour is sampled **at the label's own column**: reading "first non-rail SGR" picked up the `>` pointer, which is accent regardless of the label, so a "selected option turned into plain text" mutation survived. 7/7 mutations caught after that fix.
- 2026-10-23 merged: PR #13 merged into main as `6fec4ad`; branch deleted; `fork` remote removed per owner (only `therealtinhtute` is used).
- 2026-10-23 git: commit `6b233b3` on `feat/confirm-guard`, PR #13 opened (+556 across 4 files). `.harness/` added to `.gitignore` (local workflow state, never tracked).
- 2026-10-23 work: `extensions/confirm-guard.ts` + `tests/test-confirm-guard.mjs` written. Red/green proven by three mutations: case-insensitive matching (R6 failed), accept-also-blocks (R3 failed), empty-pattern-disables-guard (R4 failed); each restored to green.
- 2026-10-23 check (independent judge, worker-lsp): REQUEST_CHANGES with 5 major + 6 minor findings. Verified each before acting — every one reproduced. Fixed: (1) whitespace-normalised matching so `git  push` no longer bypasses; (2) `displayCommand()` strips control bytes and caps length in both the dialog and the block reason; (3) gated on `ctx.mode === "tui"` instead of `hasUI`, because RPC also reports hasUI and its confirm has no timeout — `--mode rpc` would have hung the tool call; (4) config path now uses `getAgentDir()` so `PI_CODING_AGENT_DIR` is honoured; (5) `ENOENT` is distinguished from `EACCES` so an unreadable config reports a problem instead of silently running defaults; (6) block reason caps the command. Tests now drive the *registered* handler via a fake `pi` (deleting `pi.on` fails), assert the dialog shows the real command, assert the tool input is not mutated, and cover `print`/`json`/`rpc` pass-through. 8/8 mutations caught.
- 2026-10-23 review: found that `decide()` was exported and tested but the registered `tool_call` handler re-implemented the same logic inline, so breaking the handler left every test green. Extracted `handleToolCall()` and pointed the `pi.on` registration at it; tests now drive the registered path. Three handler-level mutations (no block, no `hasUI` gate, no `toolName` gate) each turn the suite red.
- 2026-10-23 work: live TUI check via pty — dialog rendered `Run git push?` with `Yes`/`No`, `→` on Yes, and Enter accepted. Headless `pi -p "git push --dry-run"` ran without prompting, confirming R5.

## Validation
- R1 prompt on match — PASS (`tests/test-confirm-guard.mjs` asserts confirm called once with the matched pattern; TUI showed the dialog)
- R2 decline blocks — PASS (unit: block true, reason names pattern and command)
- R3 accept passes through — PASS (unit: `{ block: false }`; live: command ran)
- R4 strict config, never throws — PASS (unit: invalid JSON, wrong shape, empty list, non-strings, missing file)
- R5 no UI never blocks — PASS (live: `pi -p` ran `git push --dry-run` with no prompt)
- R6 literal matching — PASS (unit: case-sensitive, `.` not a wildcard)

## Current State and Next Action
- active_phase: main
- lifecycle_status: done
- blockers: none
- open_items: none — config lives at `~/.pi/agent/confirm-guard.json`, absent means defaults `["git push"]`; no example file shipped because the default is already the useful case
- exact_next_action: none — PR #13 merged as 6fec4ad
