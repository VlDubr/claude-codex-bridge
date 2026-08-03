# Claude Codex Bridge — development guide

[Русский](README_DEV.md) · **English**

User documentation lives in [README.en.md](README.en.md). This file covers only what you need to work on the plugin itself: architecture, internals, tests, publishing.

---

## Architecture

The plugin implements neither OAuth nor HTTP clients to any model. All communication with GPT goes through the local `codex` CLI; all communication with Claude from the reverse direction goes through `claude -p`. That's deliberate: tokens stay in the stores the official tools put them in, and the plugin never becomes one more place someone else's secret can leak from.

Three channels:

| Channel | Mechanism | Declared in |
|---|---|---|
| Claude → GPT | MCP server `codex` | `.mcp.json` |
| Claude → images | MCP server `image` | `.mcp.json` |
| GPT → Claude | MCP server `claude-bridge` | `~/.codex/config.toml` |

No external dependencies. Both MCP servers and the MCP client implement JSON-RPC over stdio using only the Node standard library.

## Layout

```
claude-codex-bridge/
├── .claude-plugin/
│   ├── plugin.json          manifest, userConfig, defaultEnabled: false
│   └── marketplace.json     single-plugin catalog, source: "."
├── .mcp.json                registers the codex and image servers
├── commands/                11 slash commands (prompt templates)
├── agents/                  gpt-delegate, gpt-advisor, image-smith
├── hooks/hooks.json         SessionStart → preflight
├── scripts/
│   ├── mcp-lib.mjs          MCP transport (server side): JSON-RPC over stdio
│   ├── codex-core.mjs       codex exec wrapper, capabilities, job manager
│   ├── mcp-codex.mjs        MCP server, Claude → GPT
│   ├── models.mjs           model catalog: query Codex, cache, validate
│   ├── image-core.mjs       generation via the built-in image_gen tool
│   ├── mcp-image.mjs        MCP server for image generation
│   ├── link-back.mjs        safe editing of ~/.codex/config.toml
│   ├── setup.mjs            diagnostics, allowlist, link-back
│   └── preflight.mjs        SessionStart hook, bridge path self-healing
├── bridge/
│   ├── mcp-claude.mjs       MCP server, GPT → Claude
│   ├── mcp-client.mjs       MCP client for connecting to Claude's servers
│   └── tool-proxy.mjs       allowlist, server discovery, re-export
└── tests/regressions.mjs    27 regression tests
```

---

### Three different names

They're easy to confuse, and they do different things:

| What | Value | What it affects |
|---|---|---|
| Repository | `claude-codex-bridge` | `/plugin marketplace add VlDubr/claude-codex-bridge` |
| Marketplace (`marketplace.json` → `name`) | `claude-codex-bridge` | the right-hand side of `codex-bridge@claude-codex-bridge` |
| Plugin (`plugin.json` → `name`) | `codex-bridge` | **the slash command and subagent prefix**: `/codex-bridge:review`, `@codex-bridge:gpt-advisor` |

The prefix is never optional: even when a command's name matches the plugin's, the invocation is still `/plugin:command`. So the plugin name stays short — it appears in every single command. Renaming `plugin.json` → `name` changes every command at once and breaks users' muscle memory, so only do it alongside a major version bump.

---

## Internals

### Detecting `codex exec` flags

The flag set changed across Codex versions: `--ask-for-approval` is absent in some builds and triggers `unexpected argument`. So flags are never guessed — `capabilities()` in `codex-core.mjs` reads `codex exec --help` once, parses which flags exist, and caches the result next to the plugin data, keyed by binary version.

All command-line assembly is confined to `buildArgs()`. If a launch fails on arguments, that's the only place to fix.

### Background job manager

A state machine with no backward transitions:

```
running ──► done | failed | cancelled | timeout | unknown
```

Terminal states are immutable. This isn't decoration: `cancelJob()` used to write `cancelled`, and a later `child.on("exit")` would overwrite it with `done` — a cancelled job looked like a successful one.

The source of truth for completion is an **exit-code file**, not an event in the parent process. Jobs launch through `/bin/sh`, which redirects output and atomically writes `$?` to a separate file:

```
sh -c 'BIN="$1"; PROMPT="$2"; OUT="$3"; CODE="$4"; shift 4;
       "$BIN" "$@" < "$PROMPT" >> "$OUT" 2>&1;
       printf %s "$?" > "$CODE.tmp" && mv "$CODE.tmp" "$CODE"'
```

Paths and the prompt are passed as positional arguments rather than interpolated into a command string, so shell injection is impossible. This buys three things the `exit` handler never had: the exit code survives an MCP server restart, file descriptors don't leak (`sh` does the redirect; the parent opens `stdio: ignore`), and there's no race with cancellation.

A process that vanishes without writing an exit code gets `unknown`, not `done`: treating the unknown as success is the worst available option.

### Job identifiers

`job_id` arrives from the model, so it goes through strict `/^job-[0-9a-f]{8}$/` validation plus a containment check after `path.resolve()`. The single place an identifier becomes a path is `jobPath()`. Without this, `../../outside-job` read files outside the jobs directory and let an arbitrary PID reach `kill`.

### Editing `config.toml`

The file belongs to the user, so every edit stays inside a marked block. Each of these subtleties was a bug:

- **Replace via a function.** `str.replace(re, block)` interprets `$&`, `$1`, `$'` in the replacement string: a plugin path containing `$&` injected the old block into the result. Only `replace(re, () => block)` is safe.
- **Escaping the markers.** `# >>> codex-bridge (claude) >>>` contains parentheses — it goes into a `RegExp` only through `esc()`, otherwise the block is never found and a repeated `--link-back` piles up duplicates.
- **Global regex.** Several blocks could accumulate; `unlink()` removes all of them.
- **TOML string escaping.** A quote in the path broke the file. `tomlString()` escapes `\`, `"`, and control characters.
- **Conflicts.** If the user already has an unmanaged `[mcp_servers.claude-bridge]`, adding a second table would make the TOML invalid — the operation is refused and the file left untouched.
- **Atomicity.** Write to a temp file, then rename.

### Bridge path self-healing

`${CLAUDE_PLUGIN_ROOT}` changes on every plugin update, and the previous version's directory is removed after roughly 14 days. A path written once into `config.toml` would silently go stale after `/plugin update` and then break. `ensureFresh()` in the `SessionStart` hook compares the recorded path against the current one and rewrites it on mismatch.

### Tool restriction in `claude_task`

`--allowedTools` does **not** restrict the tool set — it only skips the confirmation prompt. `--tools` is what limits availability. This was a real bug: an administrative allowlist of `["Read"]` could be bypassed with a single argument from Codex.

`resolveTools()` intersects the requested set with the configured ceiling: narrowing is allowed, widening is not. An empty intersection isn't a reason to launch Claude with no tools — it's a refusal with an explanation. With `write: false`, write tools are stripped unconditionally and duplicated into `--disallowedTools`.

### MCP tool proxying

`tool-proxy.mjs` starts the allowed servers through `mcp-client.mjs`, reads their `tools/list`, and re-exports them as `<alias>__<tool>`. One server failing doesn't break the others.

Server discovery follows Claude Code precedence: **local → project → user**, first match wins. The order matters: previously the user-scope server was picked, overriding a developer's local setting.

Environment variables are stored in the allowlist **only as references** — `${VAR}` / `${VAR:-default}`. `sanitizeEnv()` drops literal values so other people's tokens never land in a plugin file. Expansion happens at server launch.

### Image generation

Without an explicit prohibition, Codex tends to write a Python or Node script against the paid Images API instead of using the built-in `image_gen`. The prompt in `buildPrompt()` closes that path with three separate statements, and `generateImage()` detects the slip from the output (`OPENAI_API_KEY`, `api.openai.com`, `images/generations`) and says so plainly.

A result is accepted only after these checks:

1. Codex's exit code — **before** looking for files, otherwise an unrelated artifact gets picked up;
2. `sniffImage()` — PNG/JPEG/GIF/WebP magic bytes, not the extension and not Codex's word for it;
3. `resolveInside()` — `out_dir` and references stay within the project root; absolute paths are refused;
4. `acceptableSource()` — a path from a `SAVED:` line is accepted only from inside the project or `$CODEX_HOME/generated_images/`.

The fallback scan of Codex's output directory filters by signature too.

### Model catalog

`codex debug models` → parsing that narrows the slice from both ends (the catalog is sometimes wrapped in notice text) → a 6-hour cache.

If the subcommand is unavailable, it degrades to `model` from `config.toml`, then to a stale cache. Such a catalog is flagged `complete: false`, and `knownModel()` **does not block** unknown models against it — otherwise perfectly valid names would be rejected.

### MCP transport

`mcp-lib.mjs` declares its supported versions explicitly (`2025-06-18`, `2025-03-26`) and echoes the requested one only when it supports it; otherwise it answers with its own. Malformed JSON yields `-32700 Parse error` rather than silence. Only the error message goes to the client — stack traces are written to stderr so paths and internals aren't exposed.

JSON-RPC batches are rejected deliberately: they were removed from MCP in revision 2025-06-18, which is what the server advertises.

`mcp-client.mjs` responds to a nested server's `exit`/`close` by failing all pending requests immediately and keeps the tail of its stderr — without this, a call after the server died hung for the full timeout and the cause was lost.

---

## Tests

```bash
node tests/regressions.mjs
```

27 tests, one per known defect. Real `codex` and `claude` binaries aren't needed: the suite creates its own stubs in a temp directory, driven by environment variables.

Covered: flag detection, terminal job states, exit code across restarts, descriptor leaks, `job_id` path traversal, tool allowlist bypass, forced read-only, an arbitrary file passed off as an image, path containment, `config.toml` corruption (`$&`, quotes, duplicates, conflicts), non-zero exit handling, file permissions and secret stripping, model catalog degradation, `setup` argument parsing, MCP precedence, version negotiation, parse errors, stack trace leakage, and reaction to a nested server dying.

The descriptor-leak test needs `/proc` and is silently skipped on non-Linux.

When adding functionality, add the test in the same file — it's deliberately a single file with no runner, to avoid pulling in dependencies.

---

## Publishing

The repository is simultaneously the plugin and a single-plugin marketplace: `.claude-plugin/marketplace.json` sits at the root and its only entry points at `"source": "."` — the root itself.

```bash
claude plugin validate . --strict
```

This checks the manifest, command and agent frontmatter, and `hooks.json`. `--strict` turns warnings into errors, which is useful in CI.

### Versioning

`plugin.json` sets `"version"`. While that field is present, users receive updates **only after you bump it**: new commits aren't enough, Claude Code sees the same version string and keeps the cached copy.

During active development you can drop the field — the commit SHA then becomes the version and updates ship with every push.

The version in `plugin.json` and in `serve({ version })` of both MCP servers must match.

### Multiple plugins in one repository

If other plugins appear, move this one to `plugins/codex-bridge/` and change `source` to `"./plugins/codex-bridge"`. Entry paths resolve relative to the directory containing `.claude-plugin/`.

---

## Debugging

```bash
claude --plugin-dir /path/to/claude-codex-bridge   # run without installing
claude --debug                              # plugin loading, MCP init
/codex-bridge:setup                                # environment diagnostics
```

You can talk to an MCP server directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node scripts/mcp-codex.mjs
```

The reverse bridge works the same way via `node bridge/mcp-claude.mjs`; it reads its allowlist from `CODEX_BRIDGE_EXPOSED` (default `~/.codex/codex-bridge/exposed.json`).

Useful environment variables for tests and debugging: `CODEX_BIN`, `CLAUDE_BIN`, `CLAUDE_PLUGIN_DATA`, `CODEX_BRIDGE_CONFIG`, `CODEX_BRIDGE_EXPOSED`, `CODEX_HOME`.

---

## Unverified assumptions

An honest list of what has never been checked against live binaries:

1. **The `aspect_ratio` / `image_resolution` constraints** (`auto` only with `1K`, `1:1` without `4K`) come from a third-party API's documentation and are unconfirmed for the built-in `image_gen`. They may reject valid parameters — two lines in `validate()` in `image-core.mjs` remove them.
2. **The output format of `codex debug models`** is parsed leniently (`parseCatalog()`), but has never been tested against real output.
3. **The exact `codex exec` flag set** is detected from `--help`; parsing help text with regexes is itself an assumption.
4. **The behaviour of `claude -p --tools`** was verified from documentation, not against a real binary.

A first run in a real environment should proceed in order of increasing risk: `/codex-bridge:setup` → `/codex-bridge:models` → `/codex-bridge:review` → `/codex-bridge:delegate` → `/codex-bridge:image`.

## Contributing

Patches are accepted with a test for the behaviour being fixed. Changes touching security (tool allowlists, path containment, file permissions, `config.toml` editing) must come with a test that fails without the fix.
