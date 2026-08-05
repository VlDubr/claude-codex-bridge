#!/usr/bin/env node
// job-worker.mjs — отдельный процесс, который ведёт один запуск Codex.
//
// Зачем нужен: раньше фоновая задача была строкой для `/bin/sh`, а синхронный
// вызов — отдельной веткой на spawnSync. Отсюда два дефекта: на Windows фон не
// работал вовсе, а синхронный вызов блокировал event loop MCP-сервера, и клиент
// рвал соединение. Теперь путь один: MCP всегда поднимает воркер и читает его
// журнал. Перезапуск MCP-сервера работу не прерывает.
//
// Запуск: node job-worker.mjs <spec.json>
// spec: { bin, args, promptFile, outFile, codeFile, noteFile, cwd, timeoutMs }

import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { killTree } from "./proc.mjs";

const FILE_MODE = 0o600;

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write("job-worker: не передан путь к spec\n");
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const out = fs.createWriteStream(spec.outFile, { flags: "a", mode: FILE_MODE });
const append = (line) => out.write(`${line}\n`);

/** Финал пишется атомарно: код возврата — единственный признак завершения. */
let finished = false;
function finish(code, note) {
  if (finished) return;
  finished = true;
  try {
    if (note) {
      fs.writeFileSync(`${spec.noteFile}.tmp`, note, { mode: FILE_MODE });
      fs.renameSync(`${spec.noteFile}.tmp`, spec.noteFile);
    }
  } catch {}
  try {
    fs.writeFileSync(`${spec.codeFile}.tmp`, String(code), { mode: FILE_MODE });
    fs.renameSync(`${spec.codeFile}.tmp`, spec.codeFile);
  } catch (e) {
    process.stderr.write(`job-worker: не удалось записать код возврата: ${e?.message || e}\n`);
  }
  out.end(() => process.exit(0));
}

const child = spawn(spec.bin, spec.args, {
  cwd: spec.cwd || process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32", // своя группа процессов — чтобы убить всё дерево
  windowsHide: true,
});

child.on("error", (e) => {
  // Отказ запуска — это failed с причиной, а не «процесс исчез».
  append(JSON.stringify({ type: "turn.failed", error: { message: `не удалось запустить Codex: ${e?.message || e}` } }));
  finish(127, "spawn_failed");
});

// Промпт уходит через stdin: аргументы командной строки ограничены по длине,
// а диф ревью легко превышает лимит.
try {
  const prompt = fs.readFileSync(spec.promptFile);
  child.stdin.write(prompt);
  child.stdin.end();
} catch (e) {
  process.stderr.write(`job-worker: промпт не прочитан: ${e?.message || e}\n`);
}
child.stdin.on("error", () => {}); // закрытый stdin не должен ронять воркер

// Метку времени ставит воркер: сам Codex её в событиях не передаёт.
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  if (t.startsWith("{")) {
    try {
      const e = JSON.parse(t);
      if (e && typeof e === "object") return append(JSON.stringify({ ...e, _ts: new Date().toISOString() }));
    } catch {}
  }
  append(t); // не JSON — сохраняем как есть, деградация без потери вывода
});

readline.createInterface({ input: child.stderr }).on("line", (line) => {
  if (line.trim()) append(line);
});

const limit = Number(spec.timeoutMs) || 0;
const timer = limit > 0 ? setTimeout(() => {
  append(JSON.stringify({ type: "turn.failed", error: { message: `таймаут задачи: ${Math.round(limit / 1000)}с` } }));
  killTree(child.pid);
  finish(124, "timeout");
}, limit) : null;

child.on("exit", (code, signal) => {
  if (timer) clearTimeout(timer);
  finish(code === null ? (signal ? 143 : 1) : code, signal ? `signal:${signal}` : null);
});

// Отмена приходит сигналом от cancelJob: дочернее дерево надо унести с собой.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (timer) clearTimeout(timer);
    killTree(child.pid);
    finish(130, "cancelled");
  });
}
