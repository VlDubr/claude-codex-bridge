#!/usr/bin/env node
// MCP stdio-сервер: даёт Claude инструменты для обращения к Codex/GPT.
// Транспорт — общий mcp-lib.mjs, без внешних зависимостей.

import { serve, text, fail as err } from "./mcp-lib.mjs";
import {
  checkCodex,
  runSync,
  startJob,
  listJobs,
  resolveJob,
  jobOutput,
  cancelJob,
  humanAge,
  envClean,
} from "./codex-core.mjs";
import { fetchModels, formatModels, knownModel, validateEffort, EFFORT_LEVELS } from "./models.mjs";

const TOOLS = [
  {
    name: "codex_ask",
    description:
      "Спросить у GPT (Codex) второе мнение синхронно и получить ответ в этом же ходе. Используй, когда нужно сверить архитектурное решение, проверить свою гипотезу или получить контраргумент перед тем, как писать код. Отвечает за 1-3 минуты.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Вопрос к GPT, сформулированный самодостаточно." },
        context: {
          type: "string",
          description:
            "Твой текущий контекст: что ты уже выяснил, какое решение предлагаешь, какие есть сомнения. Чем конкретнее, тем полезнее ответ.",
        },
        model: { type: "string", description: "Модель Codex, напр. gpt-5.6-sol или gpt-5.4-mini." },
        effort: {
          type: "string",
          enum: EFFORT_LEVELS,
          description:
            "Уровень reasoning. Набор зависит от модели: точный список отдаёт codex_models. Значение minimal принимают только модели прошлых поколений — gpt-5.6 и новее отвергают его ошибкой API.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "codex_review",
    description:
      "Запустить обычное ревью кода силами GPT по текущим изменениям. По умолчанию в фоне.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Базовая ветка для ревью всей ветки, напр. main." },
        focus: { type: "string", description: "Опциональный дополнительный фокус." },
        background: { type: "boolean", default: true },
        model: { type: "string" },
        effort: {
          type: "string",
          enum: EFFORT_LEVELS,
          description:
            "Уровень reasoning. Набор зависит от модели: точный список отдаёт codex_models. Значение minimal принимают только модели прошлых поколений — gpt-5.6 и новее отвергают его ошибкой API.",
        },
      },
    },
  },
  {
    name: "codex_challenge",
    description:
      "Состязательное ревью: GPT оспаривает дизайн-решение, ищет неучтённые режимы отказа и предлагает альтернативы. Используй перед мержем крупного изменения.",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "Что именно оспорить: 'схема ретраев', 'выбор кеша', 'модель прав доступа'.",
        },
        base: { type: "string" },
        background: { type: "boolean", default: true },
        model: { type: "string" },
        effort: {
          type: "string",
          enum: EFFORT_LEVELS,
          description:
            "Уровень reasoning. Набор зависит от модели: точный список отдаёт codex_models. Значение minimal принимают только модели прошлых поколений — gpt-5.6 и новее отвергают его ошибкой API.",
        },
      },
    },
  },
  {
    name: "codex_delegate",
    description:
      "Делегировать GPT задачу с правом изменять файлы: исследовать баг, починить тест, отрефакторить кусок. Всегда в фоне. Возвращает job_id.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Описание задачи для GPT, максимально конкретное." },
        model: { type: "string" },
        effort: {
          type: "string",
          enum: EFFORT_LEVELS,
          description:
            "Уровень reasoning. Набор зависит от модели: точный список отдаёт codex_models. Значение minimal принимают только модели прошлых поколений — gpt-5.6 и новее отвергают его ошибкой API.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "codex_models",
    description:
      "Получить список моделей, реально доступных в этом окружении Codex. Спрашивает у самого Codex, а не берёт из зашитого списка. Вызови это, прежде чем указывать model в других инструментах, если не уверен в имени.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", description: "Игнорировать кэш и перечитать каталог." },
      },
    },
  },
  {
    name: "codex_status",
    description: "Показать статус фоновых задач Codex для текущего репозитория.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: "Опционально: конкретная задача." } },
    },
  },
  {
    name: "codex_result",
    description: "Получить финальный вывод завершённой фоновой задачи Codex.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Опционально: по умолчанию последняя задача." },
        tail: { type: "number", description: "Вернуть только последние N строк." },
      },
    },
  },
  {
    name: "codex_cancel",
    description: "Отменить выполняющуюся фоновую задачу Codex.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
    },
  },
];

function guard() {
  const c = checkCodex();
  if (c.reason === "not_installed") {
    return "Codex CLI не найден. Установи: npm install -g @openai/codex — затем codex login.";
  }
  if (c.reason === "not_logged_in") {
    return "Codex установлен, но не авторизован. Выполни в терминале: codex login (вход через ChatGPT-аккаунт по OAuth).";
  }
  return null;
}

function fmtJob(j) {
  const dur = j.finishedAt
    ? `${humanAge(j.startedAt)} назад, завершена`
    : `идёт ${humanAge(j.startedAt)}`;
  return `${j.id}  [${j.status}]  ${j.mode}${j.model ? ` (${j.model})` : ""}  — ${dur}${j.label ? `\n    ${j.label}` : ""}`;
}

function handleTool(name, args) {
  const problem = guard();
  if (problem) return err(problem);
  const cwd = envClean("CODEX_BRIDGE_CWD") || envClean("CLAUDE_PROJECT_DIR") || process.cwd();

  if (args.effort) {
    const problem = validateEffort(args.model, args.effort);
    if (problem) return err(`${problem}\nПолный список — инструмент codex_models.`);
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
      const r = runSync({ mode: "ask", cwd, ...args, timeoutMs: 240_000 });
      return r.ok ? text(`Ответ GPT:\n\n${r.output}`) : err(r.error);
    }

    case "codex_review":
    case "codex_challenge": {
      const mode = name === "codex_review" ? "review" : "challenge";
      const background = args.background !== false;
      if (!background) {
        const r = runSync({ mode, cwd, ...args, timeoutMs: 480_000 });
        return r.ok ? text(r.output) : err(r.error);
      }
      const job = startJob({ mode, cwd, ...args });
      return text(
        `Запущено ${mode === "review" ? "ревью" : "состязательное ревью"} в фоне: ${job.id}\nПроверить: codex_status. Забрать результат: codex_result.`
      );
    }

    case "codex_delegate": {
      if (!args.task) return err("Нужно поле task.");
      const job = startJob({ mode: "delegate", cwd, ...args });
      return text(
        `Задача делегирована GPT: ${job.id}\nGPT работает в рабочей директории и может менять файлы. Проверяй через codex_status.`
      );
    }

    case "codex_models": {
      const r = fetchModels({ force: args.refresh === true });
      return r.ok ? text(formatModels(r)) : err(r.error);
    }

    case "codex_status": {
      if (args.job_id) {
        const j = resolveJob(args.job_id, cwd);
        if (!j) return err(`Задача ${args.job_id} не найдена.`);
        const preview = jobOutput(j.id, { tail: 15 });
        return text(`${fmtJob(j)}\n\n--- последние строки ---\n${preview || "(пока пусто)"}`);
      }
      const jobs = listJobs(cwd).slice(0, 10);
      if (!jobs.length) return text("Фоновых задач Codex в этом репозитории нет.");
      return text(jobs.map(fmtJob).join("\n"));
    }

    case "codex_result": {
      const j = resolveJob(args.job_id, cwd);
      if (!j) return err("Задача не найдена.");
      if (j.status === "running") {
        return text(`${j.id} ещё выполняется (${humanAge(j.startedAt)}). Промежуточный вывод:\n\n${jobOutput(j.id, { tail: 30 })}`);
      }
      const out = jobOutput(j.id, args.tail ? { tail: args.tail } : {});
      return text(`${j.id} [${j.status}] — ${j.mode}\n\n${out || "(вывод пуст)"}`);
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

serve({ name: "codex-bridge", tools: TOOLS, handle: handleTool });
