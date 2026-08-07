#!/usr/bin/env node
// SessionStart-хук: проверяет готовность Codex и чинит путь обратного моста,
// если плагин обновился и ${CLAUDE_PLUGIN_ROOT} изменился.
import { probeCodex } from "./codex-core.mjs";
import { ensureFresh } from "./link-back.mjs";

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

const c = await probeCodex();
if (c.reason === "not_installed") {
  console.error("[codex-bridge] Codex CLI не найден. Установка: npm install -g @openai/codex, затем codex login.");
} else if (c.reason === "not_logged_in") {
  console.error("[codex-bridge] Codex установлен, но не авторизован. Выполни: codex login");
} else if (c.reason === "probe_timeout") {
  console.error(
    "[codex-bridge] Проверка готовности Codex не завершилась за отведённое время. Сам Codex может быть исправен; проверь вручную: codex login status"
  );
}

process.exit(0);
