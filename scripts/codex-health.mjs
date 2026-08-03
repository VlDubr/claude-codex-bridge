// codex-health.mjs — диагностика установки Codex.
//
// Существует из-за конкретного случая: песочница Windows не запускалась,
// потому что хелперы в ~/.codex/.sandbox-bin были от версий 0.145–0.146-alpha,
// а сам CLI — 0.144.6. Наружу это выходило как «user cancelled MCP tool call»,
// то есть выглядело отказом пользователя, и увело диагностику в сторону.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codexBinary, envClean } from "./codex-core.mjs";

const codexHome = () => envClean("CODEX_HOME") || path.join(os.homedir(), ".codex");

/**
 * Вытаскивает версию из имени бинаря вида
 * codex-command-runner-0.145.0-alpha.18.exe.
 * Расширение снимаем заранее: иначе suffix-часть жадно проглатывает ".exe".
 */
function versionFromName(name) {
  const base = String(name).replace(/\.(exe|cmd|bat|sh|ps1)$/i, "");
  const m = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/.exec(base);
  return m ? m[1] : null;
}

function majorMinor(v) {
  const m = /^(\d+)\.(\d+)\./.exec(v || "");
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Читает `[windows] sandbox = '...'` из config.toml.
 * Разбор построчный: границу секции TOML регуляркой надёжно не поймать.
 */
export function windowsSandboxMode() {
  let text;
  try {
    text = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
  } catch {
    return null;
  }
  let inWindows = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[/.test(line)) {
      inWindows = /^\[windows\]$/i.test(line);
      continue;
    }
    if (!inWindows) continue;
    const m = /^sandbox\s*=\s*['"]([^'"]+)['"]/.exec(line);
    if (m) return m[1];
  }
  return null;
}

export function inspectSandboxBin() {
  const dir = path.join(codexHome(), ".sandbox-bin");
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { dir, exists: false, files: [], versions: [], hasWindowsSetup: false };
  }
  const versions = [...new Set(files.map(versionFromName).filter(Boolean))];
  return {
    dir,
    exists: true,
    files,
    versions,
    hasWindowsSetup: files.some((f) => /windows-sandbox-setup/i.test(f)),
  };
}

/**
 * Сводка о согласованности установки. Возвращает список проблем — каждая с
 * готовым действием, а не с констатацией факта.
 */
export function inspect() {
  const problems = [];
  const notes = [];

  const ver = (spawnSync(codexBinary(), ["--version"], { encoding: "utf8" }).stdout || "").trim();
  const cliVersion = versionFromName(ver);
  const isWindows = process.platform === "win32";
  const bin = inspectSandboxBin();
  const sandboxMode = isWindows ? windowsSandboxMode() : null;

  if (bin.exists && bin.versions.length) {
    const foreign = bin.versions.filter((v) => majorMinor(v) !== majorMinor(cliVersion));
    if (cliVersion && foreign.length) {
      problems.push({
        what: `Рассинхрон версий: CLI ${cliVersion}, хелперы в .sandbox-bin — ${bin.versions.join(", ")}`,
        why: "Смешанная установка ломает песочницу, а сбой выходит наружу как отказ MCP-инструмента.",
        fix: "Переустановить Codex целиком: npm install -g @openai/codex — затем удалить устаревшие бинари из " + bin.dir,
      });
    }
    if (bin.versions.length > 1) {
      notes.push(`В .sandbox-bin несколько версий хелперов: ${bin.versions.join(", ")}`);
    }
  }

  if (isWindows && sandboxMode && sandboxMode !== "none") {
    if (!bin.hasWindowsSetup) {
      problems.push({
        what: `В config.toml включена песочница ([windows] sandbox = '${sandboxMode}'), но codex-windows-sandbox-setup.exe отсутствует`,
        why: "Любой прогон codex exec с песочницей упадёт; ошибка выглядит как «user cancelled MCP tool call».",
        fix:
          "Переустановить Codex (npm install -g @openai/codex). Временный обход — включить настройку плагина " +
          "bypass_sandbox, но тогда Codex выполняет команды без изоляции.",
      });
    }
    if (sandboxMode === "elevated") {
      notes.push(
        "Режим песочницы 'elevated' требует прав администратора: без них изоляция профилей отрабатывает не полностью " +
          "(в логе — SetFileAttributesW ... Отказано в доступе)."
      );
    }
  }

  return { cliVersion: cliVersion || ver || null, isWindows, sandboxMode, bin, problems, notes };
}

export function format(r) {
  const lines = [];
  lines.push(`codex CLI: ${r.cliVersion || "неизвестно"}`);
  if (r.bin.exists) {
    lines.push(
      `хелперы:   ${r.bin.versions.length ? r.bin.versions.join(", ") : "версии не определены"}` +
        `${r.isWindows ? `, windows-sandbox-setup: ${r.bin.hasWindowsSetup ? "есть" : "ОТСУТСТВУЕТ"}` : ""}`
    );
  }
  if (r.sandboxMode) lines.push(`песочница: [windows] sandbox = '${r.sandboxMode}'`);

  for (const p of r.problems) {
    lines.push("", `ПРОБЛЕМА: ${p.what}`, `  ${p.why}`, `  Решение: ${p.fix}`);
  }
  for (const n of r.notes) lines.push("", `Примечание: ${n}`);
  if (!r.problems.length) lines.push("установка Codex выглядит согласованной");
  return lines.join("\n");
}
