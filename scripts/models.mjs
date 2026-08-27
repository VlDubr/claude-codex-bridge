// models.mjs — динамический список моделей Codex.
// Источник истины: `codex debug models` (каталог после слияния всех слоёв
// конфигурации). Ничего не хардкодим: список моделей меняется, а устаревший
// хардкод приводит к вызовам несуществующих моделей.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexBinary, dataDir, envClean } from "./codex-core.mjs";
import { message } from "./i18n-runtime.mjs";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 часов
const cachePath = () => path.join(path.dirname(dataDir()), "models-cache.json");

/** Вытаскивает записи моделей из произвольной формы JSON-каталога. */
export function parseCatalog(payload) {
  const out = [];
  const seen = new Set();

  const push = (id, node) => {
    if (!id || typeof id !== "string" || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      label: node?.display_name || node?.label || node?.name || null,
      efforts: node?.supported_reasoning_efforts || node?.reasoning_efforts || node?.efforts || null,
      visibility: node?.visibility || null,
      default: node?.is_default === true || node?.default === true || undefined,
    });
  };

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);

    const id = node.id || node.slug || node.model || node.model_id;
    // Отличаем запись модели от произвольного объекта с полем id
    if (typeof id === "string" && (node.display_name || node.label || node.name || node.slug || node.visibility)) {
      push(id, node);
    }
    for (const [k, v] of Object.entries(node)) {
      // Каталоги часто выглядят как { "gpt-5.6-sol": {...} }
      if (v && typeof v === "object" && !Array.isArray(v) && /^[a-z0-9][\w.\-]*$/i.test(k) && (v.display_name || v.label || v.supported_reasoning_efforts || v.visibility)) {
        push(k, v);
      }
      walk(v);
    }
  };

  walk(payload);
  return out;
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (Date.now() - c.at < CACHE_TTL_MS && Array.isArray(c.models) && c.models.length) return c;
  } catch {}
  return null;
}

function writeCache(models, source, complete) {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath(), JSON.stringify({ at: Date.now(), source, complete, models }, null, 2), {
      mode: 0o600,
    });
  } catch {}
}

/** Спрашивает у Codex его каталог моделей. */
export function fetchModels({ force = false } = {}) {
  if (!force) {
    const c = readCache();
    if (c) return { ok: true, models: c.models, source: c.source, complete: c.complete !== false, cached: true };
  }

  const r = spawnSync(codexBinary(), ["debug", "models"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (r.error?.code === "ENOENT") {
    return { ok: false, error: message("models_cli_not_found") };
  }

  const raw = (r.stdout || "").trim();
  if (raw) {
    // Каталог может быть окружён служебным текстом — берём первый JSON-блок.
    // Каталог может быть окружён служебными строками с обеих сторон, поэтому
    // пробуем сузить срез справа, а не только слева.
    const start = raw.search(/[[{]/);
    if (start >= 0) {
      const tail = raw.slice(start);
      // Каталог бывает массивом, а не объектом, поэтому границы ищутся по обеим
      // закрывающим скобкам сразу: прежний перебор предпочитал последнюю «}» и
      // пропускал более позднюю «]», то есть массив объектов не разбирался.
      const ends = [];
      for (let i = tail.length; i > 1; i--) {
        if (tail[i - 1] === "}" || tail[i - 1] === "]") ends.push(i);
      }
      for (const end of ends) {
        try {
          const models = parseCatalog(JSON.parse(tail.slice(0, end)));
          if (models.length) {
            writeCache(models, "codex debug models", true);
            return { ok: true, models, source: "codex debug models", complete: true };
          }
        } catch {}
      }
    }
  }

  // Запасной путь: каталог, объявленный пользователем в config.toml.
  const fromConfig = modelsFromConfig();
  if (fromConfig.length) {
    writeCache(fromConfig, "config.toml", false);
    // complete: false — это не каталог, а лишь то, что пользователь прописал
    // сам. Блокировать по нему чужие имена моделей нельзя.
    return { ok: true, models: fromConfig, source: "config.toml", complete: false, degraded: true };
  }

  const stale = (() => {
    try {
      return JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    } catch {
      return null;
    }
  })();
  if (stale?.models?.length) {
    return {
      ok: true,
      models: stale.models,
      source: message("models_stale_source", stale.source),
      complete: stale.complete !== false,
      degraded: true,
    };
  }

  return {
    ok: false,
    error: message("models_fetch_failed", r.status, (r.stderr || "").trim()),
  };
}

/** Модель и профиль, объявленные в config.toml — как подсказка и как fallback. */
export function modelsFromConfig() {
  const found = new Map();
  const files = [
    path.join(os.homedir(), ".codex", "config.toml"),
    path.join(process.cwd(), ".codex", "config.toml"),
  ];
  for (const f of files) {
    let s;
    try {
      s = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of s.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm)) {
      found.set(m[1], { id: m[1], label: null, efforts: null });
    }
  }
  return [...found.values()];
}

/** Есть ли такая модель в каталоге. Неизвестный каталог => не блокируем. */
export function knownModel(id) {
  if (!id) return { known: true };
  const r = fetchModels();
  if (!r.ok) return { known: true, unverified: true };
  const hit = r.models.find((m) => m.id === id);
  if (hit) return { known: true, model: hit };
  // Каталог неполный (получен обходным путём) — запрещать по нему нельзя:
  // отклонили бы вполне рабочую модель. Пропускаем с пометкой.
  if (r.complete === false) return { known: true, unverified: true, source: r.source };
  return { known: false, available: r.models.map((m) => m.id) };
}

/**
 * Все уровни усилий, встречающиеся в линейке. Конкретная модель принимает лишь
 * подмножество: gpt-5.6-sol отвергает `minimal` ошибкой API, а модели прошлых
 * поколений его принимают. Поэтому список здесь широкий — он нужен только для
 * схемы MCP-инструмента, а настоящую фильтрацию делает каталог модели.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Уровни, поддерживаемые конкретной моделью, или null если неизвестно. */
export function effortsFor(id) {
  if (!id) return null;
  const r = fetchModels();
  if (!r.ok || r.complete === false) return null;
  const hit = r.models.find((m) => m.id === id);
  return Array.isArray(hit?.efforts) && hit.efforts.length ? hit.efforts : null;
}

/**
 * Проверяет уровень усилий против каталога. Блокирует только когда точно
 * известно, что модель его не примет: иначе получили бы ту же болезнь, что и
 * с зашитыми списками моделей.
 */
export function validateEffort(model, effort) {
  if (!effort) return null;
  if (!EFFORT_LEVELS.includes(effort)) {
    return message("effort_unknown", effort, EFFORT_LEVELS);
  }
  const supported = effortsFor(model || envClean("TANDEM_MODEL"));
  if (supported && !supported.includes(effort)) {
    return message("effort_unsupported", model || envClean("TANDEM_MODEL"), effort, supported);
  }
  return null;
}

export function formatModels(r) {
  if (!r.ok) return r.error;
  const lines = r.models.map((m) => {
    const bits = [m.id];
    if (m.label && m.label !== m.id) bits.push(`— ${m.label}`);
    if (m.efforts?.length) bits.push(`[effort: ${m.efforts.join(", ")}]`);
    else bits.push(message("models_effort_missing"));
    if (m.default) bits.push(message("models_default"));
    return "  " + bits.join(" ");
  });
  return [
    message("models_header", r.source, r.cached),
    ...lines,
    r.complete === false
      ? message("models_incomplete")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
