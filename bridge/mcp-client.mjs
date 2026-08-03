// mcp-client.mjs — минимальный MCP-клиент поверх stdio.
// Нужен, чтобы мост мог сам подключаться к MCP-серверам Claude
// и переэкспортировать их инструменты в Codex.

import { spawn } from "node:child_process";
import readline from "node:readline";

const PROTOCOL = "2025-06-18";

export class McpStdioClient {
  constructor({ alias, command, args = [], env = {}, cwd, timeoutMs = 60_000 }) {
    this.alias = alias;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.tools = [];
    this.child = null;
    this.ready = false;
  }

  #send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  #request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.alias}: таймаут на ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const failAll = (e) => {
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(e);
      this.pending.clear();
    };
    this.child.on("error", failAll);
    // Без этого вызов после смерти сервера висел бы до полного таймаута.
    this.child.on("exit", (code, signal) =>
      failAll(
        new Error(
          `${this.alias}: процесс сервера завершился (${signal ? `сигнал ${signal}` : `код ${code}`})` +
            (this.stderr ? `: ${this.stderr.trim().slice(-500)}` : "")
        )
      )
    );
    // stderr не отправляем клиенту, но храним хвост: без него диагностика
    // реальных сбоев вложенного сервера невозможна.
    this.stderr = "";
    this.child.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });

    await this.#request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "codex-bridge", version: "0.2.0" },
    });
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await this.#request("tools/list", {});
    this.tools = listed?.tools || [];
    this.ready = true;
    return this.tools;
  }

  async call(name, args) {
    if (!this.ready) {
      throw new Error(
        `${this.alias}: сервер недоступен${this.stderr ? `. stderr: ${this.stderr.trim().slice(-500)}` : ""}`
      );
    }
    return this.#request("tools/call", { name, arguments: args || {} });
  }

  stop() {
    try {
      this.child?.kill("SIGTERM");
    } catch {}
  }
}
