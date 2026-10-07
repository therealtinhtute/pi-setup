# Pi setup

My [Pi coding agent](https://pi.dev) configuration, versioned.

Bootstrap a new machine from this repo with one script. It installs the
extensions, the secret helper, and the config files, then tells you the few
things only a human can do (API keys, provider logins).

```bash
git clone https://github.com/therealtinhtute/pi-setup.git
cd pi-setup
bash setup/install.sh
```

Preview first if you like — nothing is written:

```bash
bash setup/install.sh --dry-run
```

## What gets installed

| From | To | Notes |
| :--- | :--- | :--- |
| `extensions/*.ts` | `~/.pi/agent/extensions/` | Gradient banner, compact statusline/tool calls, `$skill` autocomplete |
| `config/quotas.json` | `~/.pi/agent/extensions/` | Config for the `pi-quotas` package |
| `scripts/get-secret.sh` | `~/.pi/agent/scripts/` | Reads one key from `~/.env`; mode `700` |
| `config/advisor.json` | `~/.pi/agent/advisor.json` | Advisor model selection |
| `config/settings.json` | `~/.pi/agent/settings.json` | Installed only if absent — otherwise diffed |
| `config/web-search.example.json` | `~/.pi/agent/web-search.json` | Same rule; **this is an example, edit it** |

`install.sh` is idempotent. It copies a file only when the contents differ, and
backs up anything it overwrites to `<file>.backup.<timestamp>`.

Your live `settings.json` and `web-search.json` are **never clobbered** on a
re-run — the script prints a unified diff and leaves the decision to you. Pass
`--force` to overwrite anyway (a backup is still taken).

## The secrets pattern

Pi reads provider credentials from `process.env`. That breaks the moment you
edit a key while Pi is already running — the process keeps the environment it
was launched with, so you have to restart before a new key is visible.

This setup avoids that. `get-secret.sh` reads a key from `~/.env` on demand:

```sh
#!/bin/sh
# Usage: get-secret.sh KEY_NAME [ENV_FILE]
key="$1"
file="${2:-$HOME/.env}"
sed -n "s/^${key}=//p" "$file" | head -1 | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//'
```

Pi's web-access extension supports a **command credential source**: a config
value starting with `!` is run as a shell command, and its stdout becomes the
credential. So instead of a bare environment reference:

```json
"firecrawlApiKey": "$FIRECRAWL_API_KEY"
```

use the command form:

```json
"firecrawlApiKey": "!$HOME/.pi/agent/scripts/get-secret.sh FIRECRAWL_API_KEY"
```

| | `$ENV_VAR` | `!get-secret.sh KEY` |
| :--- | :--- | :--- |
| Restart needed after rotating a key | yes | no |
| Key present in `process.env` (visible to child processes) | yes | no |
| Works when Pi started before you added the key | no | yes |

Store keys in `~/.env`, one `KEY=value` per line, mode `600`:

```bash
chmod 600 ~/.env
```

```sh
FIRECRAWL_API_KEY=fc-xxxxxxxx
EXA_API_KEY=xxxxxxxx
TINYFISH_API_KEY=sk-tinyfish-xxxxxxxx
```

## Web search providers

`config/web-search.example.json` restricts search to **TinyFish first, Firecrawl
as fallback**. Both credentials use `get-secret.sh` to read `~/.env` on demand;
no keys are stored in the config. The existing fetch provider order is unchanged.

Search falls back only on transient, quota, network, or invalid-response errors.
An explicit provider request stays strict; it does not use the fallback route.
The search allowlist also rejects explicit requests for other providers.

For an existing installation, merge these fields into
`~/.pi/agent/web-search.json` (keep the rest of your config):

```json
{
  "webSearch": {
    "allowedProviders": ["tinyfish", "firecrawl"]
  },
  "searchRouting": {
    "providers": ["tinyfish", "firecrawl"],
    "fallbackOn": ["transient", "quota", "network", "invalid-response"]
  },
  "tinyfishApiKey": "!$HOME/.pi/agent/scripts/get-secret.sh TINYFISH_API_KEY",
  "firecrawlApiKey": "!$HOME/.pi/agent/scripts/get-secret.sh FIRECRAWL_API_KEY"
}
```

Remove top-level `provider` and `searchProvider` fields if present: they override
`searchRouting`. Run `/reload` after changing the config. The installer leaves
existing live config untouched unless you pass `--force`, which overwrites the
whole file rather than merging it.

Exporting keys inside Pi's bash tool does not update Pi's own environment. With
the command credential sources above, exports and restarts are not needed when
adding or rotating a key in `~/.env`.

Before enabling remote extraction, read these two fields:

**`firecrawlFreshScrape`** — `false` means Firecrawl operates cache-only
(`lockdown: true`): the Firecrawl server will not make fresh outbound requests
to target URLs. Only set `true` for a Firecrawl deployment whose own egress is
isolated or allowlisted. This extension can preflight URLs you submit, but it
cannot control what the Firecrawl server fetches.

**`fetchRouting.allowRemoteHostedProviders`** — remote `fetch_content` calls
skip third-party hosted providers unless this is `true`. Firecrawl is not in
that group, so Firecrawl search works either way; the flag only affects the
hosted *fetch* fallbacks (Jina, TinyFish, and friends). Set it to `false` if you
do not want fetched URLs handed to those services.

Add TinyFish and Firecrawl keys to `~/.env` for the default search route. Other
providers below are supported, but search providers outside the allowlist need
an explicit config change:

| Provider | Key | Role |
| :--- | :--- | :--- |
| Firecrawl | `FIRECRAWL_API_KEY` | Search + extraction fallback |
| Exa | `EXA_API_KEY` | Search |
| TinyFish | `TINYFISH_API_KEY` | Search + fetch |
| Brave | `BRAVE_API_KEY` | Search |
| Tavily | `TAVILY_API_KEY` | Search |

Config file: `~/.pi/agent/web-search.json`.

> Some networks get flagged by hosted scrapers, which then refuse keyless
> requests with HTTP 403. If that happens, a key is mandatory.

## Extensions

**`custom-banner.ts`** — replaces the default TUI header with a gradient
TINHTUTE banner. Centers and truncates using terminal display widths, with a
compact fallback on narrow terminals. Adds `/custom-header` and `/builtin-header`
to switch between headers at runtime.

**`custom-footer.ts`** — replaces the TUI footer with a compact, live statusline:

```text
 👾 Opus 5.5 · low · ──────── 12% · ϟ 2.4k tpm · ★ 85% · ⌥ main
```

Shows the current model in orange (palette 208) and thinking level in ANSI
magenta, matching the Claude Code statusline, plus context usage and Git branch
(omitted outside Git). Matching Claude Code's statusline thresholds, the entire
context segment is monochromatic: gray (`#9e9e9e`) below 50%, yellow (`#facc15`)
from 50%, and red (`#f87171`) from 75%.
Unknown context usage displays `?%` in gray.

The yellow `ϟ N tpm` segment shows the session-average input + output tokens per
minute, using all recorded session usage and wall-clock time since the session
header's creation timestamp. Cached read/write tokens are excluded. Idle time
and time between closing and resuming a session count in the denominator; this
is not output-only generation speed or Claude's own duration counter. The value
updates on redraw, without a timer. It is hidden when tokens or valid elapsed
time are unavailable, or the rate rounds down to zero. Formatting follows Claude:
`999`, `1.0k`, `10k`.

The `★` segment shows the latest assistant's
cache hit rate on the active branch: `cacheRead / (input + cacheRead + cacheWrite)`.
It is hidden until valid usage is available. Matching the Claude Code statusline,
the rate is truncated to a whole percent, and the entire `★ N%` segment is dim
when no tokens were read from cache, red below 70%, yellow from 70%, and green
from 90%. A known zero hit rate displays `★ 0%`.
Other colors follow the active theme and the line truncates to fit the terminal.
Adds `/custom-footer` and `/builtin-footer` to switch at
runtime. The compact footer hides the built-in cwd, usage/cost totals, and other
extension statuses; `/builtin-footer` restores them.

**`compact-tools.ts`** — displays each tool call as one truncated line by default:

```text
▸ read extensions/custom-footer.ts
▸ bash npm test
```

Adjacent collapsed tool calls sit back-to-back without blank lines. In fullscreen
mode, click the tool header after a result arrives to expand it;
click again to collapse it. `Ctrl+O` expands/collapses all tools and also works
in regular terminal mode. Expanded output uses one padded `Box` layout with a
neutral tint blended at 30% over Pi's reported terminal background (ANSI has no
actual alpha channel). Edge-aligned `▕`/`▏` sides and native ANSI overline
rules on spaces meet the filled interior without tinting the border cells.
The heading stays unshaded and merges tool details (such as `read` line ranges)
to avoid duplicate title rows. Headings and border cells keep the terminal
background, so the tint stays inside the frame. Native background layers are
flattened into this one surface; foreground syntax/diff colors remain
unchanged. Collapsed and result-less calls keep the terminal background.
Expanded calls reuse the original built-in or plugin renderers, including edit
diffs and write contents. Unknown tools fall back to
plain arguments/output. Collapsed errors are marked, and streaming calls remain
compact. This changes presentation only, not tool execution or model-visible
results. Pi's native inline image panels are outside the renderer and can still
appear when image display is enabled. Disable this extension through `pi config`
and `/reload` to restore the normal preview layout.

**`code-block.ts`** — gives assistant code fences and expanded `read`, `bash`,
`write`, and `edit` output an edge-aligned frame with language, status, and copy
action on the top stroke, with a subtle 15% interior tint and no outer tinting.
No line numbers are added; edit diffs also omit Pi's line-number gutter while
keeping change markers and colors. File paths are hidden in code-block headers
by default (the tool summary still shows its arguments).

- Click `[Copy]` in fullscreen mode, or use `/code-copy` to select a block from
  the current session branch with the keyboard. Copy excludes the frame and
  preserves source tabs. Edit copy returns a number-free diff with `+`/`-` markers.
- Run `/codeblock-path on` or `/codeblock-path off` for the current session.
  Start Pi with `--code-block-path` to show paths from startup.
- Assistant headers only show a path explicitly supplied as `path=...` in the
  fence info; they do not infer filenames from code.

Tool rendering uses the public extension API through `compact-tools.ts`.
Assistant rendering needs a guarded adapter for Pi 1.0.4's internal Markdown
renderer because Pi has no public code-block component hook. Unknown renderer
shapes keep native message rendering and show a warning. Nested list/blockquote
fences, user messages, and thinking blocks retain native rendering. Mermaid
continues through Pi's own Markdown transformer. The adapter is TUI-only and
restores the original methods on reload/shutdown. Very narrow panels omit the
frame/copy action; `/code-copy` remains available. Disable `code-block.ts` and
reload to restore native code presentation.

**`dollar-skill.ts`** — types `$skill-name` and rewrites it to
`/skill:skill-name` on submit, plus `$`-triggered autocomplete over installed
skills. Also supports multi-skill pipeline chains such as `$think -> $work`
or `$think ➔ $work`, combining stages sequentially into a single pipeline prompt.

**`skill-highlight-editor.ts`** — draws known `/skill:<name>` invocations as bold
teal `💡 name` chips on `customMessageBg`, after the stock editor lays out the
prompt. The submitted text is unchanged. Four unpainted spaces preserve each
canonical token's original footprint, so following text and the caret keep their
columns. While editing inside a token (including its first character), it stays
literal and highlighted. `$<name>` aliases stay literal because the bulb chip
would be wider than the alias. Names resolve against the real skill registry;
unknown names are not painted.

The same editor replaces Pi's simulated block cursor with a **steady vertical
beam** using the terminal's native cursor (DECSCUSR). It preserves Pi's zero-width
cursor marker and lets the TUI handle placement and focus, including IME and
fullscreen/regular mode. A focused editor renews native cursor visibility if
Pi reapplies persisted settings after `/reload`; an inactive or released editor
does not. No settings file or upstream Pi patch is needed. On reload/exit it
restores the prior hardware-cursor visibility and requests the
terminal's default cursor shape. If the runtime APIs are unavailable, it keeps
the stock block. The terminal must support DECSCUSR to display the beam.

This replaces the editor component and passes `embedWorkingStatus` through to
keep the working indicator in the editor's top border. Highlighting failures
fall back to the stock text; cursor handling works independently of the theme.
Tests verify row geometry, cursor cells, focus and cleanup against real Pi TUI
classes. Wrapped tokens without a complete match stay literal.

**`skill-invoke-chip.ts`** — shows a skill invocation banner above the editor
whenever the prompt holds a skill invocation:

```text
💡 git · check · think +2 | SWE-2 · max
```

A teal `💡` invocation marker, skill names in the label colour capped at three
with a `+N` overflow, then a dim `|` and the live session state (model ·
thinking level, falling back to the configured defaults). Everything sits on the
`customMessageBg` surface Pi already gives the `[skill]` block, so the inline
prompt and the transcript read as one idea rather than two visual languages.

This is the public-API companion to `skill-highlight-editor.ts`. It cannot paint
inline text, but it replaces no editor and does no ANSI work, so it keeps working
regardless of how the editor is implemented. It recognises both `/skill:<name>`
and the `$<name>` alias, and only rewrites the widget when the chip actually
changes — widget writes re-render the transcript. Use either extension or both;
they do not conflict.

**`skill-transcript-badge.ts`** — transforms Pi's bulky stock `[skill]` message box
into a sleek, 1-line flat divider strip when collapsed and a framed structured card
when expanded:

```text
── ⚡ Skill: 💡 think ────── 3.8k tokens · 142 lines · ~/.agents/skills/think/SKILL.md  [▾ expand] ──
```

When collapsed, removes top/bottom padding to occupy a single terminal row, displaying
a flat divider bar on a subtle `customMessageBg` background that contrasts gently
with the conversation surface (without bulky corner brackets). When expanded with mouse
click or `Ctrl+O`, encloses the skill content into a framed card with location metadata,
clean syntax-colored instruction body, and rounded border framing. Multi-skill pipelines
render as `── ⚡ Pipeline: 💡 think ➔ work ──`.

All eight are plain TypeScript and are loaded directly from
`~/.pi/agent/extensions/`. The header, footer, and initial tool-folding state
activate automatically in TUI mode; no extra package or installer change is needed.

### Verify the statusline

With Pi installed, run from the repository root:

```bash
node tests/test-custom-footer.mjs
node tests/test-compact-tools.mjs
node tests/test-code-block.mjs
node tests/test-skill-highlight.mjs
node tests/test-skill-invoke-chip.mjs
node tests/test-skill-transcript-badge.mjs
```

Verify the search and package templates without credentials or network calls:

```bash
node tests/test-web-search-config.mjs
node tests/test-package-selection.mjs
```

For npm or other install layouts, set `PI_NODE_MODULES` to the directory
containing Pi's installed dependencies. Tests cover light/dark themes, context
and cache thresholds, hidden unknown cache usage, session TPM and formatting,
narrow terminals, emoji/Unicode, live updates, commands, and subscription cleanup.
After installing, run `/reload` in Pi to check both components visually.

## Packages

`config/settings.json` lists the Pi packages this setup expects. Trim the list
to what you actually use; Pi resolves configured packages on startup.

### Devin provider

- `npm:pi-devin-local`: registers Devin as a native Pi provider while the
  local Devin CLI owns authentication and the live model catalog. Pi remains
  the agent harness for tools, sessions, and UI.
- Install the Devin CLI first (`curl -fsSL https://cli.devin.ai/install.sh | bash`),
  sign in with `devin auth login`, then run `/reload` and `/login devin` inside Pi.
- Do not install `git:github.com/ttttmr/pi-devin-oauth` at the same time: both
  packages register the `devin` provider. The template keeps `pi-devin-local`
  for CLI authentication and the live catalog. Version 0.3.0 still sends a
  fixed Desktop client identity; see the compatibility fix below.
- `defaultProvider`/`defaultModel` select `devin/deepseek-v4.1-flash`; change
  them if this machine should start on another provider.
- `config/advisor.json` uses `devin/deepseek-v4.1-flash` and `devin/swe-2`,
  matching the family slugs reported by `devin models list`.

#### Temporary client identity fix (pi-devin-local 0.3.0)

If Pi reports “Your Windsurf version is out of date” while the native Devin CLI
gets past that check, run:

```bash
node scripts/patch-devin-client.mjs --dry-run
node scripts/patch-devin-client.mjs
node scripts/patch-devin-client.mjs --check
```

The script targets `~/.pi/agent/npm/node_modules/pi-devin-local` (or
`PI_CODING_AGENT_DIR`; `--package-dir` overrides the whole package path). It
accepts only the exact published 0.3.0 metadata source, backs it up as
`src/metadata.ts.pi-setup-backup`, and changes only client metadata. The fix
uses the observed Devin CLI 3000.11.3 chat identity: `devin-cli`, version
`3000.11.3`, and `chisel` in the extension identity fields. It does not read
credentials or change authentication, models, tools, or quotas. The version
is a verified default, **not** automatic CLI-version discovery;
`DEVIN_CLIENT_VERSION` can override it with a `major.minor.patch` value.
`--check` verifies the local patch, **not** the live server's version gate. If
the gate changes again, compare native CLI **GetChatMessage** metadata fields
1, 2, 7, 12 and 28; catalog/status RPCs can use different identities. Capture
only those identity fields, never credentials, JWTs or complete request bodies.
This is an unofficial compatibility workaround, not an upstream-supported
integration; check your provider's terms before applying.

Restart Pi or run `/reload`. Bootstrap only copies the script and prints this
manual step; it does not patch packages automatically. Reapply after package
updates/reinstalls if the original 0.3.0 source returns. Newer or modified
sources are refused and need review, not a forced patch. To roll back, copy
`src/metadata.ts.pi-setup-backup` over `src/metadata.ts`, then reload.

Regression check: `node tests/test-devin-client.mjs`. On this account, SWE-2
returned `OK` after the patch; DeepSeek and Sol passed the version gate but
reported daily quota exhaustion. That remaining quota error is not fixed by
changing client metadata.

### Browser executable

The shared template leaves `pi-browser-use.executablePath` unset. The extension
uses `CHROME_PATH` when it points to an existing file, then checks standard
Chrome/Chromium locations for the current OS. Install Chrome separately; this
bootstrap does not install a browser.

If your live `~/.pi/agent/settings.json` still contains the old macOS Brave path,
back up that file and remove only `pi-browser-use.executablePath`, preserving
other browser settings. An explicit path takes precedence over discovery and
fails if the file is missing. Keep a Brave or other custom-browser path only in
your machine-local settings, not in the shared template. Re-running the installer
without `--force` does not migrate existing settings; do not use `--force` just
for this change. Restart Pi or run `/reload` after editing.

### Smart-fetch dependency warning

`pi-smart-fetch@0.3.17` declares `@earendil-works/pi-tui` and
`@sinclair/typebox` as runtime dependencies, although Pi supplies these modules.
Pi reports this as a package warning, separate from browser startup failures.

Until an upstream release fixes the manifest, a temporary local workaround is
to back up `<agent-dir>/npm/node_modules/pi-smart-fetch/package.json`, remove
only those two entries from `dependencies`, and add them to `peerDependencies`
with `"*"` ranges. Preserve the other dependencies and package fields. Do not
delete shared `node_modules` or patch Pi's extension loader. This bootstrap does
not apply the workaround automatically.

Restart Pi or run `/reload`, confirm the warning is absent and `web_fetch` still
works. The manifest change alone does not prove module-instance identity.
Package updates/reinstalls can overwrite this local workaround; recheck the
installed manifest afterward. Restore the backed-up manifest to roll it back.

### Diff review and LSP

- `npm:pi-diff-review@0.1.27`: `/diff`, `/diff --cached`, `/diff main...HEAD`,
  and `/view` for inline review comments.
- `npm:pi-lsp-extension@1.4.0`: `/lsp` and language-intelligence tools.
  Install the language server separately, for example `typescript-language-server`
  plus `typescript` for JS/TS, or `jdtls` for Java. Without a server, supported
  tools can fall back to tree-sitter syntax analysis; that is not type checking.

These versions are pinned to the releases tested with Pi 1.0.4.

### Selected mitsupi resources

The npm release checked during setup did not contain `goal.ts`, `subagent.ts`,
or all three themes. This template uses the GitHub source pinned to a tested
commit, with resource filters rather than enabling the whole bundle:

```json
{
  "source": "git:github.com/mitsuhiko/agent-stuff@0865c849befd2021490679f96a8dee58c84ac857",
  "extensions": [
    "extensions/btw.ts",
    "extensions/session-breakdown.ts",
    "extensions/goal.ts",
    "extensions/subagent.ts"
  ],
  "skills": ["skills/librarian", "skills/summarize"],
  "themes": [
    "themes/dayowl.json",
    "themes/modern-dark.json",
    "themes/nightowl.json"
  ],
  "prompts": []
}
```

- `/btw`: side-chat popover for tangential questions.
- `/session-breakdown`: session usage, model, and cost analysis.
- `/goal`: long-running objectives; use it explicitly rather than starting a
  goal for every ordinary task.
- `subagent` tool: one observable child Pi session at a time, backed by `tmux`.
  Install `tmux` separately. The two legacy npm subagent packages are removed
  from this template to avoid duplicate `subagent` registrations.
- `/skill:librarian`: reusable remote repository checkouts.
- `/skill:summarize`: document/URL-to-Markdown conversion through `uvx markitdown`.
  Install `uv` separately. Its optional AI summary wrapper defaults to
  `claude-haiku-4-5`, which needs an available model/account.
- `dayowl`, `modern-dark`, `nightowl`: choose one in `/settings`. Merely installing
  them leaves the current `system` theme unchanged.

All other mitsupi extensions, skills, and prompt templates are excluded. In
particular, this selection does not enable its tool replacements or auto-trust
extension. Review third-party package source before installing it.

For an existing installation, merge the package entries from the template into
`~/.pi/agent/settings.json`, remove any legacy subagent packages, and run `/reload`.
Do not run the installer with `--force` unless you intend to replace the whole
settings file. Updating pinned packages requires deliberately changing their
version or commit.

## Layout

```
pi-setup/
├── config/
│   ├── advisor.json
│   ├── quotas.json
│   ├── settings.json
│   └── web-search.example.json
├── extensions/
│   ├── code-block.ts
│   ├── compact-tools.ts
│   ├── custom-banner.ts
│   ├── custom-footer.ts
│   ├── dollar-skill.ts
│   ├── skill-highlight-editor.ts
│   └── skill-invoke-chip.ts
├── scripts/
│   └── get-secret.sh
├── setup/
│   └── install.sh
└── tests/
    ├── test-code-block.mjs
    ├── test-compact-tools.mjs
    ├── test-custom-footer.mjs
    ├── test-package-selection.mjs
    ├── test-skill-highlight.mjs
    ├── test-skill-invoke-chip.mjs
    └── test-web-search-config.mjs
```

## Manual steps after install

1. Write your keys to `~/.env` and `chmod 600 ~/.env`.
2. Restart Pi so it picks up the new settings.
3. Authenticate the model providers you use (`/login`, or the provider's own flow).
4. For an existing config, merge the TinyFish/Firecrawl route above and run
   `/reload`. Adjust the search allowlist and route if you use other providers.

## Not in this repo

Skills live in a separate tree (`~/.agents/skills`, symlinked into
`~/.pi/agent/skills`) and are mostly third-party installs. Neither is versioned
here. Sessions, caches, the browser profile, `auth.json`, `antigravity-accounts.json`,
and `models-store.json` are machine-local state and are gitignored.

## Uninstall

Remove what was installed:

```bash
rm ~/.pi/agent/extensions/code-block.ts
rm ~/.pi/agent/extensions/compact-tools.ts
rm ~/.pi/agent/extensions/custom-banner.ts
rm ~/.pi/agent/extensions/custom-footer.ts
rm ~/.pi/agent/extensions/dollar-skill.ts
rm ~/.pi/agent/extensions/skill-highlight-editor.ts
rm ~/.pi/agent/extensions/skill-invoke-chip.ts
rm ~/.pi/agent/scripts/get-secret.sh
rm ~/.pi/agent/advisor.json
```

Then restore any `*.backup.<timestamp>` file you want back.

---

from therealTINHTUTE with love
