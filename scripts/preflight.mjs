#!/usr/bin/env node
// SessionStart-хук: проверяет готовность Codex и чинит путь обратного моста,
// если плагин обновился и ${CLAUDE_PLUGIN_ROOT} изменился.
import { probeCodex } from "./codex-core.mjs";
import { ensureFresh } from "./link-back.mjs";
import { message } from "./i18n-runtime.mjs";

try {
  const fixed = ensureFresh();
  if (fixed) console.error(message("preflight_path_updated", fixed.from, fixed.to));
} catch (e) {
  console.error(message("preflight_check_failed", e.message || e));
}

const c = await probeCodex();
if (c.reason === "not_installed") console.error(message("preflight_not_installed"));
else if (c.reason === "not_logged_in") console.error(message("preflight_not_logged_in"));
else if (c.reason === "probe_timeout") console.error(message("preflight_probe_timeout"));

process.exit(0);
