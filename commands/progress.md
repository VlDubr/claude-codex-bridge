---
description: Show what the invoked model is working on right now
argument-hint: "[job-id] [--limit N]"
allowed-tools: mcp__plugin_tandem_codex__codex_progress
---

Call **codex_progress** with the `job_id` from `$ARGUMENTS` (if omitted, use the latest job) and `limit` if `--limit` was provided.

Show the event stream as is: the user wants to see the work in progress, not your summary. Add one line of your own stating the current stage of the job and whether it is worth continuing to wait.

If there are no events and the job has been running for a long time, this usually means Codex was started without `--json` support: no event stream will be available, so the only option is to wait for the result through `/tandem:result`.
