---
description: Проверить готовность Codex и настроить обратный мост GPT → Claude
argument-hint: "[--link-back | --unlink-back]"
allowed-tools: Bash(node:*), Bash(codex:*), Bash(npm install -g @openai/codex)
---

Аргументы: `$ARGUMENTS`

Выполни `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" $ARGUMENTS` и покажи результат.

Пояснения к возможным исходам:
- Codex не установлен → предложи `npm install -g @openai/codex`, но не запускай глобальную установку без явного согласия пользователя.
- Codex не авторизован → попроси выполнить `codex login` в терминале. Это OAuth-вход через аккаунт ChatGPT; пароль ты не запрашиваешь и нигде не сохраняешь.
- `--link-back` прописывает MCP-сервер `claude-bridge` в `~/.codex/config.toml`, после чего GPT сможет обращаться к Claude через инструменты `claude_ask` и `claude_critique`. Скажи пользователю, что изменения в config.toml подхватятся при следующем запуске Codex.
