#!/usr/bin/env node
// MCP stdio-сервер: генерация изображений через встроенный инструмент Codex.

import path from "node:path";
import { serve, text, fail } from "./mcp-lib.mjs";
import { pluginVersion } from "./version.mjs";
import { probeCodex, envClean } from "./codex-core.mjs";
import { toolText, message } from "./i18n-image.mjs";
import {
  generateImage,
  validate,
  ASPECT_RATIOS,
  RESOLUTIONS,
  PROMPT_MAX,
  MAX_INPUT_IMAGES,
} from "./image-core.mjs";

const tx = toolText();

const TOOLS = [
  {
    name: "image_generate",
    description: tx.generate_d,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: tx.generate_prompt(PROMPT_MAX),
        },
        aspect_ratio: {
          type: "string",
          enum: ASPECT_RATIOS,
          default: "auto",
          description: tx.generate_aspect_ratio,
        },
        image_resolution: {
          type: "string",
          enum: RESOLUTIONS,
          default: "1K",
          description: tx.generate_resolution,
        },
        images: {
          type: "array",
          maxItems: MAX_INPUT_IMAGES,
          items: { type: "string" },
          description: tx.generate_images,
        },
        out_dir: { type: "string", description: tx.generate_out_dir },
        name: { type: "string", description: tx.generate_name },
        model: {
          type: "string",
          description: tx.generate_model,
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "image_check_params",
    description: tx.check_d,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: tx.check_prompt },
        aspect_ratio: { type: "string", description: tx.check_aspect_ratio },
        image_resolution: { type: "string", description: tx.check_resolution },
        images: { type: "array", items: { type: "string" }, description: tx.check_images },
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
      ? fail(message("params_invalid", errors))
      : text(message("params_valid"));
  }

  if (name !== "image_generate") return fail(message("unknown_tool", name));

  const c = await probeCodex();
  if (c.reason === "not_installed")
    return fail(message("codex_not_installed_login"));
  if (c.reason === "not_logged_in")
    return fail(message("codex_not_logged_in"));
  if (c.reason === "probe_timeout")
    return fail(message("probe_timeout"));

  const cwd = root();
  const r = generateImage({ ...args, cwd });
  if (!r.ok) return fail(r.error);

  const rel = path.relative(cwd, r.path) || r.path;
  return text(message("success", rel, Math.round(r.bytes / 1024), r.moved));
}

serve({ name: "codex-bridge-image", version: pluginVersion(), tools: TOOLS, handle });
