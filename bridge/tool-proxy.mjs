// tool-proxy.mjs — читает allowlist, поднимает разрешённые MCP-серверы Claude
// и переэкспортирует их инструменты под префиксом, чтобы их увидел Codex.
//
// Ничего не экспортируется без явного разрешения: файл allowlist создаётся
// только командой /codex-bridge:setup --expose <server>.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpStdioClient } from "./mcp-client.mjs";
import { message } from "../scripts/i18n-runtime.mjs";

const cleanEnv = (n) => {
  const v = process.env[n];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return !t || /^\$\{.*\}$/.test(t) ? undefined : t;
};

export const EXPOSED_PATH =
  cleanEnv("CODEX_BRIDGE_EXPOSED") || path.join(os.homedir(), ".codex", "codex-bridge", "exposed.json");

export function readExposed() {
  try {
    const cfg = JSON.parse(fs.readFileSync(EXPOSED_PATH, "utf8"));
    return {
      servers: cfg.servers || {},
      allowTask: cfg.allow_task === true,
      taskTools: cfg.task_tools || null,
    };
  } catch {
    return { servers: {}, allowTask: false, taskTools: null };
  }
}

export function writeExposed(cfg) {
  const dir = path.dirname(EXPOSED_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  const tmp = `${EXPOSED_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, EXPOSED_PATH);
  return EXPOSED_PATH;
}

/**
 * Значения env хранятся как ссылки (${VAR}), а не раскрытыми: копировать в
 * свой файл чужие токены нельзя. Раскрытие происходит при запуске сервера.
 * Поддерживается синтаксис Claude Code: ${VAR} и ${VAR:-default}.
 */
export function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, def) =>
    process.env[name] !== undefined ? process.env[name] : def !== undefined ? def : ""
  );
}

function expandEnvMap(env = {}) {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandEnv(v)]));
}

/** Оставляет только ссылки на переменные, отбрасывая литеральные секреты. */
export function sanitizeEnv(env = {}) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(v)) out[k] = v;
    else dropped.push(k);
  }
  return { env: out, dropped };
}

const SEP = "__";

/** Разрешён ли конкретный инструмент сервера. */
function toolAllowed(entry, toolName) {
  const list = entry.tools;
  if (!list || list.includes("*")) return true;
  return list.includes(toolName);
}

export class ToolProxy {
  constructor({ cwd } = {}) {
    this.cwd = cwd || process.cwd();
    this.clients = new Map(); // alias -> McpStdioClient
    this.routes = new Map(); // публичное имя -> { alias, tool }
    this.errors = [];
  }

  /** Поднимает все разрешённые серверы. Падение одного не ломает остальные. */
  async start() {
    const { servers } = readExposed();
    for (const [alias, entry] of Object.entries(servers)) {
      if (entry.enabled === false) continue;
      if (!entry.command) {
        this.errors.push(message("proxy_stdio_required", alias));
        continue;
      }
      const client = new McpStdioClient({
        alias,
        command: entry.command,
        args: entry.args || [],
        env: expandEnvMap(entry.env || {}),
        cwd: this.cwd,
        timeoutMs: entry.timeout_ms || 60_000,
      });
      try {
        const tools = await client.start();
        let n = 0;
        for (const t of tools) {
          if (!toolAllowed(entry, t.name)) continue;
          this.routes.set(`${alias}${SEP}${t.name}`, { alias, tool: t.name, schema: t });
          n++;
        }
        this.clients.set(alias, client);
        if (n === 0) this.errors.push(message("proxy_no_tools", alias));
      } catch (e) {
        this.errors.push(`${alias}: ${e.message || e}`);
        client.stop();
      }
    }
    return this;
  }

  /** Описания инструментов в формате MCP, с префиксом сервера. */
  toolDescriptors() {
    return [...this.routes.entries()].map(([publicName, r]) => ({
      name: publicName,
      description:
        message("proxy_description_prefix", r.alias) +
        (r.schema.description || message("proxy_description_default")),
      inputSchema: r.schema.inputSchema || { type: "object", properties: {} },
    }));
  }

  has(name) {
    return this.routes.has(name);
  }

  async call(name, args) {
    const route = this.routes.get(name);
    if (!route) throw new Error(message("proxy_not_exposed", name));
    const client = this.clients.get(route.alias);
    return client.call(route.tool, args);
  }

  stop() {
    for (const c of this.clients.values()) c.stop();
  }
}

// ------------------------------------------------- обнаружение серверов Claude

/** Собирает MCP-серверы из конфигов Claude Code, чтобы было из чего выбирать. */
export function discoverClaudeServers(projectDir = process.cwd()) {
  const found = {};

  // Порядок соответствует precedence Claude Code: local, затем project,
  // затем user. Первый добавленный выигрывает, поэтому источники читаются
  // именно в этой последовательности.
  const add = (name, def, origin) => {
    if (!def || found[name]) return;
    found[name] = {
      command: def.command || null,
      args: def.args || [],
      env: def.env || {},
      transport: def.command ? "stdio" : def.url ? def.type || "http" : "unknown",
      url: def.url || null,
      origin,
    };
  };

  const home = os.homedir();
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };

  // 1. local — .claude/settings.local.json проекта
  const local = readJson(path.join(projectDir, ".claude", "settings.local.json"));
  for (const [n, d] of Object.entries(local?.mcpServers || {})) add(n, d, "settings.local.json (local)");

  // 2. project — .mcp.json и .claude/settings.json
  for (const f of [path.join(projectDir, ".mcp.json"), path.join(projectDir, ".claude", "settings.json")]) {
    const j = readJson(f);
    for (const [n, d] of Object.entries(j?.mcpServers || {})) add(n, d, `${path.basename(f)} (project)`);
  }

  // 3. user — ~/.claude.json (в т.ч. секция конкретного проекта) и ~/.claude/settings.json
  const uj = readJson(path.join(home, ".claude.json"));
  for (const [n, d] of Object.entries(uj?.projects?.[projectDir]?.mcpServers || {}))
    add(n, d, "~/.claude.json (project section)");
  for (const [n, d] of Object.entries(uj?.mcpServers || {})) add(n, d, "~/.claude.json (user)");
  const us = readJson(path.join(home, ".claude", "settings.json"));
  for (const [n, d] of Object.entries(us?.mcpServers || {})) add(n, d, "~/.claude/settings.json (user)");

  return found;
}
