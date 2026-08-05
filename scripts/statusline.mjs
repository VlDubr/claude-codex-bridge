#!/usr/bin/env node
// statusline.mjs — строка состояния: чем заняты модели Codex прямо сейчас.
//
// Подключается пользователем вручную в settings.json:
//   "statusLine": { "type": "command", "command": "node <путь>/scripts/statusline.mjs" }
// Плагин не прописывает её сам: statusLine один на всю установку, и молча
// затирать чужую настройку нельзя.

import { listJobs, jobProgress, humanAge } from "./codex-core.mjs";

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let cwd = process.cwd();
  try {
    const d = JSON.parse(input);
    cwd = d?.workspace?.current_dir || d?.cwd || cwd;
  } catch {}

  let running = [];
  try {
    running = listJobs(cwd).filter((j) => j.status === "running");
  } catch {}
  if (!running.length) return; // тишина, когда Codex не работает

  const parts = running.slice(0, 2).map((j) => {
    const trail = jobProgress(j.id, { limit: 1 }).trail;
    return `${j.mode}${j.model ? `/${j.model}` : ""} ${humanAge(j.startedAt)}: ${clip(trail[0] || "запускается", 60)}`;
  });
  const extra = running.length > 2 ? ` (+${running.length - 2})` : "";
  process.stdout.write(`codex · ${parts.join(" | ")}${extra}`);
});
