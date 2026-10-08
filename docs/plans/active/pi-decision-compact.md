# Pi decision compaction

## Status
- Stage: to-plan / full.
- Goal/spec: locked — user approved the draft after adding OpenCode Jev support.
- Execution plan: ready below. Defer to `work` for implementation.
- Implementation: not started. No live classifier requests or credential changes.
- Repo-local brainstorm/workflow playbooks are absent; use repo-local evidence and installed Pi docs.

## Goal
Build a new Pi extension in this repository that reduces model-visible tool history through decision-model judgments instead of rewriting it into a summary. Retained user/assistant text stays verbatim. Complete eligible tool-call/result pairs can be kept, have their results truncated, or be removed. Preserve raw session history and keep native compaction available when selective pruning cannot relieve context pressure.

## User-approved choices
- Develop inside `pi-setup`, not a separate package/repository.
- Match the reference's three-way keep / truncate result / drop pair capability, not output-only pruning and not a read-only-only policy.
- Default classifier: `typesafe/jev-latest`.
- The extension should be adaptable to Cloudflare Clef and other decision APIs.
- Include OpenCode-hosted Jev in the supported backends, in addition to direct TypeSafe Jev.

## Locked design

### Integration and provider boundary
- Tentative name: `pi-decision-compact`; extension entry point: `extensions/decision-compact.ts`.
- Target the Pi 1.1.0 public extension API, without patching Pi internals.
- Use `ctx.modelRegistry.findOfType("classifier", provider, modelId)` and `ctx.modelRegistry.classify()` for decisions. No new HTTP client per supported provider and no chat-model switch.
- Normalize Pi's typed classifier answers into internal keep probabilities. Use two `bool` questions per eligible call: retain the call and retain the full result. Require complete finite probabilities in [0, 1] before applying decisions; check `stopReason` explicitly.
- Configuration selects exactly one provider/model. Never silently fail over to another remote provider.
- Supported selection targets include `typesafe/jev-latest`, `opencode/jev-1.13`, `opencode/jev-1.13-free`, `cloudflare-workers-ai/@cf/cloudflare/clef`, and `cloudflare-workers-ai/@cf/cloudflare/clef-flash`. Other registered classifier models use the same boundary subject to their input/question constraints.
- OpenCode Jev uses Pi's native `opencode` classifier provider and `OPENCODE_API_KEY`/Pi-managed credentials, not a direct TypeSafe API key. Verify availability in the current catalog at runtime; the `free` variant is an explicit selection, not an automatic fallback or a guarantee of ongoing free access.
- Default remains direct `typesafe/jev-latest`; choosing OpenCode changes only decision-model configuration, not the main chat model.
- Prefer native catalog limits where available; explicit conservative backend limits where absent. Clef permits 64 questions, so two questions per call means at most 32 candidates per request before other limits.
- A non-native decision API requires a classifier provider registration later; arbitrary URL compatibility is not promised by the MVP.

### Commands and automation
- `/decision-compact preview`: run configured classification and report proposed edits without changing context. This is a remote-data operation when the selected classifier is remote, not an offline simulation.
- `/decision-compact apply`: arm a branch-scoped request; classify and append validated context edits at the next eligible `turn_end` boundary. Commands cannot commit boundary drafts while idle through Pi 1.1.0's public extension API. Report `armed`, not `applied`, until the boundary commits. Do not fabricate a chat turn to force it.
- `/decision-compact cancel`: clear an armed manual request and cancel in-flight work owned by this extension. Session changes/shutdown also invalidate in-flight work.
- `/decision-compact status`: show backend, mode, last outcome, reduction estimates, and timing without exposing credentials or transcript content.
- Keep `/compact` as Pi's native summary command. Do not override it or attempt to return `{ messages }` from `session_before_compact`.
- Automatic pruning is disabled by default for the first release. Explicitly enabled auto mode runs at an actionable `turn_end` boundary, starting with a configurable 60% context watermark borrowed from the reference, not a measured optimum.
- Add a cooldown/new-material gate, in-flight guard, and bounded requests. Do not classify every turn or request a continuation just to prune.
- Native threshold/overflow compaction remains enabled. On ineffective or failed pruning, leave the current context unchanged and let native compaction handle its normal pressure/recovery checks. A manual ineffective prune reports the outcome and directs the user to `/compact`; it does not secretly summarize.

### Pruning semantics and invariants
- Read the active projected context, including previous context edits; do not rescore raw entries excluded by a previous compaction or an abandoned branch.
- Pair tool calls/results by stable tool-call IDs and retain source entry IDs for edits.
- Keep user/assistant text, ordering, role, timestamps, model metadata, and raw history unchanged. Only remove eligible tool-call content blocks or replace/omit their associated result contributions in model context.
- Tool-call removal must not leave orphan results, unmatched calls, or empty invalid assistant messages. Multiple calls in one assistant message must be handled independently while preserving retained blocks.
- If omission leaves an assistant message with no valid content, omit that projected message; never reconstruct retained text/thinking from a flattened transcript.
- Structural pinning takes precedence over classifier scores: incomplete pairs, first user message, pairs touching the newest retained-message window (initial default 6), unsupported content, images, and groups whose provider reasoning/signature requirements cannot be preserved.
- Semantic safety pinning protects unresolved critical failures and non-reconstructible observations/irreversible side effects. Tool eligibility is not restricted to read-only tools, but a classifier probability alone is not evidence that repeating an action is safe.
- Truncation leaves bounded head/tail excerpts and an explicit omission marker. Do not advise rerunning a side-effecting tool; preserve an execution receipt where necessary or pin the pair.
- Apply edits through public boundary `context_edit` drafts, not direct JSONL writes or in-memory-only context filters. This makes edits append-only and branch-relative; raw transcript, UI history, exports, and original accounting remain available.
- Build and validate the entire edit proposal before committing any edits. Recheck session/branch identity and target content after asynchronous classification; stale or cancelled work must produce no edits.
- Preserve unrelated context edits and extension entries. Repeated pruning must be idempotent when there is no new eligible material.

### Decision input, limits, and privacy
- State includes current goal/recent user context, relevant user/assistant history, tool inputs/metadata, and bounded tool-output excerpts. Unlike the reference, do not judge output contents from length/status alone.
- Keep pinning local. Classifier answers cannot unpin protected pairs.
- Fit state deterministically before calling the API. Do not rely on server-side silent truncation. If necessary information cannot fit, retain affected pairs or skip the attempt.
- Batch under question count, estimated tokens, and request size constraints; use bounded concurrency and a shared deadline/abort signal. Repeated state costs count toward the attempt's budget.
- Remote decisions require explicit enablement. Document that user/assistant text, tool arguments, file paths, and excerpts can leave the machine; simple redaction is not a confidentiality guarantee.
- Use Pi-managed credentials/environment resolution. Do not store keys in repository config, logs, previews, or session audit entries.
- Treat transcript/tool content as untrusted data rather than instructions for the classifier's retention policy.

### Acceptance gate and observability
- Accept only valid proposals with meaningful estimated projected-token savings; default trial threshold 25%, configurable. Character reduction can be reported but must not stand in for token reduction.
- Estimate before/after using the same projected-context accounting. Do not mistake cumulative billed tokens or stale last-response usage for current context size.
- Report kept/truncated/dropped/pinned counts, estimated context reduction, classifier requests/tokens, elapsed time, and explicit skip/fallback reasons.
- Do not label unpriced classifier calls as free. Usage accounting integration must be verified against Pi's public API; report unknown cost as unknown.
- Store minimal branch-scoped audit state without raw excerpts, credentials, or prompts.

## Non-goals
- Replacing Pi's native summarization engine or changing the session file format.
- Editing user prompts or assistant prose, summarizing thinking, or switching the main chat model.
- Generic LLM-based classification, automatic cross-provider failover, or a new decision-model SDK.
- Live quality/latency/cost claims without measurements.
- Automatically installing globally or enabling remote auto-pruning merely by adding the file.

## Acceptance criteria
- Tests cover all three actions and pinning overriding classifier answers.
- Projection retains exact user/assistant text and valid tool-call/result relationships, including mixed text + multi-tool messages.
- Unsupported images/signatures, incomplete pairs, unsafe irreversible observations, and stale targets are retained/skipped safely.
- Raw history is unchanged; projected edits survive resume/reload and follow `/tree` and fork branches correctly.
- Timeout, abort, missing credentials/model, incomplete/malformed/out-of-range answers, request-budget overflow, and insufficient savings produce no pruning edits.
- Batches obey both provider limits and total attempt budget; no repeated no-op pruning loop.
- Direct TypeSafe Jev is default; fake TypeSafe Jev, OpenCode Jev (both catalog IDs), Clef, and generic classifier fixtures exercise the same provider-neutral contract without paid network calls.
- OpenCode tests cover exact provider/model lookup, missing credentials/model, and no silent switch to direct TypeSafe or to the free variant.
- Native `/compact` remains functional with this extension enabled.
- Installer and tests support the extension without accidentally auto-loading helper modules as independent extensions.
- Live smoke/quality evaluation requires separate approval and credentials, and is reported separately from mocked test results.

## Evidence
- Reference repository inspected at `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`: https://github.com/tamaratran/fast-jev-compaction
- `.zharness/cache/github/tamaratran/fast-jev-compaction/src/compact.ts:101-115`: two keep scores produce keep / drop_result / drop_call.
- `.zharness/cache/github/tamaratran/fast-jev-compaction/src/state.ts:145-169`: reference decision state replaces full outputs with status/length notes.
- `.zharness/cache/github/tamaratran/fast-jev-compaction/hooks/fast-jev.ts:260-290`: Claude-specific message replacement and built-in-summary fallback.
- Installed Pi 1.1.0 `docs/models.md`, `docs/codemode.md`, `docs/extensions.md`, `docs/session-format.md`, and `dist/core/extensions/types.d.ts`: native classifiers, typed bool questions, actionable boundaries, append-only context edits; compaction hook does not accept a replacement message list.
- Cloudflare canonical docs fetched during design: https://developers.cloudflare.com/workers-ai/models/clef/ and https://developers.cloudflare.com/workers-ai/models/clef-flash/ — 65,536 context tokens, 1–64 questions, System One-style request; long state may be truncated server-side.
- Installed Pi 1.1.0 `pi-ai/dist/providers/data/opencode.json`: `classifier:jev-1.13` and `classifier:jev-1.13-free`, provider `opencode`, API `typesafe-system-one`, base URL `https://opencode.ai/zen/v1`, context window 32,000; `docs/providers.md` identifies `OPENCODE_API_KEY`.
- `setup/install.sh` copies top-level `extensions/*.ts`; repo currently uses standalone `tests/test-*.mjs` with the installed Pi loader.

## Execution plan

### Approach
Keep the entry point in `extensions/decision-compact.ts`, with exported pure helpers in that same file for the existing Jiti-based tests. This avoids changing the installer's top-level file discovery or accidentally loading helper modules as separate extensions. Keep classifier calls, context transformation, boundary commit, and presentation separate inside the module.

Use `config/decision-compact.example.json` as documentation, not a live opt-in. Read extension-specific configuration from an explicitly documented user/project path, with strict validation and safe defaults (`allowRemoteDecisions: false`, `auto: false`). Project configuration may choose policy/model but must not silently relax user-level remote-data consent. Never run credential commands defined by this extension; defer authentication to Pi's model runtime.

Manual apply is a branch-scoped pending intent persisted as a `custom` entry via `pi.appendEntry()`. At the next eligible `turn_end`, read the boundary's projected context, classify fresh candidates, and return validated edit drafts plus a consumed-request/audit custom draft together. No saved preview is applied to a different context. Status distinguishes queued, skipped, proposed, and committed outcomes. Native `/compact` is never intercepted.

### Phase 1 — Prove public API integration (wave 1)
1. Add `tests/test-decision-compact.mjs` using the installed Pi/Jiti discovery pattern and `PI_NODE_MODULES` override.
2. Build a fake classifier runtime and boundary harness; use public `SessionManager.inMemory()` and projection helpers to check persistence/replay behavior.
3. Prove that `turn_end` returns grouped `context_edit` drafts, the command queues intent through `appendEntry`, and preview returns no editing drafts.
4. Verify exact `replacement: { content } | null` shapes, readonly session access, and availability of public token-estimation exports. Do not use a private `appendContextEdit()` cast on `ctx.sessionManager`.
5. Resolve usage accounting: public boundary drafts cannot append a `usage` entry. Report classifier tokens/cost separately in extension status/audit for MVP rather than falsifying native `/session` totals. Record this limitation in README.

Checks: harness rejects invalid targets/shapes; original message entries are unchanged; queued apply does not trigger a chat request; any unsupported API expectation fails before implementing the rest.

### Phase 2 — Implement deterministic pruning core (wave 2; after phase 1)
1. Add validated configuration, defaults, and backend limits. Model lookup is exact; no provider/model fallback.
2. Collect complete pairs from projected source entries; track message/block indices without flattening retained content.
3. Implement structural/semantic pinning, including recent pair endpoints, ambiguous duplicate IDs, images/signatures, pending calls, critical errors, and unsafe non-reconstructible effects. Document conservative behavior for unknown tools; do not infer side-effect safety from a tool name alone.
4. Build decision state with current task context and bounded call/result excerpts; pin or skip candidates when fitting would remove essential evidence.
5. Generate two typed bool questions per candidate; batch under request/attempt token estimates, bytes, question limits, and bounded concurrency.
6. Validate all answers, then generate keep/truncate/drop proposals. Merge per-assistant edits for multiple calls, preserve text/thinking/metadata, omit empty projected messages, and remove matched results together with removed calls.
7. Simulate the entire proposal using public projection helpers; validate call/result relationships and before/after estimates. Reject invalid or insufficient-reduction proposals before commit.

Checks: pure fixtures for all three actions, exact retained text, mixed multi-tool messages, boundary pinning, short results, previous edits, unknown content, malformed answers, batching/fitting limits, idempotence, and no mutation of fixture objects.

### Phase 3 — Wire runtime, commands, and automation (wave 3; after phase 2)
1. Implement `preview`, `apply`, `cancel`, and `status`, including clear remote-consent errors and command-only wait-for-idle behavior.
2. Execute classifier calls through `ctx.modelRegistry.classify()` with operation cancellation and a hard attempt deadline. Fake backends cover direct Jev, OpenCode's two Jev IDs, Clef/Flash, and one generic registered classifier.
3. Handle armed manual intents and explicitly enabled automatic pressure checks at `turn_end`; return drafts without forcing continuation. Keep auto off by default.
4. Revalidate active session/branch and target content immediately before proposing edits; cancel on session switch/tree/fork/reload/shutdown. Preserve existing boundary entries from other extensions when composing results.
5. Add cooldown/new-material gating and minimal branch-scoped audit data. Ensure failed/aborted/ineffective attempts cannot create editing drafts or repeated pruning loops.
6. Expose classifier usage separately and do not log transcript excerpts or keys. Notify outcomes only when the mode supports UI; commands/status remain usable outside TUI.

Checks: mocked end-to-end preview/apply/cancel, timeout/abort, missing auth/model, invalid probabilities, stale context/session, threshold crossings, multi-extension boundary composition, and zero extra chat turns. Assert no silent OpenCode-to-TypeSafe/free fallback.

### Phase 4 — Verify replay, packaging, and docs (wave 4; after phase 3)
1. Test grouped edits with real in-memory SessionManager projection, serialization/reopen fixtures, branch navigation, fork/resume, and native compaction entries before/after pruning.
2. Verify retained raw UI/export/accounting data stays untouched; model-visible messages remain provider-valid for supported content. Pin unverified provider cases rather than silently stripping signatures.
3. Add the example config and README instructions covering credentials, all supported IDs, remote data flow, queued apply semantics, auto opt-in, native fallback, cancellation, cost limitations, and uninstall.
4. Keep the installer unchanged if the single-file layout works; verify its dry-run finds the new extension without enabling remote decisions or overwriting live config.
5. Run the focused suite, every existing standalone test, available static diagnostics/type checks, `bash -n setup/install.sh`, and `git diff --check`. Add a dedicated typecheck command/script if repo-local static checking can be done without new application dependencies; loader tests alone are not static type checking.
6. Defer the quality gate to `check`. Report exact verifier commands, failures, and untested surfaces.

Checks: no live network requests in automated tests; no global installation or credential edits; all required local checks green before implementation is marked complete.

### Phase 5 — Optional authorized live validation (separate gate)
Only after approval to send context and usable credentials, load the extension explicitly in a disposable session, run preview, arm apply, and verify projection at the next boundary. Compare a native-compaction baseline and pruning on representative task transcripts. Record retention failures, extra rereads, classifier latency/tokens, cache effects, and total task cost. Do not promise speed/cost improvements from mocked tests or vendor latency claims. A live failure leaves this phase open and does not get relabeled as verified.

## Current State
- User approved the design, including OpenCode Jev, and the execution plan is ready.
- No implementation files, live configuration, keys, or installed global extensions have been changed.
- Important public-API clarification: idle `apply` arms next-boundary work; it does not immediately rewrite context.
- Classifier usage cannot be appended as native `usage` through the inspected public boundary API; MVP reports it separately.
- Next stage: `work`, starting with phase 1's public-API harness; run `check` after implementation.
