// prefs.mjs — модель и effort по умолчанию, выбранные на ходу.
//
// Настройка плагина задаётся при установке и меняется только через UI, а
// переключаться между моделями хочется прямо в разговоре. Значение хранится по
// репозиторию: надёжного идентификатора сессии Claude у MCP-вызова нет, поэтому
// «по умолчанию» здесь — про проект, а не про конкретное окно.

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./codex-core.mjs";

const FILE_MODE = 0o600;

const prefsPath = () => path.join(path.dirname(dataDir()), "prefs.json");

function readAll() {
  try {
    const v = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function readPrefs(repo) {
  const all = readAll();
  const v = all[repo || ""] || {};
  return { model: v.model || null, effort: v.effort || null };
}

export function writePrefs(repo, { model, effort }) {
  const all = readAll();
  const cur = all[repo || ""] || {};
  // null — явный сброс к значению из настроек плагина; undefined не трогает.
  if (model !== undefined) cur.model = model || null;
  if (effort !== undefined) cur.effort = effort || null;
  all[repo || ""] = cur;
  const file = prefsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  return readPrefs(repo);
}
