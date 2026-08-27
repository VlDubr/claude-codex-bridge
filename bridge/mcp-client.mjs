// mcp-client.mjs — минимальный MCP-клиент поверх stdio.
// Нужен, чтобы мост мог сам подключаться к MCP-серверам Claude
// и переэкспортировать их инструменты в Codex.

import { spawn } from "node:child_process";
import readline from "node:readline";
import { pluginVersion } from "../scripts/version.mjs";
import { message } from "../scripts/i18n-runtime.mjs";
import { killTree, isWindows } from "../scripts/proc.mjs";

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
        reject(new Error(message("client_timeout", this.alias, method)));
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
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWindows,
    });

    const failAll = (e) => {
      this.ready = false;
      for (const { reject } of this.pending.values()) reject(e);
      this.pending.clear();
    };
    this.child.on("error", failAll);
    // EPIPE приходит на stdin-поток, а не обязательно на ChildProcess.
    // После него транспорт непригоден, поэтому все ожидающие RPC отклоняются.
    this.child.stdin.on("error", failAll);
    // Без этого вызов после смерти сервера висел бы до полного таймаута.
    this.child.on("exit", (code, signal) =>
      failAll(
        new Error(
          message("client_server_exited", this.alias, signal ? message("client_signal", signal) : message("client_code", code)) +
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
      clientInfo: { name: "tandem", version: pluginVersion() },
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
        message("client_unavailable", this.alias) + (this.stderr ? `. stderr: ${this.stderr.trim().slice(-500)}` : "")
      );
    }
    return this.#request("tools/call", { name, arguments: args || {} });
  }

  stop() {
    this.ready = false;
    if (this.child?.pid) killTree(this.child.pid);
  }
}
