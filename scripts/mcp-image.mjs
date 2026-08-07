#!/usr/bin/env node
// MCP stdio-сервер: генерация изображений через встроенный инструмент Codex.

import path from "node:path";
import { serve, text, fail } from "./mcp-lib.mjs";
import { pluginVersion } from "./version.mjs";
import { probeCodex, envClean } from "./codex-core.mjs";
import {
  generateImage,
  validate,
  ASPECT_RATIOS,
  RESOLUTIONS,
  PROMPT_MAX,
  MAX_INPUT_IMAGES,
} from "./image-core.mjs";

const TOOLS = [
  {
    name: "image_generate",
    description:
      "Сгенерировать изображение через встроенный инструмент Codex (gpt-image-2) и сохранить в проект. Работает на подписке ChatGPT, API-ключ не нужен. Занимает 4–6 минут. Возвращает путь к файлу — ОБЯЗАТЕЛЬНО открой его инструментом Read и убедись, что картинка отвечает задаче, прежде чем отчитываться пользователю.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: `Описание изображения, до ${PROMPT_MAX} символов. Пиши конкретно: объект, композиция, стиль, освещение, палитра, что НЕ должно попасть в кадр.`,
        },
        aspect_ratio: { type: "string", enum: ASPECT_RATIOS, default: "auto" },
        image_resolution: { type: "string", enum: RESOLUTIONS, default: "1K" },
        images: {
          type: "array",
          maxItems: MAX_INPUT_IMAGES,
          items: { type: "string" },
          description:
            "Референсы: пути к ЛОКАЛЬНЫМ файлам относительно корня проекта. URL не принимаются — скачай изображение в проект. Прикрепляются к запросу флагом --image.",
        },
        out_dir: { type: "string", description: "Куда сохранить, относительно корня проекта." },
        name: { type: "string", description: "Основа имени файла." },
        model: {
          type: "string",
          description:
            "Модель Codex, которая ведёт сессию генерации. Список — через codex_models. Само изображение в любом случае рисует gpt-image-2.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "image_check_params",
    description: "Проверить сочетание параметров локально, не запуская дорогую генерацию.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        aspect_ratio: { type: "string" },
        image_resolution: { type: "string" },
        images: { type: "array", items: { type: "string" } },
      },
      required: ["prompt"],
    },
  },
];

const root = () => envClean("CLAUDE_PROJECT_DIR") || process.cwd();

async function handle(name, args) {
  if (name === "image_check_params") {
    const errors = validate({
      prompt: args.prompt,
      aspect_ratio: args.aspect_ratio || "auto",
      image_resolution: args.image_resolution || "1K",
      images: args.images || [],
    });
    return errors.length
      ? fail(`Параметры не пройдут:\n- ${errors.join("\n- ")}`)
      : text("Параметры корректны, можно генерировать.");
  }

  if (name !== "image_generate") return fail(`Неизвестный инструмент: ${name}`);

  const c = await probeCodex();
  if (c.reason === "not_installed")
    return fail("Codex CLI не найден. Установи: npm install -g @openai/codex — затем codex login.");
  if (c.reason === "not_logged_in")
    return fail("Codex не авторизован. Выполни в терминале: codex login (вход через аккаунт ChatGPT).");
  if (c.reason === "probe_timeout")
    return fail(
      "Проверка готовности Codex не завершилась за отведённое время. Сам Codex при этом может быть исправен. Проверь вручную: codex login status."
    );

  const cwd = root();
  const r = generateImage({ ...args, cwd });
  if (!r.ok) return fail(r.error);

  const rel = path.relative(cwd, r.path) || r.path;
  return text(
    [
      `Готово: ${rel} (${Math.round(r.bytes / 1024)} КБ)` +
        (r.moved ? `\nФайл забран из ${r.moved} и перемещён в проект.` : ""),
      "",
      "СЛЕДУЮЩИЙ ШАГ: открой файл инструментом Read и сверь с задачей. Если результат не соответствует — уточни промпт и сгенерируй заново, не выдавай неподходящую картинку за готовую.",
    ].join("\n")
  );
}

serve({ name: "codex-bridge-image", version: pluginVersion(), tools: TOOLS, handle });
