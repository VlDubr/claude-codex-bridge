// i18n-runtime.mjs — наружные сообщения вспомогательных модулей.

import { lang } from "./i18n.mjs";

const MESSAGES = {
  en: {
    models_cli_not_found: "Codex CLI was not found. Install it with: npm install -g @openai/codex",
    models_stale_source: (source) => `${source} (stale cache)`,
    models_fetch_failed: (status, stderr) =>
      `Could not retrieve the model list. \`codex debug models\` returned ` +
      `${status === 0 ? "unparseable output" : `exit code ${status}`}` +
      `${stderr ? `: ${stderr.slice(0, 300)}` : ""}. ` +
      "Check the Codex version and authentication (codex login status).",
    effort_unknown: (effort, levels) =>
      `Reasoning effort "${effort}" is not in the known set: ${levels.join(", ")}. ` +
      "Use the codex_models tool for the exact list for a model.",
    effort_unsupported: (model, effort, supported) =>
      `Model ${model} does not accept reasoning effort "${effort}". Supported: ${supported.join(", ")}.`,
    models_effort_missing: "[effort: not declared by catalogue]",
    models_default: "(default)",
    models_header: (source, cached) => `Codex models (source: ${source}${cached ? ", cached" : ""}):`,
    models_incomplete:
      "\nWarning: the catalogue is incomplete (obtained through a fallback). Model names are not checked for existence.",

    health_version_mismatch: (cli, helpers) =>
      `Version mismatch: CLI ${cli}, helpers in .sandbox-bin: ${helpers.join(", ")}`,
    health_mixed_install:
      "A mixed installation breaks the sandbox, and the failure surfaces as an MCP tool refusal.",
    health_reinstall: (dir) =>
      `Reinstall Codex completely: npm install -g @openai/codex — then remove stale binaries from ${dir}`,
    health_multiple_helpers: (versions) => `.sandbox-bin contains multiple helper versions: ${versions.join(", ")}`,
    health_sandbox_missing: (mode) =>
      `config.toml enables the sandbox ([windows] sandbox = '${mode}'), but codex-windows-sandbox-setup.exe is missing`,
    health_sandbox_will_fail:
      'Every sandboxed codex exec run will fail; the error looks like "user cancelled MCP tool call".',
    health_sandbox_fix:
      "Reinstall Codex (npm install -g @openai/codex). As a temporary workaround, enable the plugin's bypass_sandbox setting, but Codex will then run commands without isolation.",
    health_elevated_note:
      "Sandbox mode 'elevated' requires administrator rights: without them, profile isolation is incomplete (the log contains SetFileAttributesW ... Access denied).",
    health_unknown: "unknown",
    health_versions_unknown: "versions not detected",
    health_cli: (version) => `codex CLI: ${version}`,
    health_helpers: (versions, windowsSetup) =>
      `helpers:   ${versions}` +
      (windowsSetup === null ? "" : `, windows-sandbox-setup: ${windowsSetup ? "present" : "MISSING"}`),
    health_sandbox: (mode) => `sandbox:   [windows] sandbox = '${mode}'`,
    health_problem: (what) => `PROBLEM: ${what}`,
    health_solution: (fix) => `  Solution: ${fix}`,
    health_note: (note) => `Note: ${note}`,
    health_consistent: "the Codex installation looks consistent",

    chat_invalid_name: (slug) => `Invalid chat name: ${JSON.stringify(slug)}`,
    chat_path_outside: (slug) => `Chat path escapes its directory: ${slug}`,
    chat_busy: (slug) => `Chat "${slug}" is busy with another turn. Wait for the answer or start a new chat.`,
    chat_stale_lock: (slug) => `Could not remove the stale lock for chat "${slug}".`,
    status_starting: "starting",

    mcp_parse_error: "Parse error",
    mcp_batches_unsupported: "Batch requests are not supported by protocol version 2025-06-18",
    mcp_not_an_object: "Invalid request: a JSON-RPC message must be an object",
    mcp_line_too_long: (limit) => `Invalid request: message exceeds the ${limit} byte limit`,
    mcp_method_not_found: (method) => `Method not found: ${method}`,

    worker_spec_missing: "job-worker: spec path was not provided\n",
    worker_exit_code_write_failed: (error) => `job-worker: could not write the exit code: ${error}\n`,
    worker_spawn_failed: (error) => `could not start Codex: ${error}`,
    worker_prompt_read_failed: (error) => `job-worker: could not read the prompt: ${error}\n`,
    worker_timeout: (seconds) => `task timed out after ${seconds}s`,
    worker_log_truncated: (mb) =>
      `[the journal has reached its ${mb} MiB limit; further streamed output is dropped]`,
    app_server_spawn_failed: (error) => `could not start codex app-server: ${error}`,
    app_server_signal: (signal) => `signal ${signal}`,
    app_server_code: (code) => `code ${code}`,
    app_server_exited: (how) => `codex app-server exited (${how})`,
    app_server_closed: "codex app-server connection is closed",
    app_server_request_timeout: (method) => `codex app-server timed out on ${method}`,
    app_server_bad_json: "codex app-server returned an invalid JSONL line",
    app_server_rpc_failed: (method) => `codex app-server rejected ${method}`,
    app_server_server_request_unsupported: (method) => `Unsupported app-server request: ${method}`,
    app_server_custom_base_focus: (base, focus) =>
      `Review the changes against base branch ${base}. Focus especially on: ${focus}`,
    app_server_custom_focus: (focus) => `Review the uncommitted changes. Focus especially on: ${focus}`,
    app_server_missing_thread: "codex app-server did not return a thread id",
    app_server_missing_turn: "codex app-server accepted review/start without a turn id",
    app_server_cancelled_before_accept: "codex app-server review was cancelled before review/start returned",
    app_server_review_failed: (status) => `codex app-server review ended with status ${status}`,
    app_server_fallback: (error) => `codex app-server was unavailable before review/start was accepted; falling back to codex exec: ${error}`,

    setup_bad_args: (error) => `Invalid arguments: ${error}`,
    setup_usage:
      "Available: --expose-list | --expose <server> [--tools a,b] | --unexpose <server> |\n" +
      "           --allow-task [--task-tools a,b] | --deny-task | --link-back | --unlink-back",
    setup_mutually_exclusive: (a, b) => `--${a} and --${b} cannot be used together.`,
    setup_codex_missing: (bin) => `codex:    NOT FOUND (${bin})`,
    setup_codex_install: "          install: npm install -g @openai/codex",
    setup_codex_installed: "installed",
    setup_authorized: "authenticated",
    setup_auth_ok: (info) => `auth:     OK (${info})`,
    setup_auth_no: "auth:     NO — run: codex login",
    setup_claude_missing: "claude:   not found in PATH (the GPT→Claude bridge will not work)",
    setup_claude_version: (version) => `claude:   ${version}`,
    setup_jobs: (dir) => `jobs:     ${dir}`,
    setup_models: (count, source, sample, more) => `models:   ${count} (${source}) — ${sample}${more ? ", …" : ""}`,
    setup_models_failed: (error) => `models:   unavailable — ${error}`,
    setup_bypass_warning:
      "WARNING: bypass_sandbox is enabled — Codex runs commands without isolation. This is an emergency mode; disable it after repairing the Codex installation.",
    setup_images: (dir) => `images → ${dir} (built-in image_gen, no API key)`,
    setup_back_bridge: (linked) =>
      `GPT→Claude bridge: ${linked ? "connected" : "not connected (enable: /tandem:setup --link-back)"}`,
    setup_path_stale: "          path is stale and will be fixed at the next session start",
    setup_proxy_summary: (names, allowTask) =>
      `exposed to Codex: ${names.length ? names.join(", ") : "nothing exposed"}` +
      (allowTask ? " | claude_task enabled" : ""),
    setup_servers_header: "MCP servers found in Claude Code configuration:",
    setup_servers_none: "  (nothing found in ~/.claude.json or ./.mcp.json)",
    setup_transport_unsupported: "  — unsupported (stdio only)",
    setup_already_exposed: "  [already exposed]",
    setup_expose_hint: "Expose:  /tandem:setup --expose <name> [--tools a,b,c]",
    setup_server_not_found: (name) => `Server "${name}" was not found. List: /tandem:setup --expose-list`,
    setup_server_transport: (name, transport) =>
      `Server "${name}" uses the ${transport} transport. The bridge supports only stdio: ` +
      "HTTP/SSE servers with their own authentication must be connected directly in ~/.codex/config.toml.",
    setup_env_dropped: (names) =>
      `Environment variables ${names.join(", ")} were NOT copied: their values are literals and may contain secrets. ` +
      "Use ${VAR} references in the Claude configuration or set them in the Codex environment.",
    setup_server_exposed: (name, tools) => `Server "${name}" was exposed to Codex (${tools || "all tools"}).`,
    setup_exposed_written: (file) => `Written to ${file}. Restart Codex so it can see the tools.`,
    setup_server_unexposed: (name) => `Server "${name}" is no longer exposed.`,
    setup_task_enabled: (tools) =>
      `claude_task enabled. Codex can delegate tasks to Claude Code${tools ? ` with tools: ${tools}` : ""}.`,
    setup_task_disabled: "claude_task disabled.",
    setup_back_added: (file) => `Reverse bridge added to ${file}`,
    setup_back_updated: (file) => `Reverse bridge updated in ${file}`,
    setup_back_removed: (file) => `Reverse bridge removed from ${file}`,
    setup_back_not_found: "The tandem block was not found in config.toml.",
    setup_config_not_found: "config.toml was not found; there is nothing to remove.",

    proxy_stdio_required: (alias) => `${alias}: skipped; only stdio servers are supported (the command field is required)`,
    proxy_no_tools: (alias) => `${alias}: connected, but the allowlist permits no tools`,
    proxy_description_prefix: (alias) => `[via Claude Code · server ${alias}] `,
    proxy_description_default: "Tool exposed from Claude's MCP environment.",
    proxy_not_exposed: (name) => `Tool ${name} is not exposed.`,

    client_timeout: (alias, method) => `${alias}: timed out on ${method}`,
    client_server_exited: (alias, how) => `${alias}: the server process exited (${how})`,
    client_signal: (signal) => `signal ${signal}`,
    client_code: (code) => `code ${code}`,
    client_unavailable: (alias) => `${alias}: server unavailable`,

    linkback_managed_block:
      "# Managed by the tandem plugin. The path updates automatically when the\n" +
      "# plugin updates — edits inside this block will be overwritten.",
    linkback_conflict: (configPath, table) =>
      `${configPath} already declares a [${table}] table that this plugin did not write. ` +
      `Adding a second one would make the file invalid TOML. Remove or rename the existing table and retry.`,

    preflight_path_updated: (from, to) =>
      `[tandem] The reverse-bridge path in ~/.codex/config.toml was updated after a plugin update.\n` +
      `  was: ${from}\n  now: ${to}\n  Restart Codex so it picks up the new path.`,
    preflight_check_failed: (reason) => `[tandem] Could not check the reverse bridge: ${reason}`,
    preflight_not_installed: "[tandem] Codex CLI not found. Install: npm install -g @openai/codex, then codex login.",
    preflight_not_logged_in: "[tandem] Codex is installed but not authorised. Run: codex login",
    preflight_probe_timeout:
      "[tandem] The Codex readiness check did not finish in time. Codex itself may be fine; check by hand: codex login status",
  },

  ru: {
    models_cli_not_found: "Codex CLI не найден. Установи: npm install -g @openai/codex",
    models_stale_source: (source) => `${source} (устаревший кэш)`,
    models_fetch_failed: (status, stderr) =>
      `Не удалось получить список моделей. \`codex debug models\` вернул ` +
      `${status === 0 ? "неразобранный вывод" : `код ${status}`}` +
      `${stderr ? `: ${stderr.slice(0, 300)}` : ""}. ` +
      "Проверь версию Codex и авторизацию (codex login status).",
    effort_unknown: (effort, levels) =>
      `Уровень усилий "${effort}" не входит в известный набор: ${levels.join(", ")}. ` +
      "Точный список для модели — инструмент codex_models.",
    effort_unsupported: (model, effort, supported) =>
      `Модель ${model} не принимает уровень усилий "${effort}". Поддерживаются: ${supported.join(", ")}.`,
    models_effort_missing: "[effort: не объявлен каталогом]",
    models_default: "(по умолчанию)",
    models_header: (source, cached) => `Модели Codex (источник: ${source}${cached ? ", из кэша" : ""}):`,
    models_incomplete:
      "\nВнимание: каталог неполный (получен обходным путём). Имена моделей не проверяются на существование.",

    health_version_mismatch: (cli, helpers) =>
      `Рассинхрон версий: CLI ${cli}, хелперы в .sandbox-bin — ${helpers.join(", ")}`,
    health_mixed_install:
      "Смешанная установка ломает песочницу, а сбой выходит наружу как отказ MCP-инструмента.",
    health_reinstall: (dir) =>
      `Переустановить Codex целиком: npm install -g @openai/codex — затем удалить устаревшие бинари из ${dir}`,
    health_multiple_helpers: (versions) => `В .sandbox-bin несколько версий хелперов: ${versions.join(", ")}`,
    health_sandbox_missing: (mode) =>
      `В config.toml включена песочница ([windows] sandbox = '${mode}'), но codex-windows-sandbox-setup.exe отсутствует`,
    health_sandbox_will_fail:
      "Любой прогон codex exec с песочницей упадёт; ошибка выглядит как «user cancelled MCP tool call».",
    health_sandbox_fix:
      "Переустановить Codex (npm install -g @openai/codex). Временный обход — включить настройку плагина bypass_sandbox, но тогда Codex выполняет команды без изоляции.",
    health_elevated_note:
      "Режим песочницы 'elevated' требует прав администратора: без них изоляция профилей отрабатывает не полностью (в логе — SetFileAttributesW ... Отказано в доступе).",
    health_unknown: "неизвестно",
    health_versions_unknown: "версии не определены",
    health_cli: (version) => `codex CLI: ${version}`,
    health_helpers: (versions, windowsSetup) =>
      `хелперы:   ${versions}` +
      (windowsSetup === null ? "" : `, windows-sandbox-setup: ${windowsSetup ? "есть" : "ОТСУТСТВУЕТ"}`),
    health_sandbox: (mode) => `песочница: [windows] sandbox = '${mode}'`,
    health_problem: (what) => `ПРОБЛЕМА: ${what}`,
    health_solution: (fix) => `  Решение: ${fix}`,
    health_note: (note) => `Примечание: ${note}`,
    health_consistent: "установка Codex выглядит согласованной",

    chat_invalid_name: (slug) => `Недопустимое имя чата: ${JSON.stringify(slug)}`,
    chat_path_outside: (slug) => `Путь чата вышел за пределы каталога: ${slug}`,
    chat_busy: (slug) => `Чат "${slug}" сейчас занят другим ходом. Дождись ответа или начни новый чат.`,
    chat_stale_lock: (slug) => `Не удалось снять устаревший замок чата "${slug}".`,
    status_starting: "запускается",

    mcp_parse_error: "Ошибка разбора JSON",
    mcp_batches_unsupported: "Батчи не поддерживаются в протоколе 2025-06-18",
    mcp_not_an_object: "Неверный запрос: сообщение JSON-RPC обязано быть объектом",
    mcp_line_too_long: (limit) => `Неверный запрос: сообщение превышает предел ${limit} байт`,
    mcp_method_not_found: (method) => `Метод не найден: ${method}`,

    worker_spec_missing: "job-worker: не передан путь к spec\n",
    worker_exit_code_write_failed: (error) => `job-worker: не удалось записать код возврата: ${error}\n`,
    worker_spawn_failed: (error) => `не удалось запустить Codex: ${error}`,
    worker_prompt_read_failed: (error) => `job-worker: промпт не прочитан: ${error}\n`,
    worker_timeout: (seconds) => `таймаут задачи: ${seconds}с`,
    worker_log_truncated: (mb) =>
      `[журнал достиг предела ${mb} МиБ; дальнейший потоковый вывод не пишется]`,
    app_server_spawn_failed: (error) => `не удалось запустить codex app-server: ${error}`,
    app_server_signal: (signal) => `сигнал ${signal}`,
    app_server_code: (code) => `код ${code}`,
    app_server_exited: (how) => `codex app-server завершился (${how})`,
    app_server_closed: "соединение с codex app-server закрыто",
    app_server_request_timeout: (method) => `таймаут codex app-server на ${method}`,
    app_server_bad_json: "codex app-server вернул некорректную строку JSONL",
    app_server_rpc_failed: (method) => `codex app-server отклонил ${method}`,
    app_server_server_request_unsupported: (method) => `Неподдерживаемый запрос app-server: ${method}`,
    app_server_custom_base_focus: (base, focus) =>
      `Проведи ревью изменений относительно базовой ветки ${base}. Особое внимание: ${focus}`,
    app_server_custom_focus: (focus) => `Проведи ревью незакоммиченных изменений. Особое внимание: ${focus}`,
    app_server_missing_thread: "codex app-server не вернул идентификатор треда",
    app_server_missing_turn: "codex app-server принял review/start без идентификатора turn",
    app_server_cancelled_before_accept: "ревью codex app-server отменено до ответа review/start",
    app_server_review_failed: (status) => `ревью codex app-server завершилось со статусом ${status}`,
    app_server_fallback: (error) =>
      `codex app-server отказал до принятия review/start; используется запасной codex exec: ${error}`,

    setup_bad_args: (error) => `Неверные аргументы: ${error}`,
    setup_usage:
      "Доступно: --expose-list | --expose <сервер> [--tools a,b] | --unexpose <сервер> |\n" +
      "          --allow-task [--task-tools a,b] | --deny-task | --link-back | --unlink-back",
    setup_mutually_exclusive: (a, b) => `Нельзя указывать одновременно --${a} и --${b}.`,
    setup_codex_missing: (bin) => `codex:    НЕ НАЙДЕН (${bin})`,
    setup_codex_install: "          установка: npm install -g @openai/codex",
    setup_codex_installed: "установлен",
    setup_authorized: "авторизован",
    setup_auth_ok: (info) => `auth:     OK (${info})`,
    setup_auth_no: "auth:     НЕТ — выполни: codex login",
    setup_claude_missing: "claude:   не найден в PATH (обратный мост GPT→Claude работать не будет)",
    setup_claude_version: (version) => `claude:   ${version}`,
    setup_jobs: (dir) => `джобы:    ${dir}`,
    setup_models: (count, source, sample, more) =>
      `модели:   ${count} шт. (${source}) — ${sample}${more ? ", …" : ""}`,
    setup_models_failed: (error) => `модели:   не удалось получить — ${error}`,
    setup_bypass_warning:
      "ВНИМАНИЕ: включён bypass_sandbox — Codex выполняет команды без изоляции. Это аварийный режим; после починки установки Codex выключите его.",
    setup_images: (dir) => `изображения → ${dir} (встроенный image_gen, без API-ключа)`,
    setup_back_bridge: (linked) =>
      `мост GPT→Claude: ${linked ? "подключён" : "не подключён (включить: /tandem:setup --link-back)"}`,
    setup_path_stale: "          путь устарел, будет исправлен при следующем старте сессии",
    setup_proxy_summary: (names, allowTask) =>
      `проброс в Codex: ${names.length ? names.join(", ") : "ничего не проброшено"}` +
      (allowTask ? " | claude_task включён" : ""),
    setup_servers_header: "MCP-серверы, найденные в конфигах Claude Code:",
    setup_servers_none: "  (ничего не найдено в ~/.claude.json и ./.mcp.json)",
    setup_transport_unsupported: "  — не поддерживается (только stdio)",
    setup_already_exposed: "  [уже проброшен]",
    setup_expose_hint: "Пробросить:  /tandem:setup --expose <имя> [--tools a,b,c]",
    setup_server_not_found: (name) => `Сервер "${name}" не найден. Список: /tandem:setup --expose-list`,
    setup_server_transport: (name, transport) =>
      `Сервер "${name}" использует транспорт ${transport}. Мост умеет только stdio: ` +
      "HTTP/SSE-серверы с собственной авторизацией нужно подключать к Codex напрямую в ~/.codex/config.toml.",
    setup_env_dropped: (names) =>
      `Переменные окружения ${names.join(", ")} НЕ скопированы: их значения заданы литералами и могут содержать секреты. ` +
      "Задайте их через ${VAR} в конфиге Claude или в окружении Codex.",
    setup_server_exposed: (name, tools) => `Сервер "${name}" проброшен в Codex (${tools || "все инструменты"}).`,
    setup_exposed_written: (file) => `Записано в ${file}. Перезапусти Codex, чтобы он увидел инструменты.`,
    setup_server_unexposed: (name) => `Сервер "${name}" больше не пробрасывается.`,
    setup_task_enabled: (tools) =>
      `claude_task включён. Codex сможет поручать задачи Claude Code${tools ? ` с инструментами: ${tools}` : ""}.`,
    setup_task_disabled: "claude_task выключен.",
    setup_back_added: (file) => `Обратный мост добавлен в ${file}`,
    setup_back_updated: (file) => `Обратный мост обновлён в ${file}`,
    setup_back_removed: (file) => `Обратный мост удалён из ${file}`,
    setup_back_not_found: "Блок tandem в config.toml не найден.",
    setup_config_not_found: "config.toml не найден — нечего удалять.",

    proxy_stdio_required: (alias) => `${alias}: пропущен, поддерживаются только stdio-серверы (нужно поле command)`,
    proxy_no_tools: (alias) => `${alias}: подключён, но ни один инструмент не разрешён allowlist'ом`,
    proxy_description_prefix: (alias) => `[через Claude Code · сервер ${alias}] `,
    proxy_description_default: "Инструмент, проброшенный из MCP-окружения Claude.",
    proxy_not_exposed: (name) => `Инструмент ${name} не проброшен.`,

    client_timeout: (alias, method) => `${alias}: таймаут на ${method}`,
    client_server_exited: (alias, how) => `${alias}: процесс сервера завершился (${how})`,
    client_signal: (signal) => `сигнал ${signal}`,
    client_code: (code) => `код ${code}`,
    client_unavailable: (alias) => `${alias}: сервер недоступен`,

    linkback_managed_block:
      "# Управляется плагином tandem. Путь обновляется автоматически при\n" +
      "# обновлении плагина — правки внутри блока будут перезаписаны.",
    linkback_conflict: (configPath, table) =>
      `В ${configPath} уже есть таблица [${table}], объявленная не этим плагином. ` +
      `Добавление второй сделало бы файл невалидным TOML. Удалите или переименуйте существующую таблицу и повторите.`,

    preflight_path_updated: (from, to) =>
      `[tandem] Путь обратного моста в ~/.codex/config.toml обновлён после обновления плагина.\n` +
      `  было: ${from}\n  стало: ${to}\n  Перезапусти Codex, чтобы он подхватил новый путь.`,
    preflight_check_failed: (reason) => `[tandem] Не удалось проверить обратный мост: ${reason}`,
    preflight_not_installed: "[tandem] Codex CLI не найден. Установка: npm install -g @openai/codex, затем codex login.",
    preflight_not_logged_in: "[tandem] Codex установлен, но не авторизован. Выполни: codex login",
    preflight_probe_timeout:
      "[tandem] Проверка готовности Codex не завершилась за отведённое время. Сам Codex может быть исправен; проверь вручную: codex login status",
  },
};

export function message(key, ...args) {
  const table = { ...MESSAGES.en, ...(MESSAGES[lang()] || {}) };
  const value = table[key];
  if (typeof value === "function") return value(...args);
  if (typeof value === "string") return value;
  throw new Error(`Unknown runtime message: ${key}`);
}
