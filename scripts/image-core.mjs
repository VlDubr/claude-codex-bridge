// image-core.mjs — генерация изображений ЧЕРЕЗ Codex CLI и его встроенный
// инструмент image_gen (модель gpt-image-2). Работает на ChatGPT-авторизации,
// внешних HTTP-запросов и API-ключей не требует.
//
// Ключевая тонкость: без явного запрета Codex склонен вместо встроенного
// инструмента написать скрипт к платному Images API. Промпт ниже этот путь
// закрывает жёстко.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { codexBinary, denoise, explainCodexFailure, envClean, bypassSandboxEnabled, capabilities } from "./codex-core.mjs";
import { extractOutput, progressTrail } from "./codex-events.mjs";
import { prompt as imagePrompt, message } from "./i18n-image.mjs";
import { killTree, isWindows } from "./proc.mjs";

export const PROMPT_MAX = 20_000;
export const ASPECT_RATIOS = ["1:1", "9:16", "16:9", "4:3", "3:4", "auto"];
export const RESOLUTIONS = ["1K", "2K", "4K"];
export const MAX_INPUT_IMAGES = 16;

/** Куда встроенный инструмент кладёт результат по умолчанию. */
const codexGenDir = () =>
  path.join(envClean("CODEX_HOME") || path.join(os.homedir(), ".codex"), "generated_images");

// ------------------------------------------------------------------ валидация

export function validate({ prompt, aspect_ratio = "auto", image_resolution = "1K", images = [] }) {
  const errors = [];

  if (!prompt || !String(prompt).trim()) errors.push(message("prompt_required"));
  else if (String(prompt).length > PROMPT_MAX)
    errors.push(message("prompt_too_long", PROMPT_MAX, String(prompt).length));

  if (!ASPECT_RATIOS.includes(aspect_ratio))
    errors.push(message("aspect_ratio_invalid", ASPECT_RATIOS));
  if (!RESOLUTIONS.includes(image_resolution))
    errors.push(message("resolution_invalid", RESOLUTIONS));

  if (aspect_ratio === "auto" && image_resolution !== "1K")
    errors.push(message("auto_requires_1k"));
  if (aspect_ratio === "1:1" && image_resolution === "4K")
    errors.push(message("square_4k_unavailable"));

  if (!Array.isArray(images)) errors.push(message("images_must_be_array"));
  else if (images.length > MAX_INPUT_IMAGES)
    errors.push(message("too_many_images", MAX_INPUT_IMAGES, images.length));

  return errors;
}

// ------------------------------------------------------------------- имена

const TRANSLIT = {
  а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",
  н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",
  ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya",
};

function slug(s, max = 40) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[\u0400-\u04FF]/g, (c) => TRANSLIT[c] ?? "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "image"
  );
}

// ------------------------------------------------------- проверки результата

const MAGIC = [
  { ext: ".png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: ".jpg", bytes: [0xff, 0xd8, 0xff] },
  { ext: ".gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

/** Формат определяется по сигнатуре, а не по расширению и не по словам Codex. */
export function sniffImage(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    if (read < 12) return null;
    for (const m of MAGIC) {
      if (m.bytes.every((b, i) => buf[i] === b)) return m.ext;
    }
    // WebP: RIFF....WEBP
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
      return ".webp";
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** Путь обязан остаться внутри корня: out_dir приходит от модели. */
function realPathWithMissingTail(candidate) {
  let current = path.resolve(candidate);
  const tail = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      return path.resolve(real, ...tail);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
      const parent = path.dirname(current);
      if (parent === current) throw e;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isRealPathInside(root, candidate) {
  const rootReal = realPathWithMissingTail(root);
  const candidateReal = realPathWithMissingTail(candidate);
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveInside(root, candidate, what) {
  const rootAbs = path.resolve(root);
  if (path.isAbsolute(candidate)) {
    throw new Error(message("absolute_path", what, candidate));
  }
  const abs = path.resolve(rootAbs, candidate);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(message("outside_project", what, candidate));
  }
  try {
    if (!isRealPathInside(rootAbs, abs)) {
      throw new Error(message("outside_project", what, candidate));
    }
  } catch (e) {
    if (e?.message === message("outside_project", what, candidate)) throw e;
    // Ошибка разрешения реального пути — отказ по умолчанию: считать путь
    // безопасным без проверки существующего предка нельзя.
    throw new Error(message("outside_project", what, candidate));
  }
  return abs;
}

/** Разрешено забирать файл только из проекта или из каталога Codex. */
function acceptableSource(file, cwd) {
  const abs = path.resolve(file);
  const roots = [path.resolve(cwd), path.resolve(codexGenDir())];
  try {
    return roots.some((r) => isRealPathInside(r, abs));
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- промпт

function buildPrompt({ prompt, aspect_ratio, image_resolution, target, refs }) {
  return imagePrompt("generate", {
    description: prompt,
    aspectRatio: aspect_ratio,
    resolution: image_resolution,
    target,
    referenceCount: refs.length,
  });
}

// -------------------------------------------------------------------- запуск

function resolveRefs(refs, cwd) {
  return refs.map((r) => {
    const s = String(r);
    if (/^https?:\/\//i.test(s)) {
      throw new Error(message("reference_url", s));
    }
    const abs = resolveInside(cwd, s, message("reference_label", s));
    if (!fs.existsSync(abs)) throw new Error(message("reference_not_found", s));
    return abs;
  });
}

/** Ищет свежесозданный файл в каталоге Codex, если тот проигнорировал целевой путь. */
function rescueGenerated(sinceMs) {
  const dir = codexGenDir();
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (!st.isFile() || st.mtimeMs < sinceMs) continue;
      if (!sniffImage(p)) continue; // не изображение — не наш артефакт
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
    }
  } catch {}
  return best?.path || null;
}

function runCodexAsync(command, args, { input, cwd, timeoutMs, signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      return resolve({ stdout: "", stderr: "", status: null, aborted: true });
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: !isWindows,
        windowsHide: true,
      });
    } catch (error) {
      return resolve({ stdout: "", stderr: "", status: null, error });
    }

    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let spawnError = null;
    let aborted = false;
    let timedOut = false;
    let overflow = false;
    let timer = null;

    const stop = () => killTree(child.pid);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const collect = (chunks) => (chunk) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        overflow = true;
        stop();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => { spawnError = error; });
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
    }

    child.on("close", (status, exitSignal) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      const error = spawnError ||
        (timedOut ? Object.assign(new Error("generation timeout"), { code: "ETIMEDOUT" }) : null) ||
        (overflow ? Object.assign(new Error("output exceeded maxBuffer"), { code: "ENOBUFS" }) : null);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
        signal: exitSignal,
        error,
        aborted,
      });
    });
  });
}

/**
 * Аргументы запуска `codex exec` для генерации.
 *
 * Флаги не угадываются: набор `codex exec` менялся между версиями, и
 * `--ask-for-approval` в свежих сборках (0.146.0) подкомандой exec уже не
 * принимается, хотя у верхнеуровневого `codex` остался. Поэтому здесь та же
 * проверка через capabilities(), что и в buildArgs() из codex-core.mjs.
 */
export function buildImageArgs({ cwd, model, refs = [] }) {
  const caps = capabilities();
  const args = ["exec"];
  if (caps.json) args.push("--json");
  args.push("--skip-git-repo-check");
  if (bypassSandboxEnabled()) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write");
    if (caps.askForApproval) args.push("--ask-for-approval", "never");
  }
  args.push("--cd", cwd);
  if (model) args.push("-m", model);
  for (const r of refs) args.push("--image", r);
  args.push("-");
  return args;
}

export function generateImage(opts) {
  const {
    prompt,
    aspect_ratio = "auto",
    image_resolution = "1K",
    images = [],
    model,
    out_dir,
    name,
    cwd = process.cwd(),
    timeoutMs = (Number(envClean("CODEX_BRIDGE_IMAGE_TIMEOUT_MIN")) || 15) * 60_000,
    signal,
  } = opts;

  const errors = validate({ prompt, aspect_ratio, image_resolution, images });
  if (errors.length) return { ok: false, error: errors.join("\n") };

  let refs;
  try {
    refs = resolveRefs(images, cwd);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  let dir;
  try {
    dir = resolveInside(cwd, out_dir || envClean("CODEX_BRIDGE_IMAGE_DIR") || "assets/generated", "out_dir");
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!isRealPathInside(cwd, dir)) {
      return { ok: false, error: message("outside_project", "out_dir", out_dir || dir) };
    }
  } catch {
    return { ok: false, error: message("outside_project", "out_dir", out_dir || dir) };
  }

  const file = `${slug(name || prompt)}-${crypto.randomBytes(3).toString("hex")}.png`;
  const target = path.join(dir, file);

  const args = buildImageArgs({ cwd, model, refs });

  const startedAt = Date.now();
  const input = buildPrompt({ prompt, aspect_ratio, image_resolution, target, refs });
  const execution = signal
    ? runCodexAsync(codexBinary(), args, { input, cwd, timeoutMs, signal })
    : spawnSync(codexBinary(), args, {
        input,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        cwd,
      });

  const finish = (r) => {
  if (r.aborted)
    return { ok: false, aborted: true, error: message("generation_cancelled") };

  if (r.error?.code === "ENOENT")
    return { ok: false, error: message("codex_not_found") };
  if (r.error?.code === "ETIMEDOUT")
    return {
      ok: false,
      error: message("generation_timeout", Math.round(timeoutMs / 60000)),
    };
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };

  const parsed = extractOutput(r.stdout);
  const out = denoise(parsed.text);
  const errText = denoise(r.stderr);
  const trail = progressTrail(parsed.events, { limit: 8 });
  const tailOf = (t) => (trail.length ? trail.map((l) => `  · ${l}`).join("\n") : t.split("\n").slice(-15).join("\n"));

  // Код возврата проверяем ДО поиска файлов: иначе подберём чужой артефакт
  // и выдадим провалившийся запуск за успех.
  if (r.status !== 0) {
    const reason = explainCodexFailure(errText, out);
    return {
      ok: false,
      error: message("codex_failed", r.status, reason, errText, tailOf(out)),
    };
  }

  const accept = (file, note) => {
    const ext = sniffImage(file);
    if (!ext) {
      return {
        ok: false,
        error: message("not_image", file),
      };
    }
    const finalPath = file.startsWith(dir + path.sep)
      ? file
      : path.join(dir, path.basename(target, ".png") + ext);
    if (finalPath !== file) fs.copyFileSync(file, finalPath);
    // Расширение приводим к реальному формату
    const wanted = finalPath.replace(/\.[^.]+$/, ext);
    if (wanted !== finalPath) {
      fs.renameSync(finalPath, wanted);
      return { ok: true, path: wanted, bytes: fs.statSync(wanted).size, moved: note, transcript: out };
    }
    return { ok: true, path: finalPath, bytes: fs.statSync(finalPath).size, moved: note, transcript: out };
  };

  // 1. Файл на месте — обычный случай.
  if (fs.existsSync(target)) return accept(target, null);

  // 2. Codex сохранил в другое место и назвал его. Принимаем путь только если
  //    он внутри проекта или каталога генерации Codex.
  const declared = /^SAVED:\s*(.+)$/m.exec(out)?.[1]?.trim();
  if (declared && fs.existsSync(declared)) {
    if (!acceptableSource(declared, cwd)) {
      return {
        ok: false,
        error: message("source_outside_allowed_roots", declared, codexGenDir()),
      };
    }
    return accept(declared, declared);
  }

  // 3. Свежий файл в каталоге Codex — но только настоящее изображение.
  const rescued = rescueGenerated(startedAt);
  if (rescued) return accept(rescued, rescued);

  const failed = /^FAILED:\s*(.+)$/m.exec(out)?.[1]?.trim();
  // Признаки ухода на платный API ищем во всём потоке, а не только в ответе:
  // попытка обычно видна в событии command_execution.
  const suspectScript = /OPENAI_API_KEY|api\.openai\.com|images\/generations/i.test(
    `${out}\n${JSON.stringify(parsed.events)}`
  );
  return {
    ok: false,
    error: message("generation_missing", failed, suspectScript, tailOf(out)),
  };
  };

  return execution?.then ? execution.then(finish) : finish(execution);
}
