// image-core.mjs — генерация изображений ЧЕРЕЗ Codex CLI и его встроенный
// инструмент image_gen (модель gpt-image-2). Работает на ChatGPT-авторизации,
// внешних HTTP-запросов и API-ключей не требует.
//
// Ключевая тонкость: без явного запрета Codex склонен вместо встроенного
// инструмента написать скрипт к платному Images API. Промпт ниже этот путь
// закрывает жёстко.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { codexBinary } from "./codex-core.mjs";

export const PROMPT_MAX = 20_000;
export const ASPECT_RATIOS = ["1:1", "9:16", "16:9", "4:3", "3:4", "auto"];
export const RESOLUTIONS = ["1K", "2K", "4K"];
export const MAX_INPUT_IMAGES = 16;

/** Куда встроенный инструмент кладёт результат по умолчанию. */
const codexGenDir = () =>
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "generated_images");

// ------------------------------------------------------------------ валидация

export function validate({ prompt, aspect_ratio = "auto", image_resolution = "1K", images = [] }) {
  const errors = [];

  if (!prompt || !String(prompt).trim()) errors.push("prompt обязателен.");
  else if (String(prompt).length > PROMPT_MAX)
    errors.push(`prompt длиннее ${PROMPT_MAX} символов (сейчас ${String(prompt).length}).`);

  if (!ASPECT_RATIOS.includes(aspect_ratio))
    errors.push(`aspect_ratio должен быть одним из: ${ASPECT_RATIOS.join(", ")}.`);
  if (!RESOLUTIONS.includes(image_resolution))
    errors.push(`image_resolution должен быть одним из: ${RESOLUTIONS.join(", ")}.`);

  if (aspect_ratio === "auto" && image_resolution !== "1K")
    errors.push("при aspect_ratio=auto доступно только image_resolution=1K.");
  if (aspect_ratio === "1:1" && image_resolution === "4K")
    errors.push("при aspect_ratio=1:1 разрешение 4K недоступно.");

  if (!Array.isArray(images)) errors.push("images должен быть массивом.");
  else if (images.length > MAX_INPUT_IMAGES)
    errors.push(`входных изображений максимум ${MAX_INPUT_IMAGES} (передано ${images.length}).`);

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

// -------------------------------------------------------------------- промпт

function buildPrompt({ prompt, aspect_ratio, image_resolution, target, refs }) {
  const spec = [
    aspect_ratio !== "auto" ? `Соотношение сторон: ${aspect_ratio}.` : null,
    `Разрешение: ${image_resolution}.`,
    refs.length
      ? `К запросу приложено референсных изображений: ${refs.length}. Опирайся на них при генерации.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return `Сгенерируй изображение и сохрани его в файл.

ОПИСАНИЕ ИЗОБРАЖЕНИЯ:
${prompt}

ПАРАМЕТРЫ: ${spec}

КАК ЭТО СДЕЛАТЬ — соблюдай строго:
1. Используй свой ВСТРОЕННЫЙ инструмент генерации изображений (image_gen). Он работает на авторизации ChatGPT и входит в подписку.
2. НЕ пиши скриптов на Python, Node или bash. НЕ обращайся к внешним HTTP-API. НЕ используй OPENAI_API_KEY и никакие другие ключи. Любой такой путь означает платный вызов и считается невыполнением задачи.
3. Готовый файл должен оказаться ровно по пути:
   ${target}
   Если встроенный инструмент сохранил его в другое место (обычно ~/.codex/generated_images/), перемести файл туда, создав каталог при необходимости.
4. Последней строкой ответа выведи ровно: SAVED: ${target}
   Если сохранить не удалось — последней строкой выведи: FAILED: <причина>

Ничего другого в репозитории не меняй.`;
}

// -------------------------------------------------------------------- запуск

function resolveRefs(refs, cwd) {
  return refs.map((r) => {
    const s = String(r);
    if (/^https?:\/\//i.test(s)) {
      throw new Error(
        `Референс "${s}" — URL. Встроенный инструмент принимает локальные файлы: скачай изображение в проект и передай путь.`
      );
    }
    const abs = path.isAbsolute(s) ? s : path.join(cwd, s);
    if (!fs.existsSync(abs)) throw new Error(`Референс не найден: ${s}`);
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
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
    }
  } catch {}
  return best?.path || null;
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
    timeoutMs = Number(process.env.CODEX_BRIDGE_IMAGE_TIMEOUT_MS || 15) * 60_000,
  } = opts;

  const errors = validate({ prompt, aspect_ratio, image_resolution, images });
  if (errors.length) return { ok: false, error: errors.join("\n") };

  let refs;
  try {
    refs = resolveRefs(images, cwd);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const dir = path.isAbsolute(out_dir || "")
    ? out_dir
    : path.join(cwd, out_dir || process.env.CODEX_BRIDGE_IMAGE_DIR || "assets/generated");
  fs.mkdirSync(dir, { recursive: true });

  const file = `${slug(name || prompt)}-${crypto.randomBytes(3).toString("hex")}.png`;
  const target = path.join(dir, file);

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--cd",
    cwd,
  ];
  if (model) args.push("-m", model);
  for (const r of refs) args.push("--image", r);
  args.push("-");

  const startedAt = Date.now();
  const r = spawnSync(codexBinary(), args, {
    input: buildPrompt({ prompt, aspect_ratio, image_resolution, target, refs }),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    cwd,
  });

  if (r.error?.code === "ENOENT")
    return { ok: false, error: "Codex CLI не найден. Установи: npm install -g @openai/codex" };
  if (r.error?.code === "ETIMEDOUT")
    return {
      ok: false,
      error: `Генерация не уложилась в ${Math.round(timeoutMs / 60000)} мин. Обычно занимает 4–6 минут; при 4K бывает дольше.`,
    };
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };

  const out = (r.stdout || "").trim();

  // 1. Файл на месте — обычный случай.
  if (fs.existsSync(target)) {
    return { ok: true, path: target, bytes: fs.statSync(target).size, transcript: out };
  }

  // 2. Codex сохранил куда-то ещё, но сказал куда.
  const declared = /^SAVED:\s*(.+)$/m.exec(out)?.[1]?.trim();
  if (declared && fs.existsSync(declared)) {
    fs.copyFileSync(declared, target);
    return { ok: true, path: target, bytes: fs.statSync(target).size, moved: declared, transcript: out };
  }

  // 3. Забираем свежий файл из каталога Codex.
  const rescued = rescueGenerated(startedAt);
  if (rescued) {
    fs.copyFileSync(rescued, path.join(dir, path.basename(rescued)));
    const finalPath = path.join(dir, path.basename(rescued));
    return { ok: true, path: finalPath, bytes: fs.statSync(finalPath).size, moved: rescued, transcript: out };
  }

  const failed = /^FAILED:\s*(.+)$/m.exec(out)?.[1]?.trim();
  const suspectScript = /OPENAI_API_KEY|api\.openai\.com|images\/generations/i.test(out);
  return {
    ok: false,
    error:
      (failed ? `Codex сообщил об ошибке: ${failed}` : "Файл изображения не появился.") +
      (suspectScript
        ? "\nПохоже, Codex попытался обратиться к платному Images API вместо встроенного инструмента. Повтори запрос."
        : "") +
      `\n\nПоследние строки вывода Codex:\n${out.split("\n").slice(-15).join("\n")}`,
  };
}
