---
description: Show the result of a completed Codex job
argument-hint: "[job-id]"
allowed-tools: mcp__plugin_codex-bridge_codex__codex_result, Bash(git status)
---

Call **codex_result** with the `job_id` from `$ARGUMENTS` (if empty, the latest job will be used).

Show GPT's output in full, without shortening it: the user has been waiting for it. After the output, add a brief analysis of your own—what should be applied, what is debatable, and what needs verification. If this was a delegated job, check `git status` and state which files GPT actually changed.
