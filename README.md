# Claude Codex Bridge

[Русский](README.ru.md) · **English**

A Claude Code plugin that brings Codex (ChatGPT) into your workflow — so you stop switching between two terminals and copying code from one window to the other.

Code review, adversarial review, task delegation, image generation. And the part nothing else does: **the exchange runs both ways**. Claude can consult GPT, and GPT can consult Claude. They can argue, critique each other's decisions, and hand work back and forth.

Everything runs on subscriptions you already have. No API keys.

---

## Why

Two models have different blind spots. A decision one finds obvious, the other will often tear apart — and frequently it has a point. But using that normally means shuttling text between two windows by hand, losing context on every hop.

Claude Codex Bridge removes the hop. When Claude hits a contested architectural decision, it asks GPT on its own, without you typing a command. When GPT works through unfamiliar code, it reaches out to Claude. You see both positions and exactly where they diverge.

```
                              ┌──────────────┐
   /codex-bridge:ask          │              │        claude_ask
   /codex-bridge:review   ───►│    Codex     │◄───    claude_critique
   /codex-bridge:delegate     │    Bridge    │        claude_task
   Claude Code            ◄───│              │───►    Codex CLI
   results                    └──────────────┘        proxied MCP tools
```

---

## Features

### Code review

| | |
|---|---|
| **Standard review** | GPT works through your current changes: blockers, bugs, races, unhandled errors — with file and line |
| **Adversarial review** | Doesn't hunt for typos, it challenges the decision: which assumptions went unverified, which failure mode was missed, whether a simpler path exists |

### Task delegation

Describe the bug — GPT diagnoses the cause itself, makes the smallest safe change, and runs the tests. It works in the background: kick it off and carry on with your own task.

```
/codex-bridge:delegate the auth_spec tests started failing after the main merge, dig in
/codex-bridge:status      # still running?
/codex-bridge:result      # what came out
/codex-bridge:cancel      # changed my mind
```

### Watching the work happen

Long-running calls don't sit behind a blind timeout. Codex streams its activity — reasoning, shell commands, file edits, web searches — and the plugin turns that into a readable trail:

```
/codex-bridge:progress

  · thinking: Working through the webhook retry scheme
  · running: rg -n retry src/
  · searching the web: idempotency key payment webhook
  · thinking: Checking the race on redelivery
```

The same trail streams into Claude Code while the call is in flight: Codex's steps show up next to the tool call as they happen, instead of arriving in one lump at the end.

If a synchronous `codex_ask` runs past its wait budget, it doesn't fail and nothing is lost — the very same job keeps running in the same process in the background, and you get its id plus everything the model managed to do so far. Cancelling the call in Claude stops Codex too.

One caveat: Codex emits reasoning *summaries*, not full chain-of-thought. With `reasoning_summary = auto` there may be no summaries at all — set `detailed` if you want a verbose trail.

### Talking to Codex models

Codex models are available as separate interlocutors: the thread persists and the model remembers earlier turns.

```
/codex-bridge:use gpt-5.6-sol
/codex-bridge:chat --chat retry walk through the retry logic in src/webhook
/codex-bridge:chat --chat retry and what happens on redelivery?
```

One chat name is one continuous thread. Model and reasoning level are set on the first turn and repeat automatically after that. `--write` lets the model change files; read-only otherwise. List conversations with `codex_chats`.

An honest limitation: a plugin cannot add Codex models to Claude Code's `/model` — there is no API for registering a model provider. You reach them through `/codex-bridge:chat` or the `codex-bridge:gpt-chat` subagent.

### Two models working together

```
/codex-bridge:ask     should this cache move to Redis or is in-memory enough
/codex-bridge:debate  retry strategy for the payment webhook
```

`/codex-bridge:debate` runs a structured argument over several rounds: Claude states a position, GPT challenges it, Claude answers the strongest objection. It closes with what both sides accepted, where they still disagree, and which experiment would settle it. Agreement is never faked: two diverging opinions are more useful than one averaged out.

### Image generation

```
/codex-bridge:image --ar 16:9 --res 2K landing page banner, dark background, isometric
/codex-bridge:image --ref designs/palette.png settings icon in the reference style
```

Rendered by gpt-image-2 through Codex's built-in tool — on your ChatGPT subscription, no API key. After generating, Claude **opens the image and looks at it**: it checks against criteria written down beforehand and, on a mismatch, refines the prompt and regenerates. A "success" response from the model says nothing about what was actually drawn.

### The reverse bridge

After `/codex-bridge:setup --link-back`, GPT gets tools of its own:

- **`claude_ask`, `claude_critique`** — ask Claude's opinion, have it critique a plan before you apply it
- **`claude_task`** — hand a task to Claude Code with all of its tools
- **MCP proxying** — tools from your MCP servers (issue tracker, database, docs) become directly available to GPT

---

## Requirements

- **Claude Code** 2.1.154 or newer
- **Node.js** 20.11+ (or 21.2+)
- **Codex CLI** with a ChatGPT subscription — any tier works, including Free

## Installation

```bash
npm install -g @openai/codex   # if Codex isn't installed yet
codex login                    # OAuth sign-in with your ChatGPT account
```

Then, inside a Claude Code session:

```
/plugin marketplace add VlDubr/claude-codex-bridge
/plugin install codex-bridge@claude-codex-bridge
/reload-plugins
/plugin enable codex-bridge
```

Check that everything is in place:

```
/codex-bridge:setup
```

It reports the Codex version, auth state, available models, and the image output directory. If something is missing, it tells you exactly what.

> The plugin installs **disabled**. It spends your ChatGPT subscription limits and widens the available tool surface, so enabling it is a deliberate act rather than a side effect of installing.

## Configuration

On enable, Claude Code prompts for a few values — all optional:

| Setting | What it controls |
|---|---|
| `language` | Language of messages and of the prompts sent to Codex — `en` (default) or `ru`. The prompt's language is what the model answers in, so this also sets the language of its replies. Commands and agents stay English |
| `default_model` | Default Codex model. See `/codex-bridge:models` for the list |
| `default_effort` | Reasoning level: `none`, `low`, `medium`, `high`, `xhigh`, `max`. The exact set depends on the model — see `/codex-bridge:models` |
| `review_backend` | Review transport: `exec` by default, or the opt-in native `app-server` reviewer with safe fallback before acceptance |
| `reasoning_summary` | `detailed` — verbose reasoning summaries in the trail, `auto` — Codex decides (there may be none) |
| `progress_notifications` | Stream the work trail while the call is running. Turn it off if your Claude Code build drops the connection on such notifications — see Troubleshooting |
| `max_parallel_jobs` | Maximum concurrent Codex jobs (default 4; `0` removes the limit) |
| `job_timeout_minutes` | When to kill a stuck background job (default 30) |
| `image_output_dir` | Where images go (default `assets/generated`) |
| `image_timeout_minutes` | Image generation timeout (default 15) |
| `bypass_sandbox` | Emergency escape hatch for a broken Codex sandbox. Off by default — see Troubleshooting |

### Status line

What the Codex models are doing right now can go into the Claude Code status line. The plugin does not wire it up itself: `statusLine` is a single setting for the whole installation, and silently overwriting someone's own is not acceptable. Add to `settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/plugins/cache/<marketplace>/codex-bridge/<version>/scripts/statusline.mjs"
}
```

The line stays empty when nothing is running.

### The GPT → Claude bridge

Off by default. One command turns it on:

```
/codex-bridge:setup --link-back
```

It adds an MCP server to `~/.codex/config.toml`. Restart Codex and GPT gains `claude_ask` and `claude_critique`. To remove it: `/codex-bridge:setup --unlink-back`.

Reverse delegation is enabled separately, with an explicit tool ceiling:

```
/codex-bridge:setup --allow-task --task-tools Read,Grep,Glob
```

### Proxying MCP tools

See what's connected to Claude, then expose what you want:

```
/codex-bridge:setup --expose-list
/codex-bridge:setup --expose tracker --tools list_issues,create_issue
/codex-bridge:setup --unexpose tracker
```

Only what you list is proxied. A tool left out of `--tools` simply does not exist as far as GPT is concerned.

---

## Commands

| Command | What it does |
|---|---|
| `/codex-bridge:review [--base main] [--now]` | Review current changes |
| `/codex-bridge:challenge <what to challenge>` | Adversarial review: challenges the design |
| `/codex-bridge:delegate <task>` | GPT investigates and fixes it, with write access |
| `/codex-bridge:progress [id]` | What the model is doing right now: reasoning, commands, file edits |
| `/codex-bridge:status [id]` | Background job status |
| `/codex-bridge:result [id]` | Output of a finished job |
| `/codex-bridge:cancel [id]` | Cancel a running job |
| `/codex-bridge:ask <question>` | A second opinion from GPT, right now |
| `/codex-bridge:chat [--model M] [--chat name] [--write] <message>` | A conversation with a Codex model; the thread remembers earlier turns |
| `/codex-bridge:use [model] [--effort level]` | Default Codex model for this repository |
| `/codex-bridge:debate <topic>` | Multi-round Claude ↔ GPT argument |
| `/codex-bridge:image <description>` | gpt-image-2 image with result verification |
| `/codex-bridge:models [--refresh]` | Models actually available in this Codex |
| `/codex-bridge:setup [flags]` | Diagnostics, reverse bridge, tool proxying |

Slash commands aren't the only entry point. Claude reaches for the same capabilities on its own when the context calls for it. There are subagents too: `@codex-bridge:gpt-advisor` for a second opinion, `@codex-bridge:gpt-delegate` for handing off work, `@codex-bridge:gpt-chat` for a conversation with a specific Codex model, `@codex-bridge:image-smith` for a longer generate-and-verify loop.

## Models

```
/codex-bridge:models
```

The list isn't baked into the plugin — it's queried from Codex itself, because models get retired and hardcoded lists go stale silently. A typo in a model name is rejected immediately, along with the list of valid options.

Model selection works at three levels: a flag on the command, a plugin setting, or `model` in `~/.codex/config.toml`.

---

## Security and privacy

**Your code goes to OpenAI.** That is what the bridge is for, so it is worth stating plainly rather than burying. Everything you send through it — the prompt, the diff for a review, and any file Codex decides to read while working — leaves your machine for OpenAI's servers, under your ChatGPT subscription. The reverse direction is no different: what Claude answers back through the reverse bridge, and the results of any MCP tools you proxy, become part of Codex's context and are sent along with it. If your employer forbids sending source code to OpenAI, do not install this.

**Secret files are stripped from review diffs.** `.env`, `.npmrc`, `.netrc`, private keys, keystores and the like are listed as changed by name, but their contents never enter the diff — the real changes around them still do, so the review stays useful.

**The plugin stores no tokens.** OAuth is handled by `codex login`; the plugin runs on top of the existing local Codex CLI session — the same one you get running `codex` directly.

**Nothing is exposed by default.** The reverse bridge, delegation, and MCP proxying are all off until you explicitly turn them on. The allowed-tools list is a ceiling GPT can narrow but never widen.

**Other people's secrets aren't copied.** When proxying an MCP server, environment variables are stored only as `${VAR}` references, expanded at launch. Literal values are never saved, and `--expose` warns you about them.

**State files** are created with `0600` permissions inside a `0700` directory.

## Cost

Usage draws on your **ChatGPT subscription** limits, separately from your Claude subscription. No API keys, no per-token billing. Image generation stays within the subscription too.

Note that `/codex-bridge:image` takes 4–6 minutes — Codex reasons first and only then calls the tool. 4K takes longer. That's normal, not a hang.

## Troubleshooting

**"The model doesn't accept effort level X"** — the available levels depend on the model. `minimal` is only accepted by earlier generations; `gpt-5.6` and newer reject it with an API error. Check `/codex-bridge:models`, which lists the levels next to each model, and use `low` or higher.

**`failed to load models cache: missing field ...` in Codex logs** — a format mismatch in Codex's own internal cache. It doesn't affect anything. The plugin filters this line out of error messages so it can't mask the real cause.


**`MCP error -32000: Connection closed` on long calls** — on some Claude Code builds, receiving `notifications/progress` closes the MCP server connection ([anthropics/claude-code#47378](https://github.com/anthropics/claude-code/issues/47378), [#53617](https://github.com/anthropics/claude-code/issues/53617)). Turn off the `progress_notifications` setting — the live trail goes away, everything else keeps working. Trail rendering in the collapsed tool view landed in Claude Code 2.1.153.

**On Windows: `orchestrator_helper_launch_failed` / `program not found`, or an unexplained "user cancelled MCP tool call"** — Codex's sandbox failed to start. This surfaces as an MCP failure or a user cancellation, so it reads like a dead bridge when the bridge is fine. The usual cause is a mixed Codex installation: the CLI is one version while the helpers in `~/.codex/.sandbox-bin` are another. Run `/codex-bridge:setup` — it compares the versions and names the mismatch. The fix is reinstalling Codex (`npm install -g @openai/codex`). As a stopgap you can enable the `bypass_sandbox` setting, but then Codex runs commands without isolation.

**`unexpected argument '--...'`** — the `codex exec` flag set changed between versions. The first thing to try is updating the plugin: a build that passes a flag unconditionally cannot be repaired by clearing the cache. If the error survives the update, the detection cache is stale — it is keyed by binary version, but you can delete `exec-caps.json` in the plugin data directory by hand.

**Environment diagnostics** — `/codex-bridge:setup` reports the Codex version, auth state, model catalog, and reverse bridge status.

## Limitations

- MCP proxying only works with **stdio** servers. HTTP/SSE servers with their own OAuth are easier to register with Codex directly.
- Image references must be **local files**; the built-in tool doesn't accept URLs.
- Claude's built-in tools (Read, Edit, Bash) are deliberately not proxied — Codex has its own equivalents.

---

## Development

Architecture, internals, tests, and publishing live in **[README_DEV.md](README_DEV.md)**.

```bash
node tests/regressions.mjs   # self-contained tests; no real codex or claude needed
```

Run without installing: `claude --plugin-dir /path/to/claude-codex-bridge`

## License

MIT
