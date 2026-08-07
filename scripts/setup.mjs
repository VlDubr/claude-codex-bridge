#!/usr/bin/env node
// Диагностика окружения + регистрация обратного MCP-моста в ~/.codex/config.toml

import fs from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkCodex, dataDir, envClean, bypassSandboxEnabled as bypassOn } from "./codex-core.mjs";
import { fetchModels } from "./models.mjs";
import { inspect as inspectCodex, format as formatCodex } from "./codex-health.mjs";
import { link, unlink, isLinked, linkedPath, bridgePath, CONFIG_PATH } from "./link-back.mjs";
import { message } from "./i18n-runtime.mjs";
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
  console.error(message("setup_bad_args", e.message));
  console.error(message("setup_usage"));
  process.exit(2);
}

// Взаимоисключающие пары отвергаем, а не выполняем обе.
for (const [a, b] of [
  ["link-back", "unlink-back"],
  ["allow-task", "deny-task"],
]) {
  if (opts[a] && opts[b]) {
    console.error(message("setup_mutually_exclusive", a, b));
    process.exit(2);
  }
}

// ------------------------------------------------------------------- вывод

const lines = [];
const c = checkCodex();

lines.push(`node:     ${process.version}`);
if (c.reason === "not_installed") {
  lines.push(message("setup_codex_missing", c.bin));
  lines.push(message("setup_codex_install"));
} else {
  lines.push(`codex:    ${c.version || message("setup_codex_installed")}`);
  lines.push(
    c.ok
      ? message("setup_auth_ok", c.authInfo.split("\n")[0] || message("setup_authorized"))
      : message("setup_auth_no")
  );
}

const claudeBin = spawnSync(envClean("CLAUDE_BIN") || "claude", ["--version"], { encoding: "utf8" });
lines.push(
  claudeBin.error
    ? message("setup_claude_missing")
    : message("setup_claude_version", (claudeBin.stdout || "").trim())
);

lines.push(message("setup_jobs", dataDir()));

const mr = fetchModels();
lines.push(
  mr.ok
    ? message(
        "setup_models",
        mr.models.length,
        mr.source,
        mr.models.slice(0, 4).map((m) => m.id).join(", "),
        mr.models.length > 4
      )
    : message("setup_models_failed", mr.error.split("\n")[0])
);
const health = inspectCodex();
lines.push("", formatCodex(health), "");
if (bypassOn()) {
  lines.push(message("setup_bypass_warning"));
}
lines.push(message("setup_images", envClean("CODEX_BRIDGE_IMAGE_DIR") || "assets/generated"));

const back = isLinked();
lines.push(message("setup_back_bridge", back));
if (back && linkedPath() !== bridgePath()) {
  lines.push(message("setup_path_stale"));
}

// ------------------------------------------- проброс инструментов Claude в Codex

const exposed = readExposed();
const exposedNames = Object.keys(exposed.servers);
lines.push(message("setup_proxy_summary", exposedNames, exposed.allowTask));

if (opts["expose-list"]) {
  const avail = discoverClaudeServers(envClean("CLAUDE_PROJECT_DIR") || process.cwd());
  lines.push("", message("setup_servers_header"));
  const names = Object.keys(avail);
  if (!names.length) {
    lines.push(message("setup_servers_none"));
  } else {
    for (const n of names) {
      const a = avail[n];
      const ok = a.transport === "stdio";
      lines.push(
        `  ${n.padEnd(20)} ${a.transport}${ok ? "" : message("setup_transport_unsupported")}` +
          `${exposed.servers[n] ? message("setup_already_exposed") : ""}`
      );
    }
    lines.push("", message("setup_expose_hint"));
  }
}

const toExpose = opts.expose;
if (toExpose) {
  const avail = discoverClaudeServers(envClean("CLAUDE_PROJECT_DIR") || process.cwd());
  const def = avail[toExpose];
  if (!def) {
    lines.push("", message("setup_server_not_found", toExpose));
  } else if (def.transport !== "stdio") {
    lines.push(
      "",
      message("setup_server_transport", toExpose, def.transport)
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
        message("setup_env_dropped", dropped)
      );
    }
    writeExposed({ servers: exposed.servers, allow_task: exposed.allowTask, task_tools: exposed.taskTools });
    lines.push(
      "",
      message("setup_server_exposed", toExpose, toolsFlag),
      message("setup_exposed_written", EXPOSED_PATH)
    );
  }
}

const toUnexpose = opts.unexpose;
if (toUnexpose) {
  delete exposed.servers[toUnexpose];
  writeExposed({ servers: exposed.servers, allow_task: exposed.allowTask, task_tools: exposed.taskTools });
  lines.push("", message("setup_server_unexposed", toUnexpose));
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
      ? message("setup_task_enabled", tf)
      : message("setup_task_disabled")
  );
}

if (opts["link-back"]) {
  const r = link();
  if (r.action === "conflict") {
    lines.push("", r.error);
    process.exitCode = 1;
  } else {
    lines.push(
      "",
      message(r.action === "added" ? "setup_back_added" : "setup_back_updated", CONFIG_PATH),
      `  ${r.bridge}`
    );
  }
}
if (opts["unlink-back"]) {
  const r = unlink();
  lines.push(
    "",
    {
      removed: message("setup_back_removed", CONFIG_PATH),
      "not-found": message("setup_back_not_found"),
      "no-config": message("setup_config_not_found"),
    }[r.action]
  );
}

console.log(lines.join("\n"));
