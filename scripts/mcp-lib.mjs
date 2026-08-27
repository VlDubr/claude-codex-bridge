// mcp-lib.mjs — минимальный MCP stdio-транспорт (JSON-RPC 2.0 построчно).
// Без зависимостей. Используется обоими серверами плагина.

import readline from "node:readline";
import { message } from "./i18n-runtime.mjs";

// Версии, которые сервер действительно умеет. Заявлять чужую версию нельзя:
// по спецификации сервер отвечает запрошенной версией только если поддерживает
// её, иначе — своей.
const SUPPORTED = ["2025-06-18", "2025-03-26"];
const PROTOCOL = SUPPORTED[0];

// Уведомления о прогрессе идут не чаще этого интервала: событий у Codex много,
// а поток уведомлений в клиенте — тоже ресурс.
const PROGRESS_MIN_INTERVAL_MS = 250;

// Предел на одно входящее сообщение. Промпты и дифы идут наружу, а не внутрь,
// поэтому запас здесь избыточен и служит только защитой от разрастания памяти.
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Аварийный выключатель ленты прогресса.
 *
 * У части сборок Claude Code есть известный дефект: получив notifications/progress,
 * клиент закрывает stdin сервера, и следующий вызов падает с
 * "MCP error -32000: Connection closed" (anthropics/claude-code#47378, #53617).
 * Отрисовка прогресса в свёрнутом виде инструмента починена в 2.1.153, но если
 * версия клиента задета дефектом, лента должна выключаться без правки кода.
 */
const progressEnabled = () => {
  const v = String(process.env.TANDEM_PROGRESS ?? "").trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
};

export const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
export const fail = (s) => ({ content: [{ type: "text", text: String(s) }], isError: true });

export function serve({ name, version = "0.1.0", tools, handle }) {
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  // Живые вызовы: нужны, чтобы отмена со стороны клиента дошла до обработчика.
  const inFlight = new Map();

  /**
   * Канал прогресса одного вызова. Клиент присылает progressToken в _meta;
   * без токена уведомления слать нельзя — по спецификации их некуда адресовать.
   */
  function progressChannel(token) {
    let seq = 0; // progress по спецификации обязан монотонно расти
    let lastAt = 0;
    let pending = null;
    let timer = null;
    let closed = false;

    const emit = (message) => {
      lastAt = Date.now();
      send({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: ++seq, message: String(message) },
      });
    };

    return {
      notify(message) {
        if (closed || token === undefined || token === null || !message) return;
        if (!progressEnabled()) return;
        const wait = PROGRESS_MIN_INTERVAL_MS - (Date.now() - lastAt);
        if (wait <= 0) return emit(message);
        pending = message; // в пачке важен последний шаг, а не каждый промежуточный
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            if (!closed && pending) emit(pending);
            pending = null;
          }, wait);
        }
      },
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        pending = null;
      },
    };
  }

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    // Одна строка — одно сообщение, и её размер ничем не ограничен. Разбор
    // такой строки удваивает расход памяти, поэтому отказ выдаётся до parse.
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      return send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: message("mcp_line_too_long", MAX_LINE_BYTES) },
      });
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // JSON-RPC parse error вместо молчаливого игнорирования
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: message("mcp_parse_error") } });
    }
    if (Array.isArray(msg)) {
      return send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: message("mcp_batches_unsupported") },
      });
    }
    // Проверка до разбора полей: `null` и скаляры — синтаксически верный JSON,
    // и деструктуризация такого сообщения роняла весь сервер вместе со всеми
    // живыми вызовами. Обработчик readline асинхронный, поэтому исключение
    // здесь никем не ловится.
    if (msg === null || typeof msg !== "object") {
      return send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: message("mcp_not_an_object") },
      });
    }
    const { id, method, params } = msg;
    const reply = (result) => send({ jsonrpc: "2.0", id, result });
    const error = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

    try {
      if (method === "initialize") {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED.includes(asked) ? asked : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      }
      if (method === "notifications/cancelled") {
        // Без этого отменённый в Claude вызов оставлял бы Codex работать дальше.
        const call = inFlight.get(params?.requestId);
        if (call) {
          call.cancelled = true;
          call.controller.abort();
        }
        return;
      }
      if (method?.startsWith("notifications/")) return;
      if (method === "ping") return reply({});
      if (method === "tools/list") return reply({ tools });
      if (method === "tools/call") {
        const controller = new AbortController();
        const channel = progressChannel(params?._meta?.progressToken);
        const call = { controller, cancelled: false };
        inFlight.set(id, call);
        try {
          const result = await handle(params?.name, params?.arguments || {}, {
            notify: channel.notify,
            signal: controller.signal,
            requestId: id,
          });
          // Отменённый вызов ответа не ждёт: по спецификации на него не отвечают.
          if (!call.cancelled) reply(result);
        } finally {
          channel.close();
          inFlight.delete(id);
        }
        return;
      }
      if (id !== undefined) error(-32601, message("mcp_method_not_found", method));
    } catch (e) {
      // Наружу — только сообщение: stack раскрывает пути и внутреннее устройство.
      process.stderr.write(`[mcp:${name}] ${e?.stack || e}\n`);
      inFlight.delete(id);
      if (id !== undefined) error(-32603, String(e?.message || e));
    }
  });
}
