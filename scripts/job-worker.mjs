#!/usr/bin/env node
// job-worker.mjs — отдельный процесс, который ведёт один запуск Codex.
//
// Для exec он проксирует stdin/stdout как прежде. Для app-server worker сам
// держит JSON-RPC-соединение: поэтому ревью переживает перезапуск MCP-сервера,
// а отмена может дойти до принятого turn протокольным turn/interrupt.

import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { killTree } from "./proc.mjs";
import { STDOUT_LINE, STDERR_LINE } from "./codex-events.mjs";
import { runAppServerReviewWithFallback } from "./app-server.mjs";
import { message } from "./i18n-runtime.mjs";

const FILE_MODE = 0o600;
const CANCEL_POLL_MS = 100;

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write(message("worker_spec_missing"));
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const out = fs.createWriteStream(spec.outFile, { flags: "a", mode: FILE_MODE });
const append = (line) => out.write(`${line}\n`);
const stamp = () => new Date().toISOString();
const appendEvent = (event) => append(JSON.stringify({ ...event, _ts: event._ts || stamp() }));
const tagged = (type, text) => appendEvent({ type, text });

let finished = false;
let child = null;
let timer = null;
let cancelPoll = null;
let usingExec = false;
let cancelled = false;
let timedOut = false;
let appController = null;
let appSettled = false;

/** Финал пишется атомарно: код возврата — единственный признак завершения. */
function finish(code, note) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (cancelPoll) clearInterval(cancelPoll);
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
    process.stderr.write(message("worker_exit_code_write_failed", e?.message || e));
  }
  out.end(() => process.exit(0));
}

function cancellationRequested() {
  if (!spec.cancelFile) return false;
  try {
    return fs.existsSync(spec.cancelFile);
  } catch {
    return false;
  }
}

function requestCancellation() {
  if (finished || cancelled || appSettled) return;
  cancelled = true;
  if (usingExec) {
    killTree(child?.pid);
    finish(130, "cancelled");
  } else {
    appController?.abort();
  }
}

function installLifecycle() {
  cancelPoll = setInterval(() => {
    if (cancellationRequested()) requestCancellation();
  }, CANCEL_POLL_MS);
  cancelPoll.unref?.();

  const limit = Number(spec.timeoutMs) || 0;
  if (limit > 0) {
    timer = setTimeout(() => {
      if (finished || appSettled) return;
      timedOut = true;
      appendEvent({ type: "turn.failed", error: { message: message("worker_timeout", Math.round(limit / 1000)) } });
      if (usingExec) {
        killTree(child?.pid);
        finish(124, "timeout");
      } else {
        appController?.abort();
      }
    }, limit);
  }
}

/** Обычный exec-путь и fallback используют ровно один и тот же запуск. */
function runExec() {
  if (finished || cancelled || timedOut) {
    finish(timedOut ? 124 : 130, timedOut ? "timeout" : "cancelled");
    return;
  }
  usingExec = true;
  child = spawn(spec.bin, spec.args, {
    cwd: spec.cwd || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  child.on("error", (e) => {
    appendEvent({ type: "turn.failed", error: { message: message("worker_spawn_failed", e?.message || e) } });
    finish(127, "spawn_failed");
  });

  // Промпт уходит через stdin: аргументы командной строки ограничены по длине,
  // а диф ревью легко превышает лимит.
  try {
    const prompt = fs.readFileSync(spec.promptFile);
    child.stdin.write(prompt);
    child.stdin.end();
  } catch (e) {
    process.stderr.write(message("worker_prompt_read_failed", e?.message || e));
  }
  child.stdin.on("error", () => {});

  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    if (t.startsWith("{")) {
      try {
        const event = JSON.parse(t);
        if (event && typeof event === "object") return appendEvent(event);
      } catch {}
    }
    tagged(STDOUT_LINE, t);
  });

  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    const t = line.trim();
    if (t) tagged(STDERR_LINE, t);
  });

  child.on("exit", (code, signal) => {
    finish(code === null ? (signal ? 143 : 1) : code, signal ? `signal:${signal}` : null);
  });
}

function appendStderr(stderr) {
  for (const line of String(stderr || "").split(/\r?\n/)) {
    const text = line.trim();
    if (text) tagged(STDERR_LINE, text);
  }
}

async function runNativeReview() {
  appController = new AbortController();
  if (cancellationRequested()) requestCancellation();

  try {
    const result = await runAppServerReviewWithFallback(
      {
        bin: spec.bin,
        command: spec.appServerCommand,
        cwd: spec.cwd,
        model: spec.model,
        effort: spec.effort,
        reasoningSummary: spec.reasoningSummary,
        target: spec.reviewTarget || { type: "uncommittedChanges" },
        signal: appController.signal,
        onEvent: appendEvent,
        onSettled: () => {
          appSettled = true;
        },
      },
      async (error) => {
        if (cancelled || timedOut || appController.signal.aborted) return { cancelled: true, fallback: false };
        appendStderr(error?.stderr);
        tagged(STDERR_LINE, message("app_server_fallback", error?.message || error));
        return { fallback: true };
      }
    );

    appendStderr(result.stderr);
    if (result.fallback) {
      runExec();
      return;
    }
    if (timedOut) {
      finish(124, "timeout");
      return;
    }
    if (cancelled || result.cancelled) {
      finish(130, "cancelled");
      return;
    }
    finish(0);
  } catch (error) {
    appendStderr(error?.stderr || "");
    appendEvent({ type: "turn.failed", error: { message: error?.message || String(error) } });
    finish(1, "app_server_failed");
  }
}

installLifecycle();
if (spec.backend === "app-server") {
  void runNativeReview();
} else {
  runExec();
}

// Внешний сигнал остаётся страховкой. Обычный codex_cancel для app-server
// пишет cancelFile, чтобы worker успел отправить протокольный interrupt.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    requestCancellation();
    if (!usingExec && !appController) finish(130, "cancelled");
  });
}
