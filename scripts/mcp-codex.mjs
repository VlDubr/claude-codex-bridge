#!/usr/bin/env node
// MCP stdio-сервер: даёт Claude инструменты для обращения к Codex/GPT.
// Транспорт — общий mcp-lib.mjs, без внешних зависимостей.

import { serve, text, fail as err } from "./mcp-lib.mjs";
import { pluginVersion } from "./version.mjs";
import {
  probeCodex,
  runJob,
  startJob,
  followJob,
  listJobs,
  resolveJob,
  jobOutput,
  jobProgress,
  jobTrail,
  jobAnswer,
  jobThreadId,
  jobResult,
  cancelJob,
  humanAge,
  envClean,
  repoKey,
  buildPrompt,
} from "./codex-core.mjs";
import { describe } from "./codex-events.mjs";
import { fetchModels, formatModels, knownModel, validateEffort, EFFORT_LEVELS } from "./models.mjs";
import { readChat, writeChat, listChats, deleteChat, withChatLock, isValidSlug } from "./chat-store.mjs";
import { readPrefs, writePrefs } from "./prefs.mjs";
import { toolText } from "./i18n.mjs";

const T = toolText();
const EFFORT_DESC = T.effort;

const TOOLS = [
  {
    name: "codex_ask",
    description: T.ask_d,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: T.ask_question },
        context: { type: "string", description: T.ask_context },
        model: { type: "string", description: T.ask_model },
        wait_seconds: { type: "number", default: 90, description: T.ask_wait },
        effort: { type: "string", enum: EFFORT_LEVELS, description: EFFORT_DESC },
      },
      required: ["question"],
    },
  },
  {
    name: "codex_chat",
    description: T.chat_d,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: T.chat_message },
        chat: { type: "string", description: T.chat_chat },
        model: { type: "string", description: T.chat_model },
        effort: { type: "string", enum: EFFORT_LEVELS, description: EFFORT_DESC },
        context: { type: "string", description: T.chat_context },
        write: { type: "boolean", default: false, description: T.chat_write },
        wait_seconds: { type: "number", default: 120, description: T.chat_wait },
      },
      required: ["message"],
    },
  },
  {
    name: "codex_chats",
    description: T.chats_d,
    inputSchema: {
      type: "object",
      properties: {
        forget: { type: "string", description: T.chats_forget },
      },
    },
  },
  {
    name: "codex_use",
    description: T.use_d,
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: T.use_model },
        effort: { type: "string", enum: EFFORT_LEVELS, description: EFFORT_DESC },
        clear: { type: "boolean", description: T.use_clear },
      },
    },
  },
  {
    name: "codex_review",
    description: T.review_d,
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: T.review_base },
        focus: { type: "string", description: T.review_focus },
        background: { type: "boolean", default: true },
        model: { type: "string" },
        effort: { type: "string", enum: EFFORT_LEVELS, description: EFFORT_DESC },
      },
    },
  },
  {
    name: "codex_challenge",
    description: T.challenge_d,
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: T.challenge_focus },
        base: { type: "string", description: T.review_base },
        background: { type: "boolean", default: true },
        model: { type: "string" },
        effort: { type: "string", enum: EFFORT_LEVELS, description: EFFORT_DESC },
      },
    },
  },
  {
    name: "codex_delegate",
    description: T.delegate_d,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: T.delegate_task },
        model: { type: "string" },
        effort: { type: "string", enum: EFFORT_LEVELS, description: EFFORT_DESC },
        wait_seconds: { type: "number", default: 120, description: T.delegate_wait },
      },
      required: ["task"],
    },
  },
  {
    name: "codex_models",
    description: T.models_d,
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", description: T.models_refresh },
      },
    },
  },
  {
    name: "codex_progress",
    description: T.progress_d,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: T.progress_job },
        limit: { type: "number", default: 12, description: T.progress_limit },
        detail: { type: "boolean", default: false, description: T.progress_detail },
        wait_seconds: { type: "number", description: T.progress_wait },
      },
    },
  },
  {
    name: "codex_status",
    description: T.status_d,
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: T.status_job } },
    },
  },
  {
    name: "codex_result",
    description: T.result_d,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: T.result_job },
        tail: { type: "number", description: T.result_tail },
      },
    },
  },
  {
    name: "codex_cancel",
    description: T.cancel_d,
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
    },
  },
];

const CLI_TOOLS = new Set([
  "codex_ask",
  "codex_chat",
  "codex_delegate",
  "codex_review",
  "codex_challenge",
  "codex_models",
]);

async function guard() {
  const c = await probeCodex();
  if (c.reason === "not_installed") {
    return "Codex CLI не найден. Установи: npm install -g @openai/codex — затем codex login.";
  }
  if (c.reason === "not_logged_in") {
    return "Codex установлен, но не авторизован. Выполни в терминале: codex login (вход через ChatGPT-аккаунт по OAuth).";
  }
  if (c.reason === "probe_timeout") {
    return "Проверка готовности Codex не завершилась за отведённое время. Сам Codex при этом может быть исправен. Проверь вручную: codex login status.";
  }
  return null;
}

function fmtJob(j) {
  const dur = j.finishedAt
    ? `${humanAge(j.startedAt)} назад, завершена`
    : `идёт ${humanAge(j.startedAt)}`;
  return `${j.id}  [${j.status}]  ${j.mode}${j.model ? ` (${j.model})` : ""}  — ${dur}${j.label ? `\n    ${j.label}` : ""}`;
}

// ------------------------------------------------------------------- рендеринг

// Лента хода работы не должна вытеснять из контекста Claude сам ответ.
const TRAIL_MAX_CHARS = 4000;
const REASONING_MAX_CHARS = 700;

/**
 * Ход работы модели в читаемом виде: одна строка на шаг, а для сводок
 * размышлений — их текст. Полный журнал остаётся на диске: в ответ он не идёт.
 */
function renderTrail(entries, { detail = false } = {}) {
  const lines = [];
  let budget = TRAIL_MAX_CHARS;
  let prev = null;
  for (const e of entries) {
    if (e.title === prev) continue; // item.updated приходит пачками
    prev = e.title;
    let line = `  · ${e.title}`;
    if (detail && e.kind === "reasoning" && e.detail && e.detail.length > e.title.length) {
      const body = e.detail.length > REASONING_MAX_CHARS ? `${e.detail.slice(0, REASONING_MAX_CHARS)}…` : e.detail;
      line = `  · ${e.title}\n${body
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`;
    }
    budget -= line.length;
    if (budget < 0) {
      lines.push("  · […лента обрезана, полный журнал — codex_progress]");
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Ответ модели вместе с тем, как она к нему шла. */
function renderRun(jobId, answer, { detail = true } = {}) {
  const trail = renderTrail(jobTrail(jobId, { limit: 60 }), { detail });
  return (trail ? `Ход работы GPT (сводки, не полные рассуждения):\n${trail}\n\n` : "") + `Ответ GPT:\n\n${answer}`;
}

// -------------------------------------------------------------------- вызовы

const notifier = (ctx) => (e) => {
  const line = describe(e);
  if (line) ctx?.notify?.(line);
};

function applyDefaults(args, cwd) {
  const prefs = readPrefs(repoKey(cwd));
  return {
    model: args.model || prefs.model || undefined,
    effort: args.effort || prefs.effort || undefined,
  };
}

/**
 * Отказы «занято» — не сбой сервера, а нормальный ответ: предел параллельных
 * задач или занятый тред чата. Без этого они уходили клиенту как -32603.
 */
async function handleTool(name, args, ctx = {}) {
  try {
    return await dispatchTool(name, args, ctx);
  } catch (e) {
    if (e?.busy) return err(e.message || String(e));
    throw e;
  }
}

async function dispatchTool(name, args, ctx = {}) {
  if (CLI_TOOLS.has(name)) {
    const problem = await guard();
    if (problem) return err(problem);
  }
  const cwd = envClean("CODEX_BRIDGE_CWD") || envClean("CLAUDE_PROJECT_DIR") || process.cwd();

  if (args.effort) {
    const bad = validateEffort(args.model, args.effort);
    if (bad) return err(`${bad}\nПолный список — инструмент codex_models.`);
  }

  if (args.model) {
    const k = knownModel(args.model);
    if (!k.known) {
      return err(
        `Модель "${args.model}" отсутствует в каталоге Codex.\nДоступны: ${k.available.join(", ")}\n` +
          `Полный список с описаниями — инструмент codex_models.`
      );
    }
  }

  switch (name) {
    case "codex_ask": {
      const waitMs = Math.max(10, Number(args.wait_seconds) || 90) * 1000;
      const r = await runJob(
        { mode: "ask", cwd, ...args, ...applyDefaults(args, cwd) },
        { waitMs, onEvent: notifier(ctx), signal: ctx.signal }
      );
      if (r.aborted) return text(`Вызов отменён, задача ${r.job.id} остановлена.`);
      if (r.timedOut) {
        // Работа не перезапускается: тот же процесс продолжает идти в фоне.
        return text(
          `GPT не уложился в ${Math.round(waitMs / 1000)}с — та же работа продолжается в фоне: ${r.job.id}\n\n` +
            `${renderTrail(jobTrail(r.job.id, { limit: 20 }))}\n\n` +
            `Смотри ход работы: codex_progress. Забрать ответ: codex_result.`
        );
      }
      if (!r.ok) return err(r.error);
      return text(renderRun(r.job.id, r.output));
    }

    case "codex_chat": {
      if (!args.message) return err("Нужно поле message.");
      const slug = args.chat || "default";
      if (!isValidSlug(slug)) {
        return err(`Недопустимое имя чата: ${JSON.stringify(slug)}. Разрешены латиница, цифры, точка, дефис.`);
      }
      const waitMs = Math.max(10, Number(args.wait_seconds) || 120) * 1000;

      try {
        return await withChatLock(slug, async () => {
          const chat = readChat(slug);
          const defaults = applyDefaults(args, cwd);
          // Модель, effort и каталог повторяются при каждом ходе: без них
          // Codex молча возьмёт текущие значения по умолчанию и разговор
          // уедет на другую модель.
          const model = args.model || chat?.model || defaults.model;
          const effort = args.effort || chat?.effort || defaults.effort;
          const chatCwd = chat?.cwd || cwd;
          const sandbox = args.write ? "workspace-write" : chat?.sandbox || "read-only";

          const r = await runJob(
            {
              mode: "chat",
              cwd: chatCwd,
              message: args.message,
              context: chat ? undefined : args.context,
              model,
              effort,
              sandbox,
              chat: slug,
              resume: chat?.threadId || null,
            },
            { waitMs, onEvent: notifier(ctx), signal: ctx.signal }
          );

          if (r.aborted) return text(`Вызов отменён, задача ${r.job.id} остановлена. Тред "${slug}" не изменён.`);
          if (r.timedOut) {
            return text(
              `Модель не уложилась в ${Math.round(waitMs / 1000)}с — работа продолжается в фоне: ${r.job.id}\n` +
                `Ответ придёт в тред "${slug}" — забери его через codex_result, потом продолжай разговор.\n\n` +
                renderTrail(jobTrail(r.job.id, { limit: 20 }))
            );
          }
          if (!r.ok) {
            // Пропавший тред — явная ошибка: молча начать новый разговор
            // значит потерять всю прежнюю переписку без предупреждения.
            if (
              chat?.threadId &&
              /(session|thread|rollout|conversation)[^\n]{0,60}(not found|no such|missing|does not exist)|no sessions found/i.test(
                r.error || ""
              )
            ) {
              return err(
                `Тред "${slug}" (${chat.threadId}) не удалось продолжить — Codex его не нашёл.\n` +
                  `Сессия могла быть удалена или запись велась с другим CODEX_HOME.\n` +
                  `Забудь разговор (codex_chats с forget: "${slug}") и начни заново.\n\n${r.error}`
              );
            }
            return err(r.error);
          }

          const threadId = chat?.threadId || jobThreadId(r.job.id);
          writeChat({
            slug,
            model: model || null,
            effort: effort || null,
            sandbox,
            threadId: threadId || null,
            cwd: chatCwd,
            turns: (chat?.turns || 0) + 1,
            updatedAt: new Date().toISOString(),
          });

          const head = `Чат "${slug}"${model ? ` · ${model}` : ""} · ход ${(chat?.turns || 0) + 1}${threadId ? "" : "\n(тред не сохранён: Codex не сообщил id сессии — следующий ход начнёт разговор заново)"}`;
          return text(`${head}\n\n${renderRun(r.job.id, r.output)}`);
        });
      } catch (e) {
        if (e?.busy) return err(String(e.message));
        throw e;
      }
    }

    case "codex_chats": {
      if (args.forget) {
        if (!isValidSlug(args.forget)) return err(`Недопустимое имя чата: ${JSON.stringify(args.forget)}`);
        return deleteChat(args.forget)
          ? text(`Разговор "${args.forget}" забыт. Следующее сообщение начнёт новый тред.`)
          : err(`Разговор "${args.forget}" не найден.`);
      }
      const chats = listChats();
      if (!chats.length) return text("Разговоров с моделями Codex пока нет.");
      return text(
        chats
          .map(
            (c) =>
              `${c.slug}${c.model ? ` · ${c.model}` : ""}${c.effort ? ` · ${c.effort}` : ""} — ходов ${c.turns || 0}, ` +
              `обновлён ${humanAge(c.updatedAt)} назад${c.threadId ? "" : " (тред не сохранён)"}\n    ${c.cwd}`
          )
          .join("\n")
      );
    }

    case "codex_use": {
      const repo = repoKey(cwd);
      if (args.clear) {
        writePrefs(repo, { model: null, effort: null });
        return text("Сброшено. Дальше действуют значения из настроек плагина.");
      }
      if (!args.model && !args.effort) {
        const p = readPrefs(repo);
        return text(
          `Для этого репозитория: модель ${p.model || "(из настроек плагина)"}, effort ${p.effort || "(из настроек плагина)"}.\n` +
            `Это значение проекта, а не конкретного окна Claude: надёжного идентификатора сессии у MCP-вызова нет.`
        );
      }
      const p = writePrefs(repo, {
        model: args.model === undefined ? undefined : args.model || null,
        effort: args.effort === undefined ? undefined : args.effort || null,
      });
      return text(
        `Дальше по умолчанию: модель ${p.model || "(из настроек плагина)"}, effort ${p.effort || "(из настроек плагина)"}.\n` +
          `Действует для репозитория ${repo}, а не только для этого окна Claude.`
      );
    }

    case "codex_progress": {
      const j = resolveJob(args.job_id, cwd);
      if (!j) return err("Задача не найдена. Список — codex_status.");

      // Ожидание новых событий: то же наблюдение, что и у синхронного вызова,
      // но по уже запущенной задаче.
      if (args.wait_seconds) {
        await followJob(j.id, {
          timeoutMs: Math.max(1, Number(args.wait_seconds)) * 1000,
          onEvent: notifier(ctx),
          signal: ctx.signal,
        });
      }

      const p = jobProgress(j.id, { limit: Number(args.limit) || 12 });
      if (!p.hasEvents) {
        return text(
          `${j.id} [${j.status}] — событий пока нет (${humanAge(j.startedAt)} с запуска).\n` +
            `Если Codex запущен без поддержки --json, лента недоступна; используй codex_result по завершении.`
        );
      }
      const entries = jobTrail(j.id, { limit: Number(args.limit) || 12 });
      return text(
        `${j.id} [${j.status}], идёт ${humanAge(j.startedAt)}\n\n` +
          renderTrail(entries, { detail: args.detail === true }) +
          (p.finished ? "\n\nРабота завершена — забери результат через codex_result." : "")
      );
    }

    case "codex_review":
    case "codex_challenge": {
      const mode = name === "codex_review" ? "review" : "challenge";
      const background = args.background !== false;
      // Сбор контекста теперь отказывает явно: не репозиторий, несуществующая
      // база, сбойный git. Раньше любая из этих причин давала пустой диф и
      // ревью «ни о чём», поэтому отказ доносим как есть, а не как сбой сервера.
      // Промпт строится здесь же и передаётся готовым: иначе git-диф собирался
      // бы дважды — на проверке и на запуске.
      let prompt;
      try {
        prompt = buildPrompt({ mode, cwd, ...args });
      } catch (e) {
        return err(`Не удалось собрать изменения для ревью: ${e?.message || e}`);
      }
      const spec = { mode, cwd, ...args, ...applyDefaults(args, cwd), prompt };
      if (!background) {
        const r = await runJob(spec, { waitMs: 480_000, onEvent: notifier(ctx), signal: ctx.signal });
        if (r.aborted) return text(`Вызов отменён, задача ${r.job.id} остановлена.`);
        if (r.timedOut) return text(`Не уложилось в 8 минут — работа продолжается в фоне: ${r.job.id}`);
        return r.ok ? text(renderRun(r.job.id, r.output)) : err(r.error);
      }
      const job = startJob(spec);
      return text(
        `Запущено ${mode === "review" ? "ревью" : "состязательное ревью"} в фоне: ${job.id}\nСледить: codex_progress. Забрать результат: codex_result.`
      );
    }

    case "codex_delegate": {
      if (!args.task) return err("Нужно поле task.");
      const spec = { mode: "delegate", cwd, ...args, ...applyDefaults(args, cwd) };
      // Ноль — прежнее поведение: сразу в фон, без ожидания.
      const waitMs = args.wait_seconds === undefined ? 120_000 : Math.max(0, Number(args.wait_seconds) || 0) * 1000;
      if (waitMs <= 0) {
        const job = startJob(spec);
        return text(
          `Задача делегирована GPT: ${job.id}\nGPT работает в рабочей директории и может менять файлы. Следить: codex_progress.`
        );
      }
      const r = await runJob(spec, { waitMs, onEvent: notifier(ctx), signal: ctx.signal });
      if (r.aborted) return text(`Вызов отменён, задача ${r.job.id} остановлена.`);
      if (r.timedOut) {
        return text(
          `GPT не уложился в ${Math.round(waitMs / 1000)}с — та же работа продолжается в фоне: ${r.job.id}\n\n` +
            `${renderTrail(jobTrail(r.job.id, { limit: 20 }))}\n\n` +
            `Смотри ход работы: codex_progress. Забрать результат: codex_result.`
        );
      }
      if (!r.ok) return err(r.error);
      return text(renderRun(r.job.id, r.output));
    }

    case "codex_models": {
      const r = fetchModels({ force: args.refresh === true });
      return r.ok ? text(formatModels(r)) : err(r.error);
    }

    case "codex_status": {
      if (args.job_id) {
        const j = resolveJob(args.job_id, cwd);
        if (!j) return err(`Задача ${args.job_id} не найдена.`);
        const p = jobProgress(j.id, { limit: 10 });
        const body = p.hasEvents
          ? renderTrail(jobTrail(j.id, { limit: 10 }))
          : jobOutput(j.id, { tail: 15 }) || "(пока пусто)";
        return text(`${fmtJob(j)}\n\n--- ход работы ---\n${body}`);
      }
      const jobs = listJobs(cwd).slice(0, 10);
      if (!jobs.length) return text("Фоновых задач Codex в этом репозитории нет.");
      return text(jobs.map(fmtJob).join("\n"));
    }

    case "codex_result": {
      const j = resolveJob(args.job_id, cwd);
      if (!j) return err("Задача не найдена.");
      if (j.status === "running") {
        return text(
          `${j.id} ещё выполняется (${humanAge(j.startedAt)}).\n\n` +
            (renderTrail(jobTrail(j.id, { limit: 10 })) || jobOutput(j.id, { tail: 30 }))
        );
      }
      const r = jobResult(j.id);
      if (!r.ok) return err(r.error);
      const answer = jobAnswer(j.id) || jobOutput(j.id, args.tail ? { tail: args.tail } : {});
      return text(`${j.id} [${j.status}] — ${j.mode}\n\n${renderRun(j.id, answer || "(вывод пуст)")}`);
    }

    case "codex_cancel": {
      const j = resolveJob(args.job_id, cwd);
      if (!j) return err("Задача не найдена.");
      const r = cancelJob(j.id);
      return r.ok ? text(`${j.id}: ${r.note || "отменена."}`) : err(r.error);
    }

    default:
      return err(`Неизвестный инструмент: ${name}`);
  }
}

serve({ name: "codex-bridge", version: pluginVersion(), tools: TOOLS, handle: handleTool });
