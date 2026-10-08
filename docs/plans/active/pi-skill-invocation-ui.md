# Compact skill invocation UI

## Goal — locked

Approved in chat: replace the full-width skill divider and expanded frame with a compact skill invocation header, teal label, bold primary-text name, muted estimated token count, and theme-native subtle background. User authorized implementation and updating the installed extension.

Collapsed: `▸ 💡 SKILL  brainstorm · ≈480 tokens`
Expanded: `▾ 💡 SKILL  brainstorm · ≈480 tokens`, followed by indented dim location/line count, a blank row, and the Markdown instructions.

Keep mouse click and native Ctrl+O expansion, pipeline names, dark/light theme compatibility, and width-safe output. No changes to editor chips, prompts, skill loading, or Pi core. Hide token metadata on narrow terminals before truncating the name.

## Approach and checks

One phase, sequential waves:
1. Inspect renderer, theme API, existing regression tests and installed copy.
2. Update regression tests (prove red), then replace divider/frame rendering with a shared compact header and borderless expanded content. Preserve original renderer fallback and make the hook replaceable on reload.
3. Run LSP diagnostics, focused and related tests, whitespace review; update README. Copy only the verified extension to `~/.pi/agent/extensions/skill-transcript-badge.ts` after backing up its current contents outside the auto-loaded extension directory.

Acceptance: one collapsed row without frame/rule/path/line count; header background and semantic foreground styles; expanded dim path and line count plus Markdown; click and setExpanded toggles; arrows and PIPELINE label in both states; narrow/Unicode/long-name/empty-content cases fit their widths; reload does not retain an old render hook.

## Current State

- Inspection complete. Installed extension matches repository source before changes.
- Implementation complete in `extensions/skill-transcript-badge.ts`; README and regression tests updated.
- Red/green verified: updated badge test failed against the divider renderer, then passed against the compact renderer.
- All 10 existing `tests/test-*.mjs` scripts present at verification time passed; `git diff --check` passed. LSP provided syntax-only tree-sitter checks; no TypeScript compiler/server is available in this workspace.
- Installed copy updated and independently passed the focused regression suite; byte-for-byte match confirmed. Backup: `/home/tinhpt/.pi/agent/backups/skill-transcript-badge.ACAZQ9vi.ts`.
- User must run `/reload` to refresh the running Pi UI. No live-terminal visual verification performed.
- Unrelated `docs/plans/active/pi-decision-compact.md` and concurrently created `tests/test-decision-compact.mjs` are present; not modified.
