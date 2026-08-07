// codex-events.mjs — разбор JSONL-потока `codex exec --json`.
//
// Нужен, чтобы не ждать вслепую: пока Codex работает, он построчно сообщает,
// что именно делает — рассуждает, запускает команду, правит файл, ищет в вебе.
// Раньше всё это уходило в никуда, и единственным сигналом был таймаут.
//
// Формат событий менялся между версиями Codex, поэтому разбор терпимый:
// неизвестные типы игнорируются, отсутствующие поля не роняют.

import { trailText } from "./i18n.mjs";

// Подписи ленты берутся на каждый вызов: язык задаётся окружением процесса.
const L = trailText;

/** Одна строка JSONL → событие, или null если строка не событие. */
export function parseLine(line) {
  const t = String(line).trim();
  if (!t.startsWith("{")) return null;
  try {
    const e = JSON.parse(t);
    return e && typeof e.type === "string" ? e : null;
  } catch {
    return null;
  }
}

export function parseStream(text) {
  return String(text || "")
    .split("\n")
    .map(parseLine)
    .filter(Boolean);
}

/**
 * Уведомление app-server → тот же объект события, который пишет `exec --json`.
 * Имена полей item остаются исходными и разбираются ниже терпимо: так журнал
 * не заводит второй формат, а UI продолжает работать через одну normalize().
 */
export function fromAppServerNotification(notification) {
  if (!notification || typeof notification.method !== "string") return null;
  const type = notification.method.replaceAll("/", ".");
  const params = notification.params && typeof notification.params === "object" ? notification.params : {};
  if (!/^(thread|turn|item)\.|^error$/.test(type)) return null;
  if (type === "turn.completed" && params.turn?.status === "failed") {
    return { ...params, type: "turn.failed", error: params.turn.error || params.error || null };
  }
  return { ...params, type };
}

// Воркер ведёт один журнал на задачу, но stdout и stderr в нём надо различать:
// без --json Codex печатает ответ обычным текстом, и его собственная
// диагностика подмешивалась в ответ модели. Поэтому строки, не являющиеся
// событиями, воркер оборачивает и помечает происхождением.
export const STDOUT_LINE = "stream.stdout";
export const STDERR_LINE = "stream.stderr";

/** Строки одного потока в порядке появления. Пусто, если журнал без меток. */
export function streamText(raw, source) {
  const events = Array.isArray(raw) ? raw : parseStream(raw);
  const type = source === "stderr" ? STDERR_LINE : STDOUT_LINE;
  return events
    .filter((e) => e.type === type)
    .map((e) => String(e.text ?? ""))
    .join("\n");
}

/** Журнал помечен воркером — значит потоки разделимы. */
export function hasStreamTags(raw) {
  const events = Array.isArray(raw) ? raw : parseStream(raw);
  return events.some((e) => e.type === STDOUT_LINE || e.type === STDERR_LINE);
}

/** Транзиентные реконнекты Codex шлёт как error — это не отказ. */
export function isFatalError(e) {
  if (e.type === "turn.failed") return true;
  if (e.type !== "error") return false;
  return !/reconnect/i.test(e.message || e.error?.message || "");
}

const firstLine = (s) =>
  String(s || "")
    .replace(/\*\*/g, "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)[0] || "";

const clip = (s, n = 100) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Верхняя граница для detail: события вроде command_execution несут весь вывод
// команды, а mcp_tool_call — целиком результат инструмента. Держать это в
// памяти целиком незачем, а отдавать наружу — тем более.
const DETAIL_MAX = 4000;
const detailOf = (s) => {
  const t = String(s || "").trim();
  if (!t) return null;
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX)}\n${L().truncated}` : t;
};

const cmdOf = (it) => String(it.command || "").replace(/^bash -lc\s*/, "");

/**
 * Событие Codex → единая структура для показа.
 *
 * kind: status | reasoning | command | file | mcp | web | todo | message | error
 * title — одна строка для ленты, detail — содержимое целиком (усечённое).
 * Возвращает null, если показывать нечего.
 */
export function normalize(e) {
  if (!e || typeof e.type !== "string") return null;
  if (e.type === STDOUT_LINE || e.type === STDERR_LINE) return null; // служебная метка, не шаг работы
  const ts = e._ts || null;
  const at = (o) => ({ ts, ...o });

  if (e.type === "thread.started") {
    const id = e.thread_id || e.thread?.id || null;
    return at({ kind: "status", title: L().session_open, detail: id, threadId: id });
  }
  if (e.type === "turn.started") return at({ kind: "status", title: L().turn_started, detail: null });
  if (e.type === "turn.completed") {
    const u = e.usage || {};
    const bits = [
      u.input_tokens && L().tokens_in(u.input_tokens),
      u.output_tokens && L().tokens_out(u.output_tokens),
      u.reasoning_output_tokens && L().tokens_reasoning(u.reasoning_output_tokens),
    ]
      .filter(Boolean)
      .join(", ");
    return at({ kind: "status", title: L().done(bits), detail: null, usage: u });
  }
  if (e.type === "turn.failed") {
    const msg = e.error?.message || e.message || L().no_detail;
    return at({ kind: "error", title: L().failure(clip(msg, 200)), detail: detailOf(msg), fatal: true });
  }
  if (e.type === "error") {
    const msg = e.message || e.error?.message || "";
    const transient = /reconnect/i.test(msg);
    return at({
      kind: transient ? "status" : "error",
      title: transient ? L().reconnecting(clip(msg, 40)) : L().error(clip(msg, 200)),
      detail: detailOf(msg),
      fatal: !transient,
    });
  }

  const it = e.item;
  if (!it) return null;
  // В разных версиях поле называется type или item_type
  const kind = it.type || it.item_type;
  const started = e.type === "item.started";
  const done = e.type === "item.completed";

  switch (kind) {
    case "reasoning": {
      const summary = Array.isArray(it.summary)
        ? it.summary.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join("\n")
        : it.summary;
      const textRaw = String(it.text || summary || "").trim();
      if (!textRaw) return null;
      // Сводка reasoning — самая ценная часть ленты, поэтому в detail она
      // уходит целиком: раньше от неё оставались первые 100 символов.
      return at({ kind: "reasoning", title: L().reasoning(clip(firstLine(textRaw), 120)), detail: detailOf(textRaw) });
    }
    case "command_execution":
    case "commandExecution": {
      const cmd = cmdOf(it);
      if (started) return at({ kind: "command", title: L().running(clip(cmd, 80)), detail: detailOf(cmd) });
      const code = it.exit_code ?? it.exitCode;
      const bad = !(code === 0 || code === undefined || code === null);
      return at({
        kind: "command",
        title: L().ran(clip(cmd, 80), bad ? code : null),
        detail: detailOf(it.aggregated_output || it.aggregatedOutput || it.output || cmd),
        exitCode: code ?? null,
      });
    }
    case "file_change":
    case "fileChange": {
      const changes = it.changes || [];
      const files = changes.map((c) => c.path || c.file).filter(Boolean);
      return at({
        kind: "file",
        title: L().editing_files(files.length ? clip(files.join(", "), 120) : ""),
        detail: detailOf(changes.map((c) => `${c.kind || "change"} ${c.path || c.file || "?"}`).join("\n")),
        files,
      });
    }
    case "mcp_tool_call":
    case "mcpToolCall": {
      const name = `${it.server ? `${it.server}/` : ""}${it.tool || it.name || "?"}`;
      return at({
        kind: "mcp",
        title: L().tool_call(started, name),
        // Аргументы и результат чужого инструмента могут содержать секреты и
        // мегабайты вывода — наружу отдаём только имя и признак ошибки.
        detail: it.error ? detailOf(String(it.error?.message || it.error)) : null,
        failed: Boolean(it.error),
      });
    }
    case "web_search":
    case "webSearch":
      return at({ kind: "web", title: L().web_search(clip(it.query || "", 80)), detail: detailOf(it.query) });
    case "todo_list":
    case "todoList": {
      const items = it.items || it.todos || [];
      if (!items.length) return null;
      const doneCount = items.filter((x) => x.completed || x.status === "completed").length;
      return at({
        kind: "todo",
        title: L().plan(doneCount, items.length),
        detail: detailOf(
          items.map((x) => `${x.completed || x.status === "completed" ? "[x]" : "[ ]"} ${x.text || x.title || ""}`).join("\n")
        ),
      });
    }
    case "collab_tool_call":
    case "collabToolCall": {
      const name = it.tool || it.name || it.agent || L().subagent_default;
      return at({ kind: "mcp", title: L().subagent(started, name), detail: null });
    }
    case "agent_message":
    case "agentMessage": {
      if (started) return at({ kind: "status", title: L().composing, detail: null });
      const textRaw = String(it.text || "").trim();
      if (!textRaw) return null;
      // Промежуточные сообщения — это реплики по ходу работы; какое из них
      // финальное, знает только конец потока (см. finalMessage).
      return at({ kind: "message", title: L().says(clip(firstLine(textRaw), 120)), detail: detailOf(textRaw) });
    }
    case "exitedReviewMode": {
      if (started) return at({ kind: "status", title: L().composing, detail: null });
      const textRaw = String(it.review || "").trim();
      if (!textRaw) return null;
      return at({ kind: "message", title: L().says(clip(firstLine(textRaw), 120)), detail: detailOf(textRaw) });
    }
    case "error": {
      const msg = String(it.message || it.text || "").trim();
      if (!msg) return null;
      // item-ошибка нефатальна: turn при этом продолжается
      return at({ kind: "error", title: L().warning(clip(msg, 160)), detail: detailOf(msg), fatal: false });
    }
    default:
      return started && kind ? at({ kind: "status", title: String(kind), detail: null }) : null;
  }
}

/** Событие → строка для человека, или null если показывать нечего. */
export function describe(e) {
  return normalize(e)?.title ?? null;
}

/** Нормализованные записи потока, в порядке появления. */
export function normalizeStream(raw) {
  const events = Array.isArray(raw) ? raw : parseStream(raw);
  const out = [];
  for (const e of events) {
    const n = normalize(e);
    if (n) out.push(n);
  }
  return out;
}

/** id треда Codex — нужен, чтобы продолжить разговор через `exec resume`. */
export function threadIdOf(raw) {
  const events = Array.isArray(raw) ? raw : parseStream(raw);
  for (const e of events) {
    const id = e.type === "thread.started" ? e.thread_id || e.thread?.id : null;
    if (id) return String(id);
  }
  return null;
}

/** Итоговый ответ агента — последнее agent_message в потоке. */
export function finalMessage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const it = e.item;
    const kind = it?.type || it?.item_type;
    if (e.type === "item.completed" && (kind === "agent_message" || kind === "agentMessage")) {
      return String(it.text || "").trim();
    }
    if (e.type === "item.completed" && kind === "exitedReviewMode") {
      return String(it.review || "").trim();
    }
  }
  return null;
}

/**
 * Достаёт ответ из вывода. Если поток не в JSON (старый Codex или --json
 * не поддержан), возвращает текст как есть — деградация без потери работы.
 */
export function extractOutput(raw) {
  const events = parseStream(raw);
  if (!events.length) return { text: String(raw || "").trim(), events: [] };
  const msg = finalMessage(events);
  if (msg !== null) return { text: msg, events };
  // Ответа-события нет: значит Codex печатал текстом. Берём только stdout —
  // stderr помечен отдельно и в ответ модели попадать не должен.
  return { text: streamText(events, "stdout").trim(), events };
}

/** Компактная лента прогресса: что модель делала, в порядке появления. */
export function progressTrail(raw, { limit = 12 } = {}) {
  const lines = [];
  for (const n of normalizeStream(raw)) {
    // Не повторяем подряд одинаковые строки — Codex шлёт item.updated пачками
    if (lines[lines.length - 1] === n.title) continue;
    lines.push(n.title);
  }
  return lines.slice(-limit);
}

/** Одна строка: чем модель занята прямо сейчас. */
export function currentActivity(raw) {
  const trail = progressTrail(raw, { limit: 1 });
  return trail[0] || null;
}

export function usageOf(events) {
  const e = [...events].reverse().find((x) => x.type === "turn.completed");
  return e?.usage || null;
}

/** Признак завершённости потока: turn закрыт успешно или с ошибкой. */
export function isFinished(events) {
  return events.some((e) => e.type === "turn.completed" || e.type === "turn.failed");
}
