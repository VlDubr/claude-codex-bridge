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
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

const prefsPath = () => path.join(path.dirname(dataDir()), "prefs.json");

function readAll() {
  try {
    const v = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function acquireLock(file) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lock, "wx", FILE_MODE);
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lock); } catch {}
      };
    } catch (e) {
      // На Windows файл, помеченный к удалению уходящим владельцем, ещё
      // существует, и попытка создать его даёт EPERM либо EBUSY вместо EEXIST.
      // Это тот же «замок занят», а не отказ файловой системы.
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for prefs lock: ${lock}`);
      Atomics.wait(sleepCell, 0, 0, 20);
    }
  }
}

export function readPrefs(repo) {
  const all = readAll();
  const v = all[repo || ""] || {};
  return { model: v.model || null, effort: v.effort || null };
}

export function writePrefs(repo, { model, effort }) {
  const file = prefsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = acquireLock(file);
  try {
    // Читать нужно после захвата замка, иначе два процесса оба изменят одну
    // устаревшую копию и последний rename потеряет запись первого.
    const all = readAll();
    const cur = all[repo || ""] || {};
    // null — явный сброс к значению из настроек плагина; undefined не трогает.
    if (model !== undefined) cur.model = model || null;
    if (effort !== undefined) cur.effort = effort || null;
    all[repo || ""] = cur;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: FILE_MODE });
    fs.renameSync(tmp, file);
    return { model: cur.model || null, effort: cur.effort || null };
  } finally {
    release();
  }
}
