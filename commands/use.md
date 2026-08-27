---
description: Select the default Codex model for this repository
argument-hint: "[<model>] [--effort <level>] [--clear]"
allowed-tools: mcp__plugin_tandem_codex__codex_use, mcp__plugin_tandem_codex__codex_models
---

The user is selecting a Codex model: `$ARGUMENTS`

Call **codex_use**: the first word is the model name, `--effort` is the reasoning level, and `--clear` resets the selection to the plugin settings. With no arguments, show the current value.

If the model name is uncertain, check **codex_models**—the catalog is provided by Codex itself.

Tell the user directly: this value applies to the repository, not to a specific Claude window. An MCP call has no reliable session identifier, so the selection will also be visible to other open windows in the same project.
