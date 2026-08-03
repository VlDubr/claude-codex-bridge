// codex-core.mjs — обёртка над Codex CLI + менеджер фоновых задач.
// Никаких внешних зависимостей: только node:*.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---------------------------------------------------------------- пути и стор

const JOB_ID_RE = /^job-[0-9a-f]{8}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function dataDir() {
  const base =
    process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), ".claude", "plugins", "data", "codex-bridge");
  const dir = path.join(base, "jobs");
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {}
  return dir;
}

/**
 * Единственная точка, где идентификатор превращается в путь.
 * Формат жёсткий, плюс проверка containment после resolve: идентификаторы
 * приходят от модели, поэтому "../../etc/passwd" здесь вполне вероятен.
 */
function jobPath(id, ext) {
  if (typeof id !== "string" || !JOB_ID_RE.test(id)) {
    throw new Error(`Недопустимый идентификатор задачи: ${JSON.stringify(id)}`);
  }
  const dir = dataDir();
  const p = path.resolve(dir, `${id}.${ext}`);
  if (path.dirname(p) !== path.resolve(dir)) {
    throw new Error(`Путь задачи вышел за пределы каталога: ${id}`);
  }
  return p;
}

export function isValidJobId(id) {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

function writeFileSecure(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: FILE_MODE });
  fs.renameSync(tmp, file); // атомарная замена в пределах одной ФС
}

function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id, "json"), "utf8"));
  } catch {
    return null;
  }
}

function writeJob(job) {
  writeFileSecure(jobPath(job.id, "json"), JSON.stringify(job, null, 2));
  return job;
}

function repoKey(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return (r.status === 0 ? r.stdout.trim() : cwd) || cwd;
}

// --------------------------------------------------------------- поиск codex

export function codexBinary() {
  return process.env.CODEX_BIN || "codex";
}

export function checkCodex() {
  const bin = codexBinary();
  const v = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (v.error) return { ok: false, reason: "not_installed", bin };
  const auth = spawnSync(bin, ["login", "status"], { encoding: "utf8" });
  const textOut = `${auth.stdout || ""}${auth.stderr || ""}`;
  const loggedIn = auth.status === 0 && !/not logged in|no credentials/i.test(textOut);
  return {
    ok: loggedIn,
    reason: loggedIn ? null : "not_logged_in",
    bin,
    version: (v.stdout || "").trim(),
    authInfo: textOut.trim(),
  };
}

// ------------------------------------------------- определение доступных флагов

// Набор флагов codex exec менялся между версиями: --ask-for-approval в ряде
// сборок отсутствует и вызывает "unexpected argument". Поэтому не угадываем,
// а один раз спрашиваем сам бинарь и кэшируем ответ.
let capsCache = null;

export function capabilities({ force = false } = {}) {
  if (capsCache && !force) return capsCache;

  const cacheFile = path.join(path.dirname(dataDir()), "exec-caps.json");
  const ver = (spawnSync(codexBinary(), ["--version"], { encoding: "utf8" }).stdout || "").trim();

  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (c.version === ver) return (capsCache = c.caps);
    } catch {}
  }

  const help = spawnSync(codexBinary(), ["exec", "--help"], { encoding: "utf8", timeout: 15_000 });
  const text = `${help.stdout || ""}${help.stderr || ""}`;
  const caps = {
    askForApproval: /--ask-for-approval/.test(text),
    sandbox: /--sandbox/.test(text),
    skipGitRepoCheck: /--skip-git-repo-check/.test(text),
    cd: /--cd\b/.test(text),
    image: /--image\b/.test(text),
    // help не прочитался — не выключаем базовые флаги, но и не включаем спорные
    probed: text.trim().length > 0,
  };
  if (!caps.probed) {
    caps.sandbox = true;
    caps.skipGitRepoCheck = true;
    caps.cd = true;
    caps.image = true;
  }

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: DIR_MODE });
    writeFileSecure(cacheFile, JSON.stringify({ version: ver, caps }, null, 2));
  } catch {}
  return (capsCache = caps);
}

// ------------------------------------------------------------- сборка команды

const SANDBOX_BY_MODE = {
  ask: "read-only",
  review: "read-only",
  challenge: "read-only",
  delegate: "workspace-write",
};

export function buildArgs({ mode, model, effort, cwd, sandbox, images = [] }) {
  const caps = capabilities();
  const args = ["exec"];
  if (caps.skipGitRepoCheck) args.push("--skip-git-repo-check");

  const sb = sandbox || SANDBOX_BY_MODE[mode] || "read-only";
  if (caps.sandbox) args.push("--sandbox", sb);
  // exec и так неинтерактивен; флаг добавляем только если он существует
  if (sb === "workspace-write" && caps.askForApproval) args.push("--ask-for-approval", "never");
  if (cwd && caps.cd) args.push("--cd", cwd);

  const m = model || process.env.CODEX_BRIDGE_MODEL;
  if (m) args.push("-m", m);
  const e = effort || process.env.CODEX_BRIDGE_EFFORT;
  if (e) args.push("-c", `model_reasoning_effort="${e}"`);
  if (caps.image) for (const img of images) args.push("--image", img);

  args.push("-"); // промпт со stdin
  return args;
}

// ------------------------------------------------------------ сбор контекста

export function collectDiff(cwd, base) {
  const run = (a) => spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let out = "";
  if (base) {
    const mb = run(["merge-base", base, "HEAD"]);
    const ref = mb.status === 0 ? mb.stdout.trim() : base;
    out = run(["diff", `${ref}...HEAD`]).stdout || "";
  } else {
    out = run(["diff", "HEAD"]).stdout || "";
    const untracked = (run(["ls-files", "--others", "--exclude-standard"]).stdout || "")
      .split("\n")
      .filter(Boolean);
    if (untracked.length) out += `\n\n[Новые неотслеживаемые файлы]\n${untracked.join("\n")}\n`;
  }
  const LIMIT = 200_000;
  if (out.length > LIMIT) out = out.slice(0, LIMIT) + `\n\n[... диф обрезан на ${LIMIT} символах ...]`;
  return out.trim();
}

// ------------------------------------------------------------ шаблоны промптов

const PROMPTS = {
  review: (diff, extra) => `Ты выступаешь ревьюером кода. Работай только на чтение: ничего не меняй.

Проведи тщательное ревью изменений ниже. Разбей вывод на:
1. Блокеры — то, что нельзя мержить.
2. Важное — баги, дыры, гонки, утечки, неучтённые ошибки.
3. Мелочи — стиль, именование, мёртвый код.

Для каждого пункта дай файл:строку и конкретное предложение. Если что-то непонятно из дифа — прочитай нужные файлы в репозитории. Не хвали код, если хвалить не за что; пустая секция лучше воды.
${extra ? `\nДополнительный фокус от пользователя: ${extra}\n` : ""}
=== ИЗМЕНЕНИЯ ===
${diff || "(диф пуст — посмотри рабочее дерево сам)"}`,

  challenge: (diff, focus) => `Ты выступаешь состязательным ревьюером. Твоя задача — не найти опечатки, а оспорить решение.

Работай только на чтение. Ответь на:
- Какие неявные допущения зашиты в этот дизайн и что будет, если они не выполнятся?
- Какой сценарий отказа авторы не рассмотрели? (гонки, частичный откат, потеря данных, ретраи, деградация зависимостей)
- Существует ли принципиально более простой или более безопасный подход? Если да — опиши его и честно назови, чем он хуже.
- Что сломается при 100x нагрузке или при откате релиза?

Не соглашайся из вежливости. Если решение действительно хорошее — скажи это прямо и укажи, при каких условиях оно перестанет быть хорошим.
${focus ? `\nПользователь просит сфокусироваться на: ${focus}\n` : ""}
=== ИЗМЕНЕНИЯ ===
${diff || "(диф пуст — посмотри рабочее дерево сам)"}`,

  delegate: (task) => `Тебе делегирована задача в этом репозитории. Ты можешь читать и изменять файлы, запускать тесты и команды сборки.

ЗАДАЧА:
${task}

Порядок работы:
1. Сначала разберись в причине, а не в симптоме. Покажи, чем подтверждается диагноз.
2. Сделай минимальное безопасное изменение.
3. Проверь себя: запусти релевантные тесты или линтер, если они есть.
4. В конце выдай сводку: что было не так, что изменил (список файлов), как проверил, что осталось незакрытым.

Не переписывай то, о чём не просили. Если задача сформулирована неоднозначно — выбери разумную трактовку и явно назови её в сводке.`,

  ask: (question, context) => `К тебе обращается другая модель (Claude), работающая над задачей в этом репозитории. Она просит второе мнение.

${context ? `КОНТЕКСТ ОТ CLAUDE:\n${context}\n\n` : ""}ВОПРОС:
${question}

Ответь по существу и сжато. Можешь читать файлы репозитория, чтобы проверить факты. Если ты не согласен с посылкой вопроса — скажи об этом прямо, это ценнее вежливого согласия. Если уверенности нет — обозначь степень уверенности.`,
};

export function buildPrompt({ mode, task, focus, question, context, cwd, base }) {
  if (mode === "delegate") return PROMPTS.delegate(task);
  if (mode === "ask") return PROMPTS.ask(question, context);
  const diff = collectDiff(cwd, base);
  return mode === "challenge" ? PROMPTS.challenge(diff, focus) : PROMPTS.review(diff, focus);
}

// ---------------------------------------------------------- синхронный запуск

export function runSync(opts) {
  const { timeoutMs = 240_000 } = opts;
  const prompt = opts.prompt || buildPrompt(opts);
  const r = spawnSync(codexBinary(), buildArgs(opts), {
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    cwd: opts.cwd || process.cwd(),
  });

  if (r.error?.code === "ETIMEDOUT")
    return { ok: false, error: `Codex не ответил за ${Math.round(timeoutMs / 1000)}с. Запусти это же в фоне.` };
  if (r.error?.code === "ENOENT")
    return { ok: false, error: "Codex CLI не найден. Установи: npm install -g @openai/codex" };
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };

  const out = (r.stdout || "").trim();
  const errText = (r.stderr || "").trim();

  // Ненулевой код — всегда ошибка, даже если что-то успело напечататься:
  // частичный отчёт, выданный за успех, опаснее пустого отказа.
  if (r.status !== 0) {
    return {
      ok: false,
      exitCode: r.status,
      partialOutput: out || null,
      error:
        `Codex завершился с кодом ${r.status}.` +
        (errText ? `\n${errText.slice(0, 800)}` : "") +
        (out ? `\n\nЧастичный вывод (не считать результатом):\n${out.slice(0, 800)}` : ""),
    };
  }
  return { ok: true, output: out, stderr: errText };
}

// ------------------------------------------------------------- фоновые задачи

const TERMINAL = new Set(["done", "failed", "cancelled", "timeout", "unknown"]);

/**
 * Фоновая задача запускается через /bin/sh, который перенаправляет вывод и
 * атомарно записывает код возврата в отдельный файл. Это единственный источник
 * истины о завершении: обработчик child.on("exit") в родителе не переживает
 * перезапуск MCP-сервера и создавал гонку с cancelJob().
 * Промпт и пути передаются позиционными аргументами, а не подстановкой в
 * строку команды, поэтому шелл-инъекция невозможна.
 */
export function startJob(opts) {
  const id = `job-${crypto.randomBytes(4).toString("hex")}`;
  const cwd = opts.cwd || process.cwd();
  const prompt = opts.prompt || buildPrompt({ ...opts, cwd });

  const promptFile = jobPath(id, "prompt");
  const outFile = jobPath(id, "out");
  const codeFile = jobPath(id, "code");
  writeFileSecure(promptFile, prompt);

  const args = buildArgs({ ...opts, cwd });
  const script =
    'BIN="$1"; PROMPT="$2"; OUT="$3"; CODE="$4"; shift 4; ' +
    '"$BIN" "$@" < "$PROMPT" >> "$OUT" 2>&1; ' +
    'printf %s "$?" > "$CODE.tmp" && mv "$CODE.tmp" "$CODE"';

  const child = spawn("/bin/sh", ["-c", script, "sh", codexBinary(), promptFile, outFile, codeFile, ...args], {
    cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"], // редирект делает сам sh — дескрипторы не текут
  });
  child.unref();

  return writeJob({
    id,
    pid: child.pid,
    mode: opts.mode,
    model: opts.model || process.env.CODEX_BRIDGE_MODEL || null,
    effort: opts.effort || process.env.CODEX_BRIDGE_EFFORT || null,
    label: String(opts.task || opts.focus || opts.question || opts.mode || "").slice(0, 120),
    cwd,
    repo: repoKey(cwd),
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // процесс есть, но чужой
  }
}

function readExitCode(id) {
  try {
    const raw = fs.readFileSync(jobPath(id, "code"), "utf8").trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

/** Приводит статус в соответствие с реальностью. Терминальные не трогает. */
function reconcile(job) {
  if (!job?.id || TERMINAL.has(job.status)) return job;

  const code = readExitCode(job.id);
  if (code !== null) {
    job.status = code === 0 ? "done" : "failed";
    job.exitCode = code;
    job.finishedAt = job.finishedAt || new Date().toISOString();
    return writeJob(job);
  }

  if (!alive(job.pid)) {
    // Процесса нет, кода возврата нет — считать успехом нельзя.
    job.status = "unknown";
    job.note = "Процесс исчез, не записав код возврата. Результат недостоверен.";
    job.finishedAt = job.finishedAt || new Date().toISOString();
    return writeJob(job);
  }

  const limit = Number(process.env.CODEX_BRIDGE_JOB_TIMEOUT_MIN || 30) * 60_000;
  if (Date.now() - new Date(job.startedAt).getTime() > limit) {
    killGroup(job.pid);
    job.status = "timeout";
    job.finishedAt = new Date().toISOString();
    return writeJob(job);
  }
  return job;
}

function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

export function listJobs(cwd) {
  const dir = dataDir();
  const repo = repoKey(cwd || process.cwd());
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter(isValidJobId)
    .map(readJob)
    .filter(Boolean)
    .filter((j) => !repo || j.repo === repo)
    .map(reconcile)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

export function latestJob(cwd) {
  return listJobs(cwd)[0] || null;
}

export function resolveJob(id, cwd) {
  if (id === undefined || id === null || id === "") return latestJob(cwd);
  if (!isValidJobId(id)) return null;
  const j = readJob(id);
  return j ? reconcile(j) : null;
}

export function jobOutput(id, { tail = 0 } = {}) {
  let textOut = "";
  try {
    textOut = fs.readFileSync(jobPath(id, "out"), "utf8");
  } catch {
    return "";
  }
  return tail > 0 ? textOut.split("\n").slice(-tail).join("\n") : textOut;
}

export function cancelJob(id) {
  if (!isValidJobId(id)) return { ok: false, error: `Недопустимый идентификатор задачи: ${id}` };
  const job = readJob(id);
  if (!job) return { ok: false, error: `Задача ${id} не найдена.` };
  if (TERMINAL.has(job.status)) return { ok: true, job, note: `Уже в статусе ${job.status}.` };

  killGroup(job.pid);
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  writeJob(job); // cancelled терминален — reconcile его больше не тронет
  return { ok: true, job };
}

export function humanAge(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}с`;
  if (s < 3600) return `${Math.round(s / 60)}м`;
  return `${(s / 3600).toFixed(1)}ч`;
}
