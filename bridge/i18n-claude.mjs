// i18n-claude.mjs — наружные тексты обратного моста GPT → Claude.

import { lang } from "../scripts/i18n.mjs";

const TOOLS = {
  en: {
    ask_d:
      "Ask Claude, a second model working with the same repository, for an independent opinion. Use it to examine unfamiliar code, sanity-check a decision, or get a counterargument. Claude returns text and does not change files.",
    ask_question: "A self-contained question for Claude.",
    ask_context: "Your current context and proposed solution.",
    ask_model: "opus, sonnet, haiku, or a full model name. Defaults to sonnet.",

    critique_d: "Ask Claude to critique your plan or patch before you apply it. Returns concrete objections and risks.",
    critique_proposal: "The plan or diff to critique.",
    critique_model: "opus, sonnet, haiku, or a full model name. Defaults to sonnet.",

    task_d:
      "Delegate a task to Claude Code, which has its own tools for reading and editing files, searching the repository, running commands, and using configured MCP servers. Use it when the task needs capabilities you do not have or a second implementer would help. Claude returns a report of its work.",
    task_task: "A self-contained task description: what to do, where to do it, and what counts as done.",
    task_allowed_tools:
      "Narrow Claude's tool set, for example [\"Read\",\"Grep\"]. This can only restrict access: the final set is intersected with the bridge administrator's allowlist.",
    task_write: "Allow Claude to change files. Read-only by default.",
    task_model: "opus, sonnet, haiku, or a full model name. Defaults to sonnet.",
  },

  ru: {
    ask_d:
      "Спросить мнение у Claude — второй модели, работающей над тем же репозиторием. Используй, когда нужен независимый взгляд на решение, разбор незнакомого кода или контраргумент. Claude отвечает текстом и ничего не меняет.",
    ask_question: "Вопрос, сформулированный самодостаточно.",
    ask_context: "Твой текущий контекст и предлагаемое решение.",
    ask_model: "opus, sonnet, haiku или полное имя. По умолчанию sonnet.",

    critique_d: "Попросить Claude раскритиковать твой план или патч до применения. Вернёт список возражений и рисков.",
    critique_proposal: "План или диф, который надо раскритиковать.",
    critique_model: "opus, sonnet, haiku или полное имя. По умолчанию sonnet.",

    task_d:
      "Делегировать задачу Claude Code, у которого есть собственные инструменты: чтение и правка файлов, поиск по репозиторию, запуск команд, подключённые MCP-серверы. Используй, когда задача требует возможностей, которых нет у тебя, либо когда нужен второй исполнитель. Claude вернёт отчёт о сделанном.",
    task_task: "Самодостаточное описание задачи: что сделать, где, чем считается готово.",
    task_allowed_tools:
      "Сузить набор инструментов Claude, напр. [\"Read\",\"Grep\"]. Может только сужать: итоговый набор — пересечение с allowlist из настроек моста.",
    task_write: "Разрешить Claude изменять файлы. По умолчанию только чтение.",
    task_model: "opus, sonnet, haiku или полное имя. По умолчанию sonnet.",
  },
};

const PROMPTS = {
  en: {
    ask: (question, context) => `GPT (Codex), working on a task in this same repository, is asking for your independent opinion.

${context ? `CONTEXT FROM GPT:\n${context}\n\n` : ""}QUESTION:
${question}

Answer directly and concisely. If you disagree with the premise, say so plainly. State your confidence where you are uncertain.`,

    critique: (proposal) => `GPT (Codex) proposes the following solution and wants it critiqued before it is applied.

PROPOSAL:
${proposal}

List concrete objections: what could break, which assumptions have not been tested, and what is missing. If you have no objections, say so, but name the conditions under which the solution would stop working. Do not rewrite the whole solution; critique it.`,

    task: (task, write) => `GPT (Codex), working in this same repository, has delegated a task to you.

TASK:
${task}

${write ? "You may change files." : "Work read-only: change nothing and return the result as text."}

Finish with a summary of what you did, which files you touched, how you verified the result, and what remains open.`,
  },

  ru: {
    ask: (question, context) => `К тебе обращается GPT (Codex), работающий над задачей в этом же репозитории. Ему нужно твоё независимое мнение.

${context ? `КОНТЕКСТ ОТ GPT:\n${context}\n\n` : ""}ВОПРОС:
${question}

Ответь по существу и сжато. Если не согласен с посылкой вопроса — скажи прямо. Обозначь степень уверенности там, где её нет.`,

    critique: (proposal) => `GPT (Codex) предлагает следующее решение и просит раскритиковать его до применения.

ПРЕДЛОЖЕНИЕ:
${proposal}

Дай список конкретных возражений: что может сломаться, какие допущения не проверены, что упущено. Если возражений нет — скажи, но назови условия, при которых решение перестанет работать. Не переписывай решение целиком, критикуй.`,

    task: (task, write) => `Тебе делегирована задача от GPT (Codex), работающего в этом же репозитории.

ЗАДАЧА:
${task}

${write ? "Ты можешь изменять файлы." : "Работай только на чтение: ничего не меняй, верни результат текстом."}

В конце дай сводку: что сделал, какие файлы затронул, чем проверил, что осталось незакрытым.`,
  },
};

const MESSAGES = {
  en: {
    cancelled_before_start: "The call was cancelled before Claude started.",
    cancelled: "The call was cancelled and Claude was stopped.",
    output_overflow: (stream, mb) =>
      `Claude wrote more than ${mb} MB to ${stream}; the output was rejected and the process was stopped.`,
    claude_not_found: "The Claude executable was not found in PATH.",
    timeout: "Claude did not respond within the allotted time.",
    exit: (code, signal) =>
      code === null ? `Claude exited because of signal ${signal}.` : `Claude exited with code ${code}.`,
    partial_output: (output) => `Partial output (do not treat as a result):\n${output}`,
    empty_response: "Claude returned an empty response.",
    tools_not_allowed: (asked, admin) =>
      `The requested tools [${asked.join(", ")}] are not in the allowed set [${admin.join(", ")}]. ` +
      "The administrator configures this set with /codex-bridge:setup --task-tools, and callers cannot expand it.",
    no_tools_after_write_filter: (writeTools, before) =>
      `After removing write-capable tools (${writeTools.join(", ")}), none of the requested tools ` +
      `[${(before || []).join(", ")}] remain available. Pass write: true if the task must change files.`,
    proxy_errors: (errors) => `[codex-bridge] tool proxy errors:\n  ${errors.join("\n  ")}\n`,
    proxied_tool_failed: (name, error) => `Proxied tool ${name} failed: ${error}`,
    task_disabled: "claude_task is disabled. Enable it with: /codex-bridge:setup --allow-task",
    unknown_tool: (name) => `Unknown tool: ${name}`,
    answer: (output) => `Claude's answer:\n\n${output}`,
    report: (output) => `Claude's report:\n\n${output}`,
  },

  ru: {
    cancelled_before_start: "Вызов отменён до запуска Claude.",
    cancelled: "Вызов отменён, Claude остановлен.",
    output_overflow: (stream, mb) =>
      `Claude напечатал в ${stream} больше ${mb} МБ — вывод не принят, процесс остановлен.`,
    claude_not_found: "Бинарь claude не найден в PATH.",
    timeout: "Claude не ответил за отведённое время.",
    exit: (code, signal) => `Claude завершился с кодом ${code === null ? `сигналом ${signal}` : code}.`,
    partial_output: (output) => `Частичный вывод (не считать результатом):\n${output}`,
    empty_response: "Claude вернул пустой ответ.",
    tools_not_allowed: (asked, admin) =>
      `Запрошенные инструменты [${asked.join(", ")}] не входят в разрешённый набор ` +
      `[${admin.join(", ")}]. Набор задаётся администратором через /codex-bridge:setup --task-tools и расширению не подлежит.`,
    no_tools_after_write_filter: (writeTools, before) =>
      `После исключения инструментов записи (${writeTools.join(", ")}) не осталось ни одного ` +
      `доступного инструмента из [${(before || []).join(", ")}]. Передай write: true, если нужна правка файлов.`,
    proxy_errors: (errors) => `[codex-bridge] проброс инструментов:\n  ${errors.join("\n  ")}\n`,
    proxied_tool_failed: (name, error) => `Проброшенный инструмент ${name} завершился ошибкой: ${error}`,
    task_disabled: "claude_task выключен. Включить: /codex-bridge:setup --allow-task",
    unknown_tool: (name) => `Неизвестный инструмент: ${name}`,
    answer: (output) => `Ответ Claude:\n\n${output}`,
    report: (output) => `Claude отчитался:\n\n${output}`,
  },
};

export function toolText() {
  return { ...TOOLS.en, ...(TOOLS[lang()] || {}) };
}

function localized(table, key, args, kind) {
  const selected = table[lang()] || table.en;
  const value = selected[key] ?? table.en[key];
  if (typeof value === "function") return value(...args);
  if (typeof value === "string") return value;
  throw new Error(`Unknown Claude bridge ${kind}: ${key}`);
}

export function prompt(key, ...args) {
  return localized(PROMPTS, key, args, "prompt");
}

export function message(key, ...args) {
  return localized(MESSAGES, key, args, "message");
}
