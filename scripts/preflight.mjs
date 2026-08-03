#!/usr/bin/env node
// SessionStart-хук: проверяет готовность Codex и чинит путь обратного моста,
// если плагин обновился и ${CLAUDE_PLUGIN_ROOT} изменился.
import { checkCodex } from "./codex-core.mjs";
import { ensureFresh } from "./link-back.mjs";

const c = checkCodex();
if (c.reason === "not_installed") {
  console.error("[codex-bridge] Codex CLI не найден. Установка: npm install -g @openai/codex, затем codex login.");
} else if (c.reason === "not_logged_in") {
  console.error("[codex-bridge] Codex установлен, но не авторизован. Выполни: codex login");
}

try {
  const fixed = ensureFresh();
  if (fixed) {
    console.error(
      `[codex-bridge] Путь обратного моста в ~/.codex/config.toml обновлён после обновления плагина.\n` +
        `  было: ${fixed.from}\n  стало: ${fixed.to}\n  Перезапусти Codex, чтобы он подхватил новый путь.`
    );
  }
} catch (e) {
  console.error(`[codex-bridge] Не удалось проверить обратный мост: ${e.message || e}`);
}

process.exit(0);
