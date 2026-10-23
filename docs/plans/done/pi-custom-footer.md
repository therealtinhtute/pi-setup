# Pi custom footer

## Status
- Spec: locked — user approved the proposed design.
- Plan: implemented through installation.
- Implementation: complete. TUI smoke test **passed** (the custom footer with the
  `👾 <model> · <thinking> · <context bar> · ⌥ <branch>` line is rendering in the
  running Pi). Closed 2026-10-23.

## Goal
Replace the interactive Pi footer with one compact, left-aligned line:

```text
 ✦ Opus 5.5 · low · ──────── 0% · ⌥ main
```

The example model, thinking level, percentage, and branch are placeholders for live data, not hardcoded values.

## Locked decisions
- Add `extensions/custom-footer.ts`; keep the banner independent.
- Use `ctx.ui.setFooter()` and Pi's existing theme/TUI helpers; no extra package.
- Enable automatically on `session_start` in TUI mode only.
- Model: current model display name, falling back to ID, then `no model`.
- Thinking: current thinking level from Pi; reflect changes without restarting.
- Context: use `ctx.getContextUsage().percent`; this measures context-window usage, not task progress.
- Bar: eight cells, unfilled `─`, filled `━`; round the clamped percentage to the nearest cell.
- Display percentage rounded to a whole number. Missing or null usage displays `?%` with an unfilled bar, not fabricated `0%`.
- Branch: use the footer provider's Git branch; omit the entire branch segment outside Git.
- Colors: purple model, muted thinking/separators, cyan branch. Context is green below 70%, yellow from 70%, red from 90%.
- Use semantic theme colors so light/dark themes and terminal color capabilities remain supported.
- Keep every rendered line within terminal width using TUI helpers; truncate gracefully in narrow terminals.
- Register `/custom-footer` to restore this footer and `/builtin-footer` to restore Pi's footer.
- Subscribe to branch changes to request rendering; dispose subscriptions when the footer is replaced.

## Trade-offs and scope
The custom footer hides Pi's default cwd, token/cost totals, and other extension statuses. `/builtin-footer` restores those. No changes to model selection, thinking settings, or context compaction behavior. No timers, Git subprocesses, animations, or new dependencies.

## API evidence
Installed Pi documentation and reference example were inspected:
- `docs/extensions.md`, `docs/tui.md`, `docs/themes.md`.
- `examples/extensions/custom-footer.ts`.
- `dist/core/extensions/types.d.ts`: `setFooter`, `getContextUsage`, `getThinkingLevel`.
- Footer data provider: `getGitBranch`, `onBranchChange`.

## Execution plan
### Phase 1 — Implement (one wave)
1. Add the extension and live render function.
2. Add TUI-only automatic installation and restore commands.
3. Wire branch invalidation and subscription cleanup.

### Phase 2 — Verify (after Phase 1)
1. Load the extension through Pi's installed TypeScript loader with a mocked API.
2. Assert the sample structure, model fallback, thinking changes, and branch omission.
3. Check context at 0%, midrange, 70%, 90%, 100%, missing, and null; check all eight cells.
4. Render at widths 0, 1, 10, 20, 40, 80, and 120 in light/dark themes; assert visible widths never exceed the available width.
5. Verify restore commands, non-TUI guards, branch-triggered rerender, and disposal.
6. Run `git diff --check`.

### Phase 3 — Install and smoke test (after verification)
1. Copy the new extension into `~/.pi/agent/extensions/`; back up an existing file if present.
2. User runs `/reload` and checks model/thinking changes, branch changes, and `/builtin-footer` / `/custom-footer` in the real TUI.

## Acceptance criteria
- One live, left-aligned status line matches the approved layout.
- No fake model name or fake context percentage.
- Theme-aware colors and no terminal-width overflow.
- Built-in footer can be restored without restarting Pi.
- Banner changes remain untouched.

## Verification results (original implementation)
These results describe the original footer design, not the current footer's emoji, gradient colors, TPM, and cache-hit additions.
- `node scripts/test-custom-footer.mjs`: PASS for dark/light themes, exact example layout, live model/thinking/branch, all bar fill levels, percentage thresholds/clamping/unknown values, Unicode and widths 0–120, restore commands, non-TUI guards, branch rerender, and idempotent subscription cleanup.
- `node --check scripts/test-custom-footer.mjs`: PASS.
- `bash -n setup/install.sh`: PASS; existing installer already copies all `extensions/*.ts`, so no installer change needed.
- `git diff --check`: PASS.
- Local review: no new dependencies, timers, shell commands, or full-session scans in rendering; labels strip terminal control characters. Model/thinking subscriptions are removed alongside branch subscriptions on disposal.
- No repository package manifest or dedicated lint/build/typecheck command is available. TypeScript extension was loaded via the installed Pi/Jiti stack; this is not a static TypeScript check.
- Managed work/check playbooks are absent; execution and gate used the locked plan and repo-local checks.

## Current State
The original footer implementation is already merged. The plan and standalone verification entry point are tracked in PR #4.

The standalone script had drifted from the current footer: it lacked `sessionManager` mocks and asserted the obsolete layout/colors. `scripts/test-custom-footer.mjs` now imports the canonical `tests/test-custom-footer.mjs` suite instead of duplicating it. Both entry points pass in dark/light themes, including current layout, context gradients, TPM, cache hit, widths, Unicode, commands, and subscription cleanup. The compact-tools, web-search-config, and package-selection suites also pass; syntax and whitespace checks pass.

Real TUI smoke testing remains pending: run `/reload`, change model/thinking and Git branch, and test `/builtin-footer` / `/custom-footer`. No runtime extension changes were needed for this test fix.
