// codex-events.mjs — разбор JSONL-потока `codex exec --json`.
//
// Нужен, чтобы не ждать вслепую: пока Codex работает, он построчно сообщает,
// что именно делает — рассуждает, запускает команду, правит файл, ищет в вебе.
// Раньше всё это уходило в никуда, и единственным сигналом был таймаут.
//
// Формат событий менялся между версиями Codex, поэтому разбор терпимый:
// неизвестные типы игнорируются, отсутствующие поля не роняют.

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
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX)}\n[… обрезано]` : t;
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
  const ts = e._ts || null;
  const at = (o) => ({ ts, ...o });

  if (e.type === "thread.started") {
    const id = e.thread_id || e.thread?.id || null;
    return at({ kind: "status", title: "сессия открыта", detail: id, threadId: id });
  }
  if (e.type === "turn.started") return at({ kind: "status", title: "начал обдумывать задачу", detail: null });
  if (e.type === "turn.completed") {
    const u = e.usage || {};
    const bits = [
      u.input_tokens && `вход ${u.input_tokens}`,
      u.output_tokens && `выход ${u.output_tokens}`,
      u.reasoning_output_tokens && `размышления ${u.reasoning_output_tokens}`,
    ]
      .filter(Boolean)
      .join(", ");
    return at({ kind: "status", title: `завершил${bits ? ` (${bits} токенов)` : ""}`, detail: null, usage: u });
  }
  if (e.type === "turn.failed") {
    const msg = e.error?.message || e.message || "без описания";
    return at({ kind: "error", title: `сбой: ${clip(msg, 200)}`, detail: detailOf(msg), fatal: true });
  }
  if (e.type === "error") {
    const msg = e.message || e.error?.message || "";
    const transient = /reconnect/i.test(msg);
    return at({
      kind: transient ? "status" : "error",
      title: transient ? `переподключение (${clip(msg, 40)})` : `ошибка: ${clip(msg, 200)}`,
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
      const textRaw = String(it.text || it.summary || "").trim();
      if (!textRaw) return null;
      // Сводка reasoning — самая ценная часть ленты, поэтому в detail она
      // уходит целиком: раньше от неё оставались первые 100 символов.
      return at({ kind: "reasoning", title: `размышляет: ${clip(firstLine(textRaw), 120)}`, detail: detailOf(textRaw) });
    }
    case "command_execution": {
      const cmd = cmdOf(it);
      if (started) return at({ kind: "command", title: `запускает: ${clip(cmd, 80)}`, detail: detailOf(cmd) });
      const code = it.exit_code;
      const bad = !(code === 0 || code === undefined || code === null);
      return at({
        kind: "command",
        title: `выполнил: ${clip(cmd, 80)}${bad ? ` (код ${code})` : ""}`,
        detail: detailOf(it.aggregated_output || it.output || cmd),
        exitCode: code ?? null,
      });
    }
    case "file_change": {
      const changes = it.changes || [];
      const files = changes.map((c) => c.path || c.file).filter(Boolean);
      return at({
        kind: "file",
        title: files.length ? `правит файлы: ${clip(files.join(", "), 120)}` : "правит файлы",
        detail: detailOf(changes.map((c) => `${c.kind || "change"} ${c.path || c.file || "?"}`).join("\n")),
        files,
      });
    }
    case "mcp_tool_call": {
      const name = `${it.server ? `${it.server}/` : ""}${it.tool || it.name || "?"}`;
      return at({
        kind: "mcp",
        title: `${started ? "вызывает" : "вызвал"} инструмент: ${name}`,
        // Аргументы и результат чужого инструмента могут содержать секреты и
        // мегабайты вывода — наружу отдаём только имя и признак ошибки.
        detail: it.error ? detailOf(String(it.error?.message || it.error)) : null,
        failed: Boolean(it.error),
      });
    }
    case "web_search":
      return at({ kind: "web", title: `ищет в вебе: ${clip(it.query || "", 80)}`, detail: detailOf(it.query) });
    case "todo_list": {
      const items = it.items || it.todos || [];
      if (!items.length) return null;
      const doneCount = items.filter((x) => x.completed || x.status === "completed").length;
      return at({
        kind: "todo",
        title: `план: ${doneCount}/${items.length} выполнено`,
        detail: detailOf(
          items.map((x) => `${x.completed || x.status === "completed" ? "[x]" : "[ ]"} ${x.text || x.title || ""}`).join("\n")
        ),
      });
    }
    case "collab_tool_call": {
      const name = it.tool || it.name || it.agent || "субагент";
      return at({ kind: "mcp", title: `${started ? "передаёт" : "получил от"} субагента: ${name}`, detail: null });
    }
    case "agent_message": {
      if (started) return at({ kind: "status", title: "формулирует ответ", detail: null });
      const textRaw = String(it.text || "").trim();
      if (!textRaw) return null;
      // Промежуточные сообщения — это реплики по ходу работы; какое из них
      // финальное, знает только конец потока (см. finalMessage).
      return at({ kind: "message", title: `говорит: ${clip(firstLine(textRaw), 120)}`, detail: detailOf(textRaw) });
    }
    case "error": {
      const msg = String(it.message || it.text || "").trim();
      if (!msg) return null;
      // item-ошибка нефатальна: turn при этом продолжается
      return at({ kind: "error", title: `предупреждение: ${clip(msg, 160)}`, detail: detailOf(msg), fatal: false });
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
    if (e.type === "item.completed" && it && (it.type || it.item_type) === "agent_message") {
      return String(it.text || "").trim();
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
  return { text: msg ?? "", events };
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
