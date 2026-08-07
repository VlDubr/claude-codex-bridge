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
import { message } from "./i18n-runtime.mjs";

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
        what: message("health_version_mismatch", cliVersion, bin.versions),
        why: message("health_mixed_install"),
        fix: message("health_reinstall", bin.dir),
      });
    }
    if (bin.versions.length > 1) {
      notes.push(message("health_multiple_helpers", bin.versions));
    }
  }

  if (isWindows && sandboxMode && sandboxMode !== "none") {
    if (!bin.hasWindowsSetup) {
      problems.push({
        what: message("health_sandbox_missing", sandboxMode),
        why: message("health_sandbox_will_fail"),
        fix: message("health_sandbox_fix"),
      });
    }
    if (sandboxMode === "elevated") {
      notes.push(message("health_elevated_note"));
    }
  }

  return { cliVersion: cliVersion || ver || null, isWindows, sandboxMode, bin, problems, notes };
}

export function format(r) {
  const lines = [];
  lines.push(message("health_cli", r.cliVersion || message("health_unknown")));
  if (r.bin.exists) {
    lines.push(message(
      "health_helpers",
      r.bin.versions.length ? r.bin.versions.join(", ") : message("health_versions_unknown"),
      r.isWindows ? r.bin.hasWindowsSetup : null
    ));
  }
  if (r.sandboxMode) lines.push(message("health_sandbox", r.sandboxMode));

  for (const p of r.problems) {
    lines.push("", message("health_problem", p.what), `  ${p.why}`, message("health_solution", p.fix));
  }
  for (const n of r.notes) lines.push("", message("health_note", n));
  if (!r.problems.length) lines.push(message("health_consistent"));
  return lines.join("\n");
}
