---
description: Review the current changes using GPT (Codex)
argument-hint: "[--base <branch>] [--now] [additional focus]"
allowed-tools: mcp__plugin_codex-bridge_codex__codex_review
---

The user is requesting a code review from GPT. Arguments: `$ARGUMENTS`

Parse the arguments and call **codex_review**:
- `--base <ref>` → the `base` parameter (review the entire branch against this base)
- `--now` → `background: false` (wait for the response now; runs in the background by default)
- everything else → `focus`

If the job runs in the background, briefly report the job id and do not wait. If it runs synchronously, show GPT's output as is, without summarizing it, and add only one line of your own stating what you agree and disagree with. Do not rewrite code based on the review until the user asks.
