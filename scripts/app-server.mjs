// app-server.mjs — минимальный JSON-RPC-клиент для `codex app-server`.
//
// Протокол идёт по stdio строками JSONL. Клиент не знает ничего о MCP и
// хранилище задач: этим занимается job-worker, поэтому его процесс и принятый
// turn продолжают жить при перезапуске MCP-сервера.

import { spawn } from "node:child_process";
import readline from "node:readline";
import { killTree } from "./proc.mjs";
import { fromAppServerNotification } from "./codex-events.mjs";
import { message } from "./i18n-runtime.mjs";
import { pluginVersion } from "./version.mjs";

const STDERR_MAX = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AppServerError extends Error {
  constructor(text, { reviewAccepted = false, cancelled = false, rpc = null, cause = null } = {}) {
    super(text, cause ? { cause } : undefined);
    this.name = "AppServerError";
    this.reviewAccepted = reviewAccepted;
    this.cancelled = cancelled;
    this.rpc = rpc;
  }
}

/** Команда переопределяется объектом только в тестах; в работе это CODEX_BIN. */
function commandOf(command, bin) {
  if (command && typeof command === "object") {
    return { bin: command.bin, args: Array.isArray(command.args) ? command.args : [] };
  }
  return { bin: command || bin || "codex", args: ["app-server", "--stdio"] };
}

export class AppServerClient {
  constructor({ cwd, bin, command, env, onNotification, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const resolved = commandOf(command, bin);
    this.cwd = cwd || process.cwd();
    this.bin = resolved.bin;
    this.args = resolved.args;
    this.env = env;
    this.onNotification = onNotification;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.proc = null;
    this.readline = null;
    this.closed = false;
    this.exitError = null;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  static async connect(options = {}) {
    const client = new AppServerClient(options);
    try {
      await client.start();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async start() {
    try {
      this.proc = spawn(this.bin, this.args, {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      throw new AppServerError(message("app_server_spawn_failed", error?.message || error), { cause: error });
    }

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_MAX);
    });
    this.proc.on("error", (error) => this.handleExit(error));
    this.proc.on("exit", (code, signal) => {
      const how = signal ? message("app_server_signal", signal) : message("app_server_code", code);
      this.handleExit(new AppServerError(message("app_server_exited", how)));
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "claude-codex-bridge", version: pluginVersion() },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  send(messageValue) {
    if (this.closed || !this.proc?.stdin?.writable) {
      throw this.exitError || new AppServerError(message("app_server_closed"));
    }
    this.proc.stdin.write(`${JSON.stringify(messageValue)}\n`);
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs, onDispatched } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new AppServerError(message("app_server_request_timeout", method)));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.send({ id, method, params });
        // Байты ушли. Для review/start это и есть граница расхода квоты:
        // доказать, что сервер их не обработал, уже нельзя.
        onDispatched?.();
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  handleLine(line) {
    let incoming;
    try {
      incoming = JSON.parse(line);
    } catch (error) {
      this.handleExit(new AppServerError(message("app_server_bad_json"), { cause: error }));
      killTree(this.proc?.pid);
      return;
    }

    // `null` и скаляры разбираются без ошибки, но обращение к полям такого
    // значения роняло бы воркер прямо в обработчике readline — без code-файла,
    // то есть задача осталась бы висеть до реконсиляции.
    if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
      this.handleExit(new AppServerError(message("app_server_bad_json")));
      killTree(this.proc?.pid);
      return;
    }

    if (incoming.id !== undefined && incoming.id !== null && incoming.method) {
      // В двунаправленном JSON-RPC сервер вправе использовать тот же id, что
      // и ещё не завершённый клиентский запрос: пространства id раздельны.
      try {
        this.send({
          id: incoming.id,
          error: { code: -32601, message: message("app_server_server_request_unsupported", incoming.method) },
        });
      } catch {}
      return;
    }

    if (incoming.id !== undefined && incoming.id !== null) {
      const pending = this.pending.get(incoming.id);
      if (pending) {
        this.pending.delete(incoming.id);
        if (incoming.error) {
          pending.reject(
            new AppServerError(incoming.error.message || message("app_server_rpc_failed", pending.method), {
              rpc: incoming.error,
            })
          );
        } else {
          pending.resolve(incoming.result ?? {});
        }
        return;
      }

      return;
    }

    if (incoming.method && this.onNotification) {
      try {
        this.onNotification(incoming);
      } catch {}
    }
  }

  handleExit(error) {
    if (this.exitError) return;
    this.exitError = error instanceof Error ? error : new AppServerError(String(error));
    for (const pending of this.pending.values()) pending.reject(this.exitError);
    this.pending.clear();
    this.resolveExit(this.exitError);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.readline?.close();
    try {
      this.proc?.stdin?.end();
    } catch {}
    if (!this.proc || this.proc.exitCode !== null) return;
    const exited = await Promise.race([this.exitPromise.then(() => true), sleep(CLOSE_GRACE_MS).then(() => false)]);
    if (!exited) {
      killTree(this.proc.pid);
      await Promise.race([this.exitPromise, sleep(CLOSE_GRACE_MS)]);
    }
  }
}

/**
 * Нативная цель review/start. Custom нужен, чтобы не терять поддерживаемый
 * прежним инструментом focus: сам ReviewTarget не умеет сочетать focus с base.
 */
export function appServerReviewTarget({ base, focus } = {}) {
  const f = String(focus || "").trim();
  if (f) {
    return {
      type: "custom",
      instructions: base
        ? message("app_server_custom_base_focus", base, f)
        : message("app_server_custom_focus", f),
    };
  }
  if (base) return { type: "baseBranch", branch: String(base) };
  return { type: "uncommittedChanges" };
}

function acceptedError(error, accepted) {
  if (error instanceof AppServerError) {
    error.reviewAccepted = accepted || error.reviewAccepted;
    return error;
  }
  return new AppServerError(error?.message || String(error), { reviewAccepted: accepted, cause: error });
}

/** Один полный нативный review/start, включая протокольную отмену. */
export async function runAppServerReview(options = {}) {
  let client;
  let dispatched = false;
  let accepted = false;
  let ids = null;
  let reviewText = "";
  let agentText = "";
  let settleTurn;
  const turnDone = new Promise((resolve) => {
    settleTurn = resolve;
  });

  // Счётчики токенов app-server шлёт отдельным уведомлением, а не полем
  // turn/completed, как exec. Без переноса лента нативного backend теряла бы
  // строку с расходом — единственное отличие от прежнего пути.
  let usage = null;
  const onNotification = (notification) => {
    if (notification?.method === "thread/tokenUsage/updated") {
      const total = notification.params?.tokenUsage?.total;
      if (total) {
        usage = {
          input_tokens: total.inputTokens ?? null,
          cached_input_tokens: total.cachedInputTokens ?? null,
          output_tokens: total.outputTokens ?? null,
          reasoning_output_tokens: total.reasoningOutputTokens ?? null,
        };
      }
      return;
    }
    const event = fromAppServerNotification(notification);
    if (!event) return;
    if (event.type === "turn.completed" && usage && !event.usage) event.usage = usage;
    options.onEvent?.(event);
    const item = event.item;
    const kind = item?.type || item?.item_type;
    if (event.type === "item.completed" && kind === "exitedReviewMode") {
      reviewText = String(item.review || "").trim();
    }
    if (event.type === "item.completed" && kind === "agentMessage") {
      agentText = String(item.text || "").trim();
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") settleTurn(event);
  };

  try {
    client = await AppServerClient.connect({ ...options, bin: options.bin, onNotification });
    const config = {};
    if (options.effort) config.model_reasoning_effort = options.effort;
    if (options.reasoningSummary) config.model_reasoning_summary = options.reasoningSummary;
    const thread = await client.request("thread/start", {
      cwd: options.cwd || process.cwd(),
      model: options.model || null,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      ...(Object.keys(config).length ? { config } : {}),
    });
    const sourceThreadId = thread.thread?.id;
    if (!sourceThreadId) throw new AppServerError(message("app_server_missing_thread"));
    if (options.signal?.aborted) {
      throw new AppServerError(message("app_server_cancelled_before_accept"), { cancelled: true });
    }

    // У review/start нет локального таймаута: после отправки нельзя доказать,
    // что сервер ещё не начал ревью. Таймаут здесь создал бы exec-fallback и
    // возможный второй расход квоты. Смерть процесса отклонит request сразу,
    // а общий таймаут worker'а приходит через signal.
    const reviewRequest = client.request(
      "review/start",
      {
        threadId: sourceThreadId,
        target: options.target || { type: "uncommittedChanges" },
        delivery: "inline",
      },
      {
        timeoutMs: 0,
        // Граница проходит по отправке, а не по ответу: если соединение умрёт
        // между записью запроса и ответом, сервер уже мог принять ревью в
        // работу, и exec-fallback стал бы вторым расходом квоты.
        onDispatched: () => {
          dispatched = true;
        },
      }
    );
    const beforeAcceptedAbort = new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
    });
    const reviewOutcome = await Promise.race([
      reviewRequest.then((response) => ({ kind: "response", response })),
      beforeAcceptedAbort,
    ]);
    if (reviewOutcome.kind === "aborted") {
      // request останется pending до close() в finally; обработчик не даёт его
      // будущему отклонению стать unhandled rejection.
      reviewRequest.catch(() => {});
      throw new AppServerError(message("app_server_cancelled_before_accept"), { cancelled: true });
    }
    const response = reviewOutcome.response;
    // Успешный JSON-RPC-ответ — граница расхода квоты. Даже если ответ
    // структурно испорчен, повторно запускать exec уже нельзя.
    accepted = true;
    const turnId = response.turn?.id;
    const threadId = response.reviewThreadId || sourceThreadId;
    if (!turnId) throw new AppServerError(message("app_server_missing_turn"));
    ids = { threadId, turnId };
    options.onAccepted?.(ids);

    if (options.signal?.aborted) {
      await client.request("turn/interrupt", ids, { timeoutMs: 5_000 });
      return { cancelled: true, accepted: true, ...ids, stderr: client.stderr };
    }

    const aborted = new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
    });
    const outcome = await Promise.race([
      turnDone.then((event) => ({ kind: "turn", event })),
      client.exitPromise.then((error) => ({ kind: "exit", error })),
      aborted,
    ]);

    if (outcome.kind === "aborted") {
      await client.request("turn/interrupt", ids, { timeoutMs: 5_000 });
      return { cancelled: true, accepted: true, ...ids, stderr: client.stderr };
    }
    if (outcome.kind === "exit") throw outcome.error;

    options.onSettled?.();
    const status = outcome.event.turn?.status;
    if (outcome.event.type === "turn.failed" || (status && status !== "completed")) {
      throw new AppServerError(
        outcome.event.error?.message || outcome.event.turn?.error?.message || message("app_server_review_failed", status || "failed")
      );
    }
    return {
      cancelled: false,
      accepted: true,
      ...ids,
      output: reviewText || agentText,
      stderr: client.stderr,
    };
  } catch (error) {
    // Явный JSON-RPC-отказ на review/start — доказательство, что ревью не
    // началось: тогда exec допустим. Любой другой исход после отправки запроса
    // неопределён, и второй reviewer запускать нельзя.
    const rejectedByServer = Boolean(error?.rpc);
    const wrapped = acceptedError(error, accepted || (dispatched && !rejectedByServer));
    if (client?.stderr) wrapped.stderr = client.stderr;
    throw wrapped;
  } finally {
    await client?.close().catch(() => {});
  }
}

/** Exec разрешён только пока review/start ещё не дал успешный ответ. */
export async function runAppServerReviewWithFallback(options, fallback) {
  if (options?.signal?.aborted) return { cancelled: true, accepted: false };
  try {
    return await runAppServerReview(options);
  } catch (error) {
    if (options?.signal?.aborted) return { cancelled: true, accepted: Boolean(error?.reviewAccepted) };
    if (error?.reviewAccepted || error?.cancelled) throw error;
    return fallback(error);
  }
}
