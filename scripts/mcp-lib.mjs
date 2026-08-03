// mcp-lib.mjs — минимальный MCP stdio-транспорт (JSON-RPC 2.0 построчно).
// Без зависимостей. Используется обоими серверами плагина.

import readline from "node:readline";

// Версии, которые сервер действительно умеет. Заявлять чужую версию нельзя:
// по спецификации сервер отвечает запрошенной версией только если поддерживает
// её, иначе — своей.
const SUPPORTED = ["2025-06-18", "2025-03-26"];
const PROTOCOL = SUPPORTED[0];

export const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
export const fail = (s) => ({ content: [{ type: "text", text: String(s) }], isError: true });

export function serve({ name, version = "0.1.0", tools, handle }) {
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // JSON-RPC parse error вместо молчаливого игнорирования
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (Array.isArray(msg)) {
      return send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Батчи не поддерживаются в протоколе 2025-06-18" },
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
      if (method?.startsWith("notifications/")) return;
      if (method === "ping") return reply({});
      if (method === "tools/list") return reply({ tools });
      if (method === "tools/call") {
        return reply(await handle(params?.name, params?.arguments || {}));
      }
      if (id !== undefined) error(-32601, `Method not found: ${method}`);
    } catch (e) {
      // Наружу — только сообщение: stack раскрывает пути и внутреннее устройство.
      process.stderr.write(`[mcp:${name}] ${e?.stack || e}\n`);
      if (id !== undefined) error(-32603, String(e?.message || e));
    }
  });
}
