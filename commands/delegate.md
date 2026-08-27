---
description: Delegate a task to GPT to investigate and fix independently
argument-hint: "[--model <model>] [--effort <level>] <task description>"
allowed-tools: mcp__plugin_tandem_codex__codex_delegate
---

The user is delegating a task to GPT. Arguments: `$ARGUMENTS`

Before calling the tool, make sure the task is phrased so the model can understand it without your context. If the description refers back to the current conversation (“fix this,” “that bug”), expand those references into a self-contained prompt: which file, what error, how to reproduce it, and what has already been tried.

Then call **codex_delegate** with the `task` field, as well as `model`/`effort` if they were provided as flags.

GPT works in the same working directory and **can modify files**. Warn the user about this in one line and advise them to commit or stash their current work if it has not been saved. Report the job_id and stop—do not wait for completion.
