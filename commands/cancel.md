---
description: Cancel a running Codex job
argument-hint: "[job-id]"
allowed-tools: mcp__plugin_codex-bridge_codex__codex_cancel, mcp__plugin_codex-bridge_codex__codex_status
---

Call **codex_cancel** with the `job_id` from `$ARGUMENTS`. If no id is specified and multiple jobs are active, first show the list using codex_status and ask which one to cancel.

If the job was delegated, remind the user that GPT may already have changed some files and suggest checking `git diff`.
