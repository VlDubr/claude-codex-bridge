---
description: Adversarial review — GPT challenges a design decision
argument-hint: "[--base <branch>] [--now] <what to challenge>"
allowed-tools: mcp__plugin_tandem_codex__codex_challenge
---

The user is requesting an adversarial review. Arguments: `$ARGUMENTS`

Call **codex_challenge**, passing the substantive part of the arguments in `focus`, putting the `base` value from the argument after `--base`, and setting `background: false` when `--now` is present.

If the focus is not specified explicitly, do not leave it empty: inspect the changes and identify which decision should be challenged—the riskiest or least reversible one.

When the result arrives, do not become defensive automatically. For each objection from GPT, give one of three responses: accept, reject (and explain why), or needs verification (and explain how). This is the most valuable part of your response.
