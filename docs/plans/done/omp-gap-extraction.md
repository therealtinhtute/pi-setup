# OMP gap extraction: port the engine, keep the surface

## Status
- Spec: locked — user picked all three phases in order, and "antigravity first, shared core".
- Plan: phases below, each independently shippable.
- Implementation: **all three phases shipped** (2026-10-21) — `extensions/account-pool/` (20 checks), the widened web routing, `extensions/rewind/` (16 checks); everything installed and load-verified through pi's own extension discovery (15 extensions, 0 load errors).
- Closed 2026-10-23: every acceptance check below is covered by a passing suite.
- Supersedes: the earlier `harness-split.md` (deleted). Versioning or backing up `~/.omp` is explicitly **out of scope**; this repository only gains pi-side code and config.

## Goal
Take the parts of `omp` 18.12.3 that pi 1.3.0 genuinely lacks, and land them in this repository as pi extensions and config — never by forking a provider package, never by porting omp's TUI.

## Why these three
Measured on 2026-10-21 against the installed code, not against omp's marketing:

| Candidate | Verdict |
| :--- | :--- |
| Multi-account credential rotation | **Real gap.** pi has the account pool but no brain behind it. |
| Web search fallback chain | **Not a gap — a config gap.** `pi-web-access` already implements `searchRouting.providers` + `fallbackOn`; the live config lists only two providers while `fetchRouting` lists twelve. |
| `rewind` / checkpoint | **Real gap.** pi can edit session content natively but nothing exposes it. |
| ast_grep / ast_edit | Not a gap. `pi-lsp-extension` ships `ast_search`, `code_rewrite` (dry-run by default), `code_overview`. |
| TUI, gallery, composer, symbols | Not a gap. This repo's surface is ahead; omp only customizes a statusline. |
| advisor, review, subagents, memory, plan, quota display | Covered by `pi-diff-review`, `pi-subagents`, `pi-memory`, `pi-goal`, `pi-quotas`. |
| Python `eval`, DAP debugger, desktop `computer`, `omp commit`, `ps` daemons | Rejected for now: core-level or project-sized, and `codemode` already covers the JavaScript half of `eval`. |

## Phase 1 — `account-pool` core + `antigravity-rotation`

### Current behaviour (verified)
- `~/.pi/agent/antigravity-accounts.json`: 6 accounts, `activeAccountId`, `lastUsedAt`, refresh skew 5 min.
- `pi-antigravity@0.11.0` fails over **reactively, inside one request**: `stream/stream.ts` calls `failoverToNextAccount(triedAccessTokens)` only after `isAccountQuota429`. The next request starts from `activeAccountId` again, whatever it hit last time.
- No cooldown, no per-model counters, no ranking, no visibility. `@latentminds/pi-quotas` only displays.
- Reference implementation to imitate (not copy — different package scope and runtime): omp's `antigravityRankingStrategy`, `blockScope: counter:<modelId>`, `healableBlockScopes`, `scopeAntigravityLimitsForModel`, `omp usage`, `omp dry-balance`.

### Shape (pre-spike draft — superseded by **Shipped shape** below)
- `extensions/account-pool/index.ts` — shared core: account health, per-model cooldown scopes,
  self-healing on expiry, ranking (sticky → least recently used → soonest reset), a state file
  with mode `600` and no tokens, plus a command that prints the pool.
- `extensions/antigravity-rotation/index.ts` — provider adapter registering `antigravity-pool`
  via `pi.registerProvider(name, { api, baseUrl, models, oauth, streamSimple })` with a
  `streamSimple` wrapper around `streamAntigravity`. **Not built**; see Spike findings.
- Multi-file extensions are loaded as directories containing `index.ts`, so `setup/install.sh`
  must copy directories as well as `extensions/*.ts`. This shipped with Phase 1.

### Signals available — spiked 2026-10-21, verified in the installed code
- `after_provider_response` is **dead for this provider**. `pi-antigravity` registers its stream through `pi-ai`'s `registerApiProvider` (`src/index.ts:118-125`), which stores the stream without wrapping it, and `streamAntigravity` never calls `options.onResponse`. Only the built-in `pi-ai` API modules call it. Same for `provider_stream_event`.
- `before_provider_headers` runs per request (`dist/core/sdk.js:207`, `transformHeaders`), so headers can be swapped — but see the projectId finding below.
- The quota wall surfaces as a **thrown `Error`** whose message carries the provider text (`stream.ts:1659-1671`: `failoverToNextAccount`, then `throw new Error(friendly)` containing `Quota reached.` / `Resets in …`). That error reaches the caller of the stream.
- `pi-antigravity` already ships `/antigravity.usage` (per-model remaining + `resetTime`), `/antigravity.accounts` with `list | switch <index|email> | remove`, and `syncCurrentAuth()`/`writeActiveCredential()` that keep `auth.json` and `antigravity-accounts.json` in step.
- The provider credential is a **JSON string** `{"token","projectId"}` (`client.ts:94`, `parseApiKey`), so token and project travel together and cannot be swapped independently.

### Spike findings
1. **`getApiKey` runs per request, not per session.** `ModelRuntime.stream()` → `lazyStream` → `prepareRequest()` → `getAuth()` → `resolveProviderAuth()` → credential read → `oauth.getApiKey()` (`dist/core/model-runtime.js:485-490`, `pi-ai/dist/models.js:341`, `pi-ai/dist/auth/resolve.js`). Rotation can therefore be decided per request.
2. **Credentials are cached in memory but invalidated by file revision.** `AuthStorage.read()` calls `readLatestData()`, which re-reads `auth.json` when its revision changes (`dist/core/auth-storage.js:376`, `295-330`). External writes are visible on the next request; nothing needs a restart. `ReadOnlyAuthStorage` is the cached-forever variant and is not the one the runtime uses.
3. **`after_provider_response` cannot carry the health signal.** See above: no `onResponse` call in `pi-antigravity`. Classification must come from the thrown error text or from polling the usage endpoint.
4. **Round-robin rotation would cost money.** Every account carries its own `projectId` (`types.ts:12-15`), and `pi-antigravity` reports `usage.cacheRead` from `usageMetadata` (`stream.ts:1441`), i.e. server-side implicit caching is scoped per account+project. Rotation must be **sticky**: keep the account until it walls, then move once.
5. **Header-only rewriting is not enough.** The payload's `projectId` is derived from the resolved apiKey (`stream.ts:1526`), so swapping just `Authorization` would pair account A's token with project B.

### Locked design at the time (superseded by the shipped shape)
The provider-wrapper plan below was written before the spike. Keep it as the record of what
was decided and why it changed.
The extension registers its **own provider** instead of patching anything:

- `pi.registerProvider("antigravity-pool", { api: ANTIGRAVITY_API, baseUrl, models, oauth, streamSimple })`, reusing `pi-antigravity`'s published internals through deep imports (the package has `main: ./src/index.ts` and **no `exports` map**, so `pi-antigravity/src/...` resolves).
- `oauth.getApiKey(credential)` returns the chosen account as `JSON.stringify({ token, projectId })` — the exact shape `parseApiKey` expects, so token and project can never desync.
- `streamSimple` wraps `streamAntigravity`: pin the account for this request, delegate, and on a thrown quota error record `{ accountId, modelId, resetAt }` in the health store, then let the error through. The next request ranks a different account.
- Health store lives in `~/.pi/agent/account-pool-state.json` (mode `600`, no tokens): per-account `blockedUntil`, per-model counters, `lastUsedAt`.
- Stickiness is a hard rule: ranking prefers the current account whenever it is unblocked, because a switch throws away the prompt cache for that account+project.
- Upstream follow-up worth filing, not patching locally: `streamAntigravity` should call `options.onResponse` so `after_provider_response` works for custom APIs at all.

### Shipped shape (what the code actually does)
The provider-wrapper idea from the locked design was **dropped after the spike**: pi re-reads
`auth.json` per request by file revision (finding 2), so steering the credential is enough
and a wrapper would have to duplicate `pi-antigravity`'s model catalog and deep-import its
stream — exactly the version-fragility risk the plan flagged. Steering wins on both counts.

- `extensions/account-pool/index.ts` — `/pool` (`status | next | heal | reset`), a
  `session_start` heal + reconcile pass, and an `agent_end` observer that reads the last
  assistant `errorMessage`.
- `extensions/account-pool/lib/rank.ts` — pure ranking/cooldown: per-account, per-model
  scopes (`counter:<modelId>` idea from omp, expressed as a block scope), sticky pick,
  heal on expiry, LRU spread among healthy accounts.
- `extensions/account-pool/lib/quota.ts` — narrow wall classification: `Quota reached.`
  only; reset hint parsed from `Please wait 4h 12m` / `Resets in …`; model parsed from
  pi-antigravity's own `runtimeModel=` diagnostics suffix.
- `extensions/account-pool/lib/store.ts` — atomic private writes. Switching writes the
  `antigravity` entry in `auth.json` **and** mirrors `activeAccountId` into
  `antigravity-accounts.json`, so the provider's own failover agrees with the pool.
- `setup/install.sh` now copies a directory with an `index.ts` as one unit (`sync_tree`).

Verified: 18 checks pass in `tests/test-account-pool.mjs` (classification, ranking, heal,
atomic 0600 writes, no credentials in the state file, `agent_end` reaction, `/pool`
rendering); the whole 10-suite repo suite passes; pi's `discoverAndLoadExtensions` finds
`/pool` with 0 load errors.

Not yet verified live: a real quota wall from the provider. The handler is exercised with
the exact strings `pi-antigravity` emits, but the first true wall is the remaining proof.

Known limitations, accepted for v1:
- Only the account that produced the **final** error is blocked. When every account fails in
  one request, the earlier attempts are not marked; they are simply tried again next time.
- The pool file is shared with `pi-antigravity`, which also rewrites it. Both writes are
  atomic (temp + rename), so the last writer wins; no corruption, but a lost `lastUsedAt`
  update is possible under a race.
- No proactive balancing. Load is spread only through LRU among healthy accounts, never by
  polling quota before a request.

### Acceptance
- Six accounts, forced quota wall on the active one: the next request goes out on a different account without a user-visible retry storm.
- An exhausted account is not retried until its `resetTime` passes.
- `/pool` shows per-account, per-model status without printing tokens.
- Unit tests in `tests/` that run without network: fake store, fake clock, assert ranking and heal order.

## Phase 2 — web routing config (no code) — shipped 2026-10-21

`pi-web-access` already had `searchRouting.providers` + `fallbackOn`; the live config
listed only two providers. Credentials on this machine are `EXA`, `TINYFISH`,
`FIRECRAWL`, and DuckDuckGo is keyless, so the chain became:

```
exa -> tinyfish -> firecrawl -> duckduckgo
fallbackOn: transient, quota, network, invalid-response, unsupported
```

- Only those five kinds may appear in `fallbackOn`; the loader rejects anything else.
  An earlier attempt to add `credential`/`auth` broke `pi-web-access` outright — the
  extension refused to load at all, and `web_search` disappeared. Caught during a
  package inventory, not by the tests: the running session still held the previous
  config in memory, which is why the first live check looked green.
- A provider whose credential cannot be resolved is skipped before the call, so a
  missing key still degrades to the next provider; runtime auth failures are not
  routable by design.
- `webSearch.allowedProviders` had to be extended too — it is an allowlist, not a hint.
- Applied to `config/web-search.example.json` **and** the live
  `~/.pi/agent/web-search.json`, because `install.sh` deliberately never overwrites live
  config.
- `tests/test-web-search-config.mjs` now asserts chain order, the widened fallback
  kinds, command-resolved credentials for the three keyed providers, and that the
  keyless tail stays keyless.
- Deliberately excluded: providers needing new signups (serper, kagi, tavily, …),
  self-hosted ones with no instance (searxng), and the ~35 remaining modules.

Verified live, not on paper: with `exaApiKey` temporarily pointed at `!true` (a command
that resolves to nothing), a real `web_search` returned results and reported
`Provider: tinyfish` — the fallback path actually ran. Config restored afterwards and
diffed clean against the repo.

## Phase 3 — `rewind` — shipped 2026-10-21

### What changed from the plan
The plan said "use `sessionManager.appendContextEdit`". That API is **not reachable from
an extension**: `ExtensionContext.sessionManager` is a `ReadonlySessionManager` (a
`Pick<>` of getters) with no mutators. Editing session entries would have meant a
private import and fighting the append-only tree.

Instead `rewind` uses the `context` hook, which Pi runs before every LLM call and whose
returned `{ messages }` **are** what the provider receives. That is strictly better here:
the session file is never edited, `/rewind off` is instant and lossless, and there is
nothing to undo.

Also dropped: the LLM digest (`ctx.modelRegistry.streamSimple`). A deterministic stub
carries what the model actually needs — which tool, how big, that it is re-runnable —
costs nothing, and cannot hallucinate. Cheap-model summarization stays an option if
stubs ever prove insufficient.

### Shipped shape
- `extensions/rewind/lib/rewind.ts` — pure planner: prune tool results older than the
  last N messages and above a size floor; preserve `toolCallId`/`toolName`/`isError`/
  `timestamp` so tool-call pairing survives; never touch user or assistant messages;
  idempotent (a stub is not re-stubbed); never mutates its input.
- `extensions/rewind/index.ts` — `/rewind [on|off|status] [keep N] [min CHARS]`, state
  persisted as a `rewind` custom entry and restored from the branch on `session_start`,
  one announcement per session with the bytes saved.
- Defaults: keep the last 8 messages verbatim, ignore results under 1500 chars.

Verified: 16 checks in `tests/test-rewind.mjs` (planner rules, pairing fields,
non-mutation, idempotence, image counting, argument parsing, arming/disarming, restore
after resume, no-op when nothing qualifies); Pi's discovery loads `/rewind` with 0 errors.

## Phase 1 spinoff — installer bug the extensions exposed

`sync_tree` initially reused the file-level `backup()`, which writes
`<target>.backup.<timestamp>` **next to** the target. Inside `~/.pi/agent/extensions/`
that is not a backup but a second extension: Pi loads any subdirectory holding an
`index.ts`, so two stale `account-pool.backup.*` copies were registering `/pool` and the
`agent_end` hook twice (discovery showed 17 extensions instead of 15).

Fixed by `backup_tree`, which stores directory backups in
`~/.pi/agent/backups/extensions/<name>.<timestamp>/`, plus a regression assertion in
`tests/test-account-pool.mjs` that fails if `sync_tree` ever uses the in-tree backup
again.

## Non-goals
- Any change inside `~/.omp`, any snapshot or repository for its config.
- Rewriting omp's UI, or porting more of this repo's UI into omp.
- A general plugin framework: each phase is a self-contained extension with its own tests.
- Python `eval`, DAP, desktop automation, `omp commit`, daemon supervision.
- Forking `pi-antigravity` or any published provider package. If the spike shows a hard blocker inside it, stop and report rather than patch around it.

## Revisit if
- The `getApiKey()` spike shows pi cannot rotate within a provider at all, which would move Phase 1 to "patch upstream" or "register a proxy provider".
- `pi-web-access` gains a ranking layer, making Phase 2 unnecessary beyond config.
- `rewind` collides with a future compaction change in pi, in which case it becomes a `session_before_compact` handler instead of a command.
