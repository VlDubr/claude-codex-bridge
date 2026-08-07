---
description: Check Codex readiness and configure the GPT → Claude reverse bridge
argument-hint: "[--link-back | --unlink-back]"
allowed-tools: Bash(node:*), Bash(codex:*), Bash(npm install -g @openai/codex)
---

Arguments: `$ARGUMENTS`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" $ARGUMENTS` and show the result.

Explanations for possible outcomes:
- Codex is not installed → suggest `npm install -g @openai/codex`, but do not run a global installation without the user's explicit consent.
- Codex is not authenticated → ask the user to run `codex login` in the terminal. This is an OAuth login through their ChatGPT account; you do not ask for or store their password anywhere.
- `--link-back` adds the `claude-bridge` MCP server to `~/.codex/config.toml`, after which GPT can contact Claude through the `claude_ask` and `claude_critique` tools. Tell the user that the config.toml changes will take effect the next time Codex starts.
