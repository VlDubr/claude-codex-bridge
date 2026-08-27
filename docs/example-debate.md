# A real disagreement, start to finish

[Русский](example-debate.ru.md) · **English**

This is not a scripted demo. It is an exchange that happened in this repository
on 2026-08-27, while fixing a test that had been failing on CI since the day it
was written. It ends in commit [`cc2f8a1`](https://github.com/VlDubr/tandem/commit/cc2f8a1).

The conversation was held in Russian and is translated here; the original is in
[the Russian version](example-debate.ru.md). The command output is verbatim.

---

## The setup

`scripts/codex-core.mjs` probes the local `codex` binary once and remembers what
flags its `exec` subcommand accepts:

```js
let capsCache = null;
export function capabilities({ force = false } = {}) {
  if (capsCache && !force) return capsCache;
  ...
  return (capsCache = caps);
}
```

A test asserting that `--ask-for-approval` reaches the image-generation path had
never passed on Linux. The cause turned out to be module caching: the tests bust
the ESM cache with `import("./image-core.mjs?caps4=" + Date.now())`, but that
only creates a fresh `image-core` — its static `import "./codex-core.mjs"`
resolves to one and the same URL, so `capsCache` is shared for the whole run.
An earlier test probed first, and this one inherited its answer.

Fixed in the tests. CI green. The question was whether the product code deserved
a change too.

## Claude's position

> The product code should stay as it is. A module-level singleton is the right
> shape here:
>
> 1. `capabilities()` runs two synchronous `spawnSync` calls on the MCP server's
>    main thread. The cache exists precisely so we don't pay that per call.
> 2. In production the process lives with one `codex` binary. Swapping the binary
>    mid-process is not a scenario.
> 3. The `force` parameter already exists and solves the test problem exactly
>    where it arose.
> 4. Dependency injection for testability would mean an extra parameter in
>    `buildArgs`, `buildImageArgs` and every caller — for a scenario that does
>    not happen in production.

## GPT's answer

> You are wrong in the place that matters: what gets cached is not only a
> measured capability, but the failure to measure it.
>
> A real production scenario with no binary swap at all: the first
> `codex exec --help` hangs, exits with an error, or returns truncated output.
> The code checks neither `status` nor `error`; any non-empty chunk counts as
> `probed: true`, and an empty result is stored too — in memory and on disk,
> under a valid version key. After that the wrong flag set lives indefinitely,
> across server restarts. `force` is no answer here: in production there is
> nobody to know when to call it.
>
> The test that failed for months is first of all a test-isolation and
> CI-discipline defect, not proof of a product bug. But the current fix is still
> fragile: the reset after the assertion is not in a `finally`, so a failing
> assert re-contaminates the rest of the run.
>
> Your position holds only under a hard contract: the executable never changes
> before a restart, and the first probe is guaranteed complete and successful.
> The second cannot be guaranteed.

## Verification

Claims from a second model are not evidence. This one was checked by pointing
`CODEX_BIN` at plain `node` — `node exec --help` writes to stderr and exits
non-zero, which is exactly how a broken binary behaves:

```
probed: true | sandbox: false | cd: false | json: false
args: ["exec","-"]
--json: LOST   --sandbox: LOST   --cd: LOST   --skip-git-repo-check: LOST
```

`buildArgs` collapses to `["exec", "-"]`. Losing `--cd` means Codex would work in
the server process's directory instead of the project's — a delegated task would
edit the wrong repository. And the result was persisted to disk under a valid
version key, so it survived restarts.

The consequence GPT predicted was real. The severity was worse than either side
had assumed.

## Outcome

A probe now counts only if `help` exited cleanly, and a failed probe is cached
neither on disk nor in memory — the next call retries, and the existing fallback
set of base flags applies until then. Regression test `1e` covers it, and it runs
on Windows too, unlike the shell-script stub the other capability tests need.

GPT's second point was correct as well: test `1d` now resets in a `finally`.

Two positions, one of them wrong, and the disagreement is what surfaced it. That
is the whole reason this plugin exists.
