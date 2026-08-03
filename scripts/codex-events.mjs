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

/** Событие → строка для человека, или null если показывать нечего. */
export function describe(e) {
  if (e.type === "turn.started") return "начал обдумывать задачу";
  if (e.type === "turn.completed") {
    const u = e.usage || {};
    const bits = [u.input_tokens && `вход ${u.input_tokens}`, u.output_tokens && `выход ${u.output_tokens}`]
      .filter(Boolean)
      .join(", ");
    return `завершил${bits ? ` (${bits} токенов)` : ""}`;
  }
  if (e.type === "turn.failed") {
    return `сбой: ${clip(e.error?.message || e.message || "без описания", 200)}`;
  }
  if (e.type === "error") {
    const msg = e.message || e.error?.message || "";
    return /reconnect/i.test(msg) ? `переподключение (${clip(msg, 40)})` : `ошибка: ${clip(msg, 200)}`;
  }

  const it = e.item;
  if (!it) return null;
  // В разных версиях поле называется type или item_type
  const kind = it.type || it.item_type;
  const started = e.type === "item.started";

  switch (kind) {
    case "reasoning":
      return it.text ? `размышляет: ${clip(firstLine(it.text))}` : null;
    case "command_execution": {
      const cmd = clip(String(it.command || "").replace(/^bash -lc\s*/, ""), 80);
      if (started) return `запускает: ${cmd}`;
      const code = it.exit_code;
      return `выполнил: ${cmd}${code === 0 || code === undefined || code === null ? "" : ` (код ${code})`}`;
    }
    case "file_change": {
      const files = (it.changes || []).map((c) => c.path || c.file).filter(Boolean);
      return files.length ? `правит файлы: ${clip(files.join(", "), 120)}` : "правит файлы";
    }
    case "mcp_tool_call":
      return `вызывает инструмент: ${it.server ? `${it.server}/` : ""}${it.tool || it.name || "?"}`;
    case "web_search":
      return `ищет в вебе: ${clip(it.query || "", 80)}`;
    case "todo_list": {
      const items = it.items || it.todos || [];
      const done = items.filter((x) => x.completed || x.status === "completed").length;
      return items.length ? `план: ${done}/${items.length} выполнено` : null;
    }
    case "agent_message":
      return started ? "формулирует ответ" : null; // сам ответ показываем отдельно
    default:
      return started ? `${kind}` : null;
  }
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
  const events = Array.isArray(raw) ? raw : parseStream(raw);
  const lines = [];
  for (const e of events) {
    const d = describe(e);
    if (!d) continue;
    // Не повторяем подряд одинаковые строки — Codex шлёт item.updated пачками
    if (lines[lines.length - 1] === d) continue;
    lines.push(d);
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
