---
description: Отменить выполняющуюся задачу Codex
argument-hint: "[job-id]"
allowed-tools: mcp__plugin_codex-bridge_codex__codex_cancel, mcp__plugin_codex-bridge_codex__codex_status
---

Вызови инструмент **codex_cancel** с `job_id` из `$ARGUMENTS`. Если id не указан и активных задач несколько, сначала покажи список через codex_status и уточни, какую отменять.

Если задача была делегированной, напомни, что GPT мог успеть изменить часть файлов, и предложи посмотреть `git diff`.
