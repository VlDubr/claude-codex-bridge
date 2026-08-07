---
description: Show the models actually available in this Codex installation
argument-hint: "[--refresh]"
allowed-tools: mcp__plugin_codex-bridge_codex__codex_models
---

Call **codex_models**, passing `refresh: true` if `$ARGUMENTS` contains `--refresh`.

The list comes from Codex itself (`codex debug models`), not from a hardcoded table: the set of models changes, and older models are retired. Show the result as is.

If the user asked not just for the list but which model to choose, add this guidance: the flagship model is for architecture tasks and long sessions, while mini variants are for mechanical work and large batches of small tasks. The reasoning effort level affects usage at least as much as the model itself.
