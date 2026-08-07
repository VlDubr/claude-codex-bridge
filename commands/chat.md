---
description: Talk to a Codex model as a separate conversational partner (the thread remembers previous turns)
argument-hint: "[--model <model>] [--chat <name>] [--write] <message>"
allowed-tools: mcp__plugin_codex-bridge_codex__codex_chat, mcp__plugin_codex-bridge_codex__codex_chats
---

The user is addressing a Codex model: `$ARGUMENTS`

Parse the arguments: `--model` is the Codex model name, `--chat` is the thread name (`default` by default), and `--write` allows the model to modify files. Everything else is the message to the model.

Call **codex_chat** with these fields. The model and reasoning level are set on the first turn and are reused automatically afterward; you do not need to pass them when continuing the conversation.

Show the model's response verbatim and separately from your own comments: the user must be able to see where GPT is speaking and where you are. Include the work log if it helps explain the response.

Use **codex_chats** to list conversations. If the thread is lost, say so directly and offer to forget the conversation (`codex_chats` with `forget`) instead of silently starting a new one.
