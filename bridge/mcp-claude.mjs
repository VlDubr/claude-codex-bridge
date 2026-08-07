#!/usr/bin/env node
// MCP stdio-сервер для направления GPT → Claude. Регистрируется в
// ~/.codex/config.toml командой /codex-bridge:setup --link-back.
//
// Даёт Codex три класса инструментов:
//   1. claude_ask / claude_critique — Claude как консультант (только чтение)
//   2. claude_task                  — делегирование Claude задачи с его инструментами
//   3. <server>__<tool>             — инструменты MCP-серверов Claude напрямую
//
// Пункты 2 и 3 выключены по умолчанию и включаются через /codex-bridge:setup.

import { spawn } from "node:child_process";
import { serve, text, fail } from "../scripts/mcp-lib.mjs";
import { pluginVersion } from "../scripts/version.mjs";
import { killTree, isWindows } from "../scripts/proc.mjs";
import { ToolProxy, readExposed } from "./tool-proxy.mjs";

const cleanEnv = (n) => {
  const v = process.env[n];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return !t || /^\$\{.*\}$/.test(t) ? undefined : t;
};
const CLAUDE_BIN = cleanEnv("CLAUDE_BIN") || "claude";
const cfg = readExposed();

// ------------------------------------------------------- Claude как процесс

// Инструменты, дающие запись. При write:false вырезаются жёстко, вне
// зависимости от того, что запросила вызывающая сторона.
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash", "MultiEdit"];

// Предел на вывод одного вызова. Считается в байтах, а не в символах строки:
// сравнивать длину JS-строки с «мегабайтами» неверно, кириллица и эмодзи дают
// в UTF-8 больше байт, чем символов.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Живые процессы Claude: при остановке моста их нельзя оставлять сиротами. */
const running = new Set();

function stopAll() {
  for (const child of running) killTree(child.pid);
  running.clear();
}

/**
 * ВАЖНО: --allowedTools НЕ ограничивает набор инструментов, он лишь снимает
 * запрос подтверждения. Ограничение доступности даёт --tools, а --disallowedTools
 * блокирует поимённо. Используем --tools как основной механизм и
 * --disallowedTools как страховку для write-инструментов.
 *
 * Запуск асинхронный. Прежний spawnSync блокировал event loop на всё время
 * работы Claude — до десяти минут: сервер не отвечал на ping, не принимал
 * отмену и сериализовал все параллельные вызовы. Ровно этот дефект уже был
 * исправлен на стороне Codex, а на обратном направлении оставался.
 */
function runClaude(prompt, { model, tools, denyTools, mode = "plan", timeoutMs = 600_000, signal } = {}) {
  const args = ["-p", "--model", model || "sonnet", "--permission-mode", mode];
  if (Array.isArray(tools)) args.push("--tools", tools.join(","));
  if (denyTools?.length) args.push("--disallowedTools", denyTools.join(","));

  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, aborted: true, error: "Вызов отменён до запуска Claude." });

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        stdio: ["pipe", "pipe", "pipe"],
        // Своя группа процессов: Claude запускает подпроцессы, и убийство
        // одного лидера оставило бы их работать. На Windows группу заменяет
        // taskkill /T внутри killTree.
        detached: !isWindows,
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: String(e?.message || e) });
    }
    running.add(child);

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timer = null;

    // Исход один, кто бы ни пришёл первым: выход, ошибка, таймаут, отмена или
    // переполнение. Без единой точки разрешения гонки промис резолвился бы
    // дважды, а таймер и слушатель отмены оставались бы висеть.
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
      running.delete(child);
      resolve(result);
    };

    function onAbort() {
      killTree(child.pid);
      settle({ ok: false, aborted: true, error: "Вызов отменён, Claude остановлен." });
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const overflow = (stream) => {
      killTree(child.pid);
      settle({
        ok: false,
        error: `Claude напечатал в ${stream} больше ${Math.round(MAX_OUTPUT_BYTES / 1024 / 1024)} МБ — вывод не принят, процесс остановлен.`,
      });
    };

    child.stdout.on("data", (b) => {
      outBytes += b.length;
      if (outBytes > MAX_OUTPUT_BYTES) return overflow("stdout");
      outChunks.push(b);
    });
    child.stderr.on("data", (b) => {
      errBytes += b.length;
      if (errBytes > MAX_OUTPUT_BYTES) return overflow("stderr");
      errChunks.push(b);
    });

    child.on("error", (e) => {
      running.delete(child);
      settle(
        e?.code === "ENOENT"
          ? { ok: false, error: "Бинарь claude не найден в PATH." }
          : { ok: false, error: String(e?.message || e) }
      );
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child.pid);
        settle({ ok: false, error: "Claude не ответил за отведённое время." });
      }, timeoutMs);
    }

    child.stdin.on("error", () => {}); // закрытый stdin не должен ронять мост
    child.stdin.write(prompt);
    child.stdin.end();

    // close, а не exit: к этому моменту потоки дочитаны до конца.
    child.on("close", (code, sig) => {
      const out = Buffer.concat(outChunks).toString("utf8").trim();
      const errText = Buffer.concat(errChunks).toString("utf8").trim();

      // Ненулевой код — ошибка даже при непустом stdout: частичный отчёт,
      // выданный за успешный результат, опаснее явного отказа.
      if (code !== 0) {
        return settle({
          ok: false,
          error:
            `Claude завершился с кодом ${code === null ? `сигналом ${sig}` : code}.` +
            (errText ? `\n${errText.slice(0, 800)}` : "") +
            (out ? `\n\nЧастичный вывод (не считать результатом):\n${out.slice(0, 800)}` : ""),
        });
      }
      if (!out) return settle({ ok: false, error: errText || "Claude вернул пустой ответ." });
      settle({ ok: true, output: out });
    });
  });
}

/**
 * Пересечение запрошенного набора с административным allowlist.
 * Codex сам передаёт allowed_tools, поэтому расширять список ему нельзя —
 * иначе настройка task_tools: ["Read"] обходится одним аргументом.
 */
function resolveTools(requested, configured, write) {
  const admin = Array.isArray(configured) && configured.length ? [...configured] : null;
  const asked = Array.isArray(requested) && requested.length ? [...requested] : null;

  let tools = admin;
  if (asked) {
    tools = admin ? admin.filter((t) => asked.includes(t)) : [...asked];
    if (admin && !tools.length) {
      // Пустое пересечение — не повод молча запустить Claude без инструментов:
      // это запрос за пределы allowlist, и об этом надо сказать.
      return {
        error:
          `Запрошенные инструменты [${asked.join(", ")}] не входят в разрешённый набор ` +
          `[${admin.join(", ")}]. Набор задаётся администратором через /codex-bridge:setup --task-tools и расширению не подлежит.`,
      };
    }
  }

  if (!write) {
    const deny = new Set(WRITE_TOOLS);
    const before = tools;
    tools = (tools || ["Read", "Grep", "Glob"]).filter((t) => !deny.has(t.split("(")[0]));
    if (!tools.length) {
      return {
        error:
          `После исключения инструментов записи (${WRITE_TOOLS.join(", ")}) не осталось ни одного ` +
          `доступного инструмента из [${(before || []).join(", ")}]. Передай write: true, если нужна правка файлов.`,
      };
    }
  }
  return { tools };
}

// ------------------------------------------------------------- свои инструменты

const OWN_TOOLS = [
  {
    name: "claude_ask",
    description:
      "Спросить мнение у Claude — второй модели, работающей над тем же репозиторием. Используй, когда нужен независимый взгляд на решение, разбор незнакомого кода или контраргумент. Claude отвечает текстом и ничего не меняет.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Вопрос, сформулированный самодостаточно." },
        context: { type: "string", description: "Твой текущий контекст и предлагаемое решение." },
        model: { type: "string", description: "opus, sonnet, haiku или полное имя. По умолчанию sonnet." },
      },
      required: ["question"],
    },
  },
  {
    name: "claude_critique",
    description:
      "Попросить Claude раскритиковать твой план или патч до применения. Вернёт список возражений и рисков.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: { type: "string", description: "План или диф, который надо раскритиковать." },
        model: { type: "string" },
      },
      required: ["proposal"],
    },
  },
];

const TASK_TOOL = {
  name: "claude_task",
  description:
    "Делегировать задачу Claude Code, у которого есть собственные инструменты: чтение и правка файлов, поиск по репозиторию, запуск команд, подключённые MCP-серверы. Используй, когда задача требует возможностей, которых нет у тебя, либо когда нужен второй исполнитель. Claude вернёт отчёт о сделанном.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Самодостаточное описание задачи: что сделать, где, чем считается готово.",
      },
      allowed_tools: {
        type: "array",
        items: { type: "string" },
        description:
          "Сузить набор инструментов Claude, напр. [\"Read\",\"Grep\"]. Может только сужать: итоговый набор — пересечение с allowlist из настроек моста.",
      },
      write: {
        type: "boolean",
        default: false,
        description: "Разрешить Claude изменять файлы. По умолчанию только чтение.",
      },
      model: { type: "string" },
    },
    required: ["task"],
  },
};

// ------------------------------------------------------------------- сборка

const proxy = new ToolProxy();
if (Object.keys(cfg.servers).length) await proxy.start();

const TOOLS = [...OWN_TOOLS, ...(cfg.allowTask ? [TASK_TOOL] : []), ...proxy.toolDescriptors()];

if (proxy.errors.length) {
  process.stderr.write(`[codex-bridge] проброс инструментов:\n  ${proxy.errors.join("\n  ")}\n`);
}

// ------------------------------------------------------------------ обработка

async function handle(name, args, ctx = {}) {
  if (proxy.has(name)) {
    try {
      const res = await proxy.call(name, args);
      if (res && Array.isArray(res.content)) return res; // уже формат MCP
      return text(JSON.stringify(res));
    } catch (e) {
      return fail(`Проброшенный инструмент ${name} завершился ошибкой: ${e.message || e}`);
    }
  }

  if (name === "claude_ask") {
    const prompt = `К тебе обращается GPT (Codex), работающий над задачей в этом же репозитории. Ему нужно твоё независимое мнение.

${args.context ? `КОНТЕКСТ ОТ GPT:\n${args.context}\n\n` : ""}ВОПРОС:
${args.question}

Ответь по существу и сжато. Если не согласен с посылкой вопроса — скажи прямо. Обозначь степень уверенности там, где её нет.`;
    const r = await runClaude(prompt, { model: args.model, signal: ctx.signal });
    return r.ok ? text(`Ответ Claude:\n\n${r.output}`) : fail(r.error);
  }

  if (name === "claude_critique") {
    const prompt = `GPT (Codex) предлагает следующее решение и просит раскритиковать его до применения.

ПРЕДЛОЖЕНИЕ:
${args.proposal}

Дай список конкретных возражений: что может сломаться, какие допущения не проверены, что упущено. Если возражений нет — скажи, но назови условия, при которых решение перестанет работать. Не переписывай решение целиком, критикуй.`;
    const r = await runClaude(prompt, { model: args.model, signal: ctx.signal });
    return r.ok ? text(`Ответ Claude:\n\n${r.output}`) : fail(r.error);
  }

  if (name === "claude_task") {
    if (!cfg.allowTask) return fail("claude_task выключен. Включить: /codex-bridge:setup --allow-task");
    const write = args.write === true;
    const resolved = resolveTools(args.allowed_tools, cfg.taskTools, write);
    if (resolved.error) return fail(resolved.error);
    const tools = resolved.tools;
    const denyTools = write ? [] : WRITE_TOOLS;
    const prompt = `Тебе делегирована задача от GPT (Codex), работающего в этом же репозитории.

ЗАДАЧА:
${args.task}

${write ? "Ты можешь изменять файлы." : "Работай только на чтение: ничего не меняй, верни результат текстом."}

В конце дай сводку: что сделал, какие файлы затронул, чем проверил, что осталось незакрытым.`;
    const r = await runClaude(prompt, {
      model: args.model,
      tools,
      denyTools,
      mode: write ? "acceptEdits" : "plan",
      signal: ctx.signal,
    });
    return r.ok ? text(`Claude отчитался:\n\n${r.output}`) : fail(r.error);
  }

  return fail(`Неизвестный инструмент: ${name}`);
}

// Мост уходит — Claude уходит с ним. Иначе закрытие Codex оставляет позади
// процессы, которые продолжают править файлы в репозитории без надзора.
// Закрытие stdin намеренно НЕ убивает Claude: клиент закрывает поток сразу
// после отправки запроса, и убийство по этому событию отменяло бы работу,
// которую сам же клиент и заказал. Сервер доживает до конца вызова и уходит
// по exit — тогда и снимаются процессы.
process.on("exit", () => {
  stopAll();
  proxy.stop();
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopAll();
    proxy.stop();
    process.exit(130);
  });
}

serve({ name: "claude-bridge", version: pluginVersion(), tools: TOOLS, handle });
