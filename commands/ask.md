---
description: Ask GPT for a second opinion right now
argument-hint: "<question>"
allowed-tools: mcp__plugin_codex-bridge_codex__codex_ask
---

The user wants GPT's opinion on this question: `$ARGUMENTS`

Call **codex_ask**. In the `context` field, be sure to include what you know but GPT does not: what you are currently working on, which options have already been rejected and why, and which project constraints matter. Without this context, the response will be generic and unhelpful.

Show GPT's response verbatim, followed by your own position. If you disagree, state the exact point of disagreement directly; do not smooth it over.
