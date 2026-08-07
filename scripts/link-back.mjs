// link-back.mjs — регистрация обратного моста в ~/.codex/config.toml.
//
// Файл принадлежит пользователю, поэтому все правки: только внутри
// маркированного блока, с атомарной записью и проверкой на конфликт с
// существующей неуправляемой таблицей [mcp_servers.claude-bridge].

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lang } from "./i18n.mjs";
import { message } from "./i18n-runtime.mjs";

const envClean = (n) => {
  const v = process.env[n];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return !t || /^\$\{.*\}$/.test(t) ? undefined : t;
};

export const CONFIG_PATH = envClean("CODEX_BRIDGE_CONFIG") || path.join(os.homedir(), ".codex", "config.toml");

const MARK_START = "# >>> codex-bridge (claude) >>>";
const MARK_END = "# <<< codex-bridge (claude) <<<";
const SERVER_TABLE = "mcp_servers.claude-bridge";

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Глобальная: блоков может оказаться несколько, если старая версия их наплодила.
const blockRe = () => new RegExp(`\\n?${esc(MARK_START)}[\\s\\S]*?${esc(MARK_END)}\\n?`, "g");

export function pluginRoot() {
  return envClean("CLAUDE_PLUGIN_ROOT") || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function bridgePath(root = pluginRoot()) {
  return path.join(root, "bridge", "mcp-claude.mjs");
}

/** Строка TOML: экранируем и кавычку, и обратный слеш, и управляющие символы. */
function tomlString(s) {
  const escaped = String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function block(bridge) {
  return `${MARK_START}
${message("linkback_managed_block")}
[${SERVER_TABLE}]
command = "node"
args = [${tomlString(bridge)}]
env = { CODEX_BRIDGE_LANG = ${tomlString(lang())} }
${MARK_END}`;
}

function read() {
  try {
    return fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return null;
  }
}

function stripBlocks(text) {
  return text.replace(blockRe(), "\n");
}

/** Есть ли объявление нашей таблицы ВНЕ управляемого блока. */
function foreignTable(text) {
  const outside = stripBlocks(text);
  return /^\s*\[\s*mcp_servers\s*\.\s*(?:claude-bridge|"claude-bridge")\s*\]/m.test(outside);
}

function writeAtomic(content) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.codex-bridge.${process.pid}.tmp`;
  let mode = 0o600;
  try {
    mode = fs.statSync(CONFIG_PATH).mode & 0o777;
  } catch {}
  try {
    fs.writeFileSync(tmp, content, { mode });
    // writeFile's mode не применяется, если временный файл уже существовал.
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, CONFIG_PATH);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function isLinked() {
  const cur = read();
  return Boolean(cur && blockRe().test(cur));
}

export function linkedPath() {
  const cur = read();
  if (!cur) return null;
  const m = new RegExp(`${esc(MARK_START)}[\\s\\S]*?${esc(MARK_END)}`, "m").exec(cur);
  if (!m) return null;
  const raw = /args\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/.exec(m[0])?.[1];
  if (raw === undefined) return null;
  return raw.replace(/\\(["\\nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] || c);
}

function hasCurrentLanguage() {
  const cur = read();
  if (!cur) return false;
  const managed = new RegExp(`${esc(MARK_START)}[\\s\\S]*?${esc(MARK_END)}`, "m").exec(cur)?.[0];
  return Boolean(managed?.includes(`env = { CODEX_BRIDGE_LANG = ${tomlString(lang())} }`));
}

export function link(root = pluginRoot()) {
  const bridge = bridgePath(root);
  const cur = read() || "";

  if (foreignTable(cur)) {
    return {
      action: "conflict",
      error:
        message("linkback_conflict", CONFIG_PATH, SERVER_TABLE),
    };
  }

  const had = blockRe().test(cur);
  // Удаляем ВСЕ управляемые блоки (их могло остаться несколько), затем дописываем один.
  const base = stripBlocks(cur).replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  const sep = base && !base.endsWith("\n") ? "\n\n" : base ? "\n" : "";
  writeAtomic(base + sep + block(bridge) + "\n");
  return { action: had ? "updated" : "added", bridge };
}

export function unlink() {
  const cur = read();
  if (cur === null) return { action: "no-config" };
  if (!blockRe().test(cur)) return { action: "not-found" };
  writeAtomic(stripBlocks(cur).replace(/\n{3,}/g, "\n\n"));
  return { action: "removed" };
}

/**
 * ${CLAUDE_PLUGIN_ROOT} меняется при каждом обновлении плагина, а каталог
 * старой версии удаляется примерно через две недели. Поэтому путь сверяется
 * на каждом старте сессии.
 */
export function ensureFresh(root = pluginRoot()) {
  if (!isLinked()) return null;
  const want = bridgePath(root);
  const have = linkedPath();
  const pathChanged = have !== want;
  if (!pathChanged && hasCurrentLanguage()) return null;
  if (!fs.existsSync(want)) return null;
  const r = link(root);
  return r.action === "conflict" || !pathChanged ? null : { from: have, to: want };
}
