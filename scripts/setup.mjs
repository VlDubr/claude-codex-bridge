#!/usr/bin/env node
// Диагностика окружения + регистрация обратного MCP-моста в ~/.codex/config.toml

import fs from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkCodex, dataDir } from "./codex-core.mjs";
import { fetchModels } from "./models.mjs";
import { link, unlink, isLinked, linkedPath, bridgePath, CONFIG_PATH } from "./link-back.mjs";
import {
  readExposed,
  writeExposed,
  discoverClaudeServers,
  sanitizeEnv,
  EXPOSED_PATH,
} from "../bridge/tool-proxy.mjs";

// Строгий разбор: раньше значение бралось как args[i+1], поэтому
// "--tools --link-back" записывало флаг в качестве значения и одновременно
// выполняло его. parseArgs со strict такое отвергает.
let opts;
try {
  ({ values: opts } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      "link-back": { type: "boolean", default: false },
      "unlink-back": { type: "boolean", default: false },
      "expose-list": { type: "boolean", default: false },
      expose: { type: "string" },
      unexpose: { type: "string" },
      tools: { type: "string" },
      "allow-task": { type: "boolean", default: false },
      "deny-task": { type: "boolean", default: false },
      "task-tools": { type: "string" },
    },
  }));
} catch (e) {
  console.error(`Неверные аргументы: ${e.message}`);
  console.error(
    "Доступно: --expose-list | --expose <сервер> [--tools a,b] | --unexpose <сервер> |\n" +
      "          --allow-task [--task-tools a,b] | --deny-task | --link-back | --unlink-back"
  );
  process.exit(2);
}

// Взаимоисключающие пары отвергаем, а не выполняем обе.
for (const [a, b] of [
  ["link-back", "unlink-back"],
  ["allow-task", "deny-task"],
]) {
  if (opts[a] && opts[b]) {
    console.error(`Нельзя указывать одновременно --${a} и --${b}.`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------- вывод

const lines = [];
const c = checkCodex();

lines.push(`node:     ${process.version}`);
if (c.reason === "not_installed") {
  lines.push(`codex:    НЕ НАЙДЕН (${c.bin})`);
  lines.push(`          установка: npm install -g @openai/codex`);
} else {
  lines.push(`codex:    ${c.version || "установлен"}`);
  lines.push(c.ok ? `auth:     OK (${c.authInfo.split("\n")[0] || "авторизован"})` : `auth:     НЕТ — выполни: codex login`);
}

const claudeBin = spawnSync(process.env.CLAUDE_BIN || "claude", ["--version"], { encoding: "utf8" });
lines.push(
  claudeBin.error
    ? `claude:   не найден в PATH (обратный мост GPT→Claude работать не будет)`
    : `claude:   ${(claudeBin.stdout || "").trim()}`
);

lines.push(`джобы:    ${dataDir()}`);

const mr = fetchModels();
lines.push(
  mr.ok
    ? `модели:   ${mr.models.length} шт. (${mr.source}) — ${mr.models.slice(0, 4).map((m) => m.id).join(", ")}${mr.models.length > 4 ? ", …" : ""}`
    : `модели:   не удалось получить — ${mr.error.split("\n")[0]}`
);
lines.push(`изображения → ${process.env.CODEX_BRIDGE_IMAGE_DIR || "assets/generated"} (встроенный image_gen, без API-ключа)`);

const back = isLinked();
lines.push(`мост GPT→Claude: ${back ? "подключён" : "не подключён (включить: /codex:setup --link-back)"}`);
if (back && linkedPath() !== bridgePath()) {
  lines.push(`          путь устарел, будет исправлен при следующем старте сессии`);
}

// ------------------------------------------- проброс инструментов Claude в Codex

const exposed = readExposed();
const exposedNames = Object.keys(exposed.servers);
lines.push(
  `проброс в Codex: ${exposedNames.length ? exposedNames.join(", ") : "ничего не проброшено"}` +
    `${exposed.allowTask ? " | claude_task включён" : ""}`
);

if (opts["expose-list"]) {
  const avail = discoverClaudeServers(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  lines.push("", "MCP-серверы, найденные в конфигах Claude Code:");
  const names = Object.keys(avail);
  if (!names.length) {
    lines.push("  (ничего не найдено в ~/.claude.json и ./.mcp.json)");
  } else {
    for (const n of names) {
      const a = avail[n];
      const ok = a.transport === "stdio";
      lines.push(
        `  ${n.padEnd(20)} ${a.transport}${ok ? "" : "  — не поддерживается (только stdio)"}` +
          `${exposed.servers[n] ? "  [уже проброшен]" : ""}`
      );
    }
    lines.push("", "Пробросить:  /codex:setup --expose <имя> [--tools a,b,c]");
  }
}

const toExpose = opts.expose;
if (toExpose) {
  const avail = discoverClaudeServers(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const def = avail[toExpose];
  if (!def) {
    lines.push("", `Сервер "${toExpose}" не найден. Список: /codex:setup --expose-list`);
  } else if (def.transport !== "stdio") {
    lines.push(
      "",
      `Сервер "${toExpose}" использует транспорт ${def.transport}. Мост умеет только stdio: ` +
        `HTTP/SSE-серверы с собственной авторизацией нужно подключать к Codex напрямую в ~/.codex/config.toml.`
    );
  } else {
    const toolsFlag = opts.tools;
    const { env, dropped } = sanitizeEnv(def.env);
    exposed.servers[toExpose] = {
      command: def.command,
      args: def.args,
      env, // только ссылки ${VAR}; литеральные значения не копируем
      tools: toolsFlag ? toolsFlag.split(",").map((t) => t.trim()).filter(Boolean) : ["*"],
      enabled: true,
    };
    if (dropped.length) {
      lines.push(
        "",
        `Переменные окружения ${dropped.join(", ")} НЕ скопированы: их значения заданы литералами ` +
          `и могут содержать секреты. Задайте их через \${VAR} в конфиге Claude или в окружении Codex.`
      );
    }
    writeExposed({ servers: exposed.servers, allow_task: exposed.allowTask, task_tools: exposed.taskTools });
    lines.push(
      "",
      `Сервер "${toExpose}" проброшен в Codex (${toolsFlag || "все инструменты"}).`,
      `Записано в ${EXPOSED_PATH}. Перезапусти Codex, чтобы он увидел инструменты.`
    );
  }
}

const toUnexpose = opts.unexpose;
if (toUnexpose) {
  delete exposed.servers[toUnexpose];
  writeExposed({ servers: exposed.servers, allow_task: exposed.allowTask, task_tools: exposed.taskTools });
  lines.push("", `Сервер "${toUnexpose}" больше не пробрасывается.`);
}

if (opts["allow-task"] || opts["deny-task"]) {
  const on = opts["allow-task"];
  const tf = opts["task-tools"];
  writeExposed({
    servers: exposed.servers,
    allow_task: on,
    task_tools: tf ? tf.split(",").map((t) => t.trim()) : exposed.taskTools,
  });
  lines.push(
    "",
    on
      ? `claude_task включён. Codex сможет поручать задачи Claude Code${tf ? ` с инструментами: ${tf}` : ""}.`
      : "claude_task выключен."
  );
}

if (opts["link-back"]) {
  const r = link();
  lines.push("", `Обратный мост ${r.action === "added" ? "добавлен в" : "обновлён в"} ${CONFIG_PATH}`, `  ${r.bridge}`);
}
if (opts["unlink-back"]) {
  const r = unlink();
  lines.push(
    "",
    { removed: `Обратный мост удалён из ${CONFIG_PATH}`, "not-found": "Блок codex-bridge в config.toml не найден.", "no-config": "config.toml не найден — нечего удалять." }[r.action]
  );
}

console.log(lines.join("\n"));
