// proc.mjs — переносимое управление дочерними процессами.
//
// Раньше фоновая задача запускалась через `/bin/sh`, которого на Windows нет:
// процесс умирал мгновенно, код возврата не появлялся, и задача навсегда
// оставалась в статусе unknown. Здесь всё, что зависит от платформы.

import { spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // процесс есть, но чужой
  }
}

/**
 * Убивает процесс вместе с потомками.
 *
 * Codex запускает собственные подпроцессы (шелл, песочницу), и убийство одного
 * лидера оставляет их работать. На POSIX это делается группой процессов, на
 * Windows — taskkill /T, других переносимых способов нет.
 */
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (isWindows) {
    const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { encoding: "utf8" });
    if (r.status === 0) return true;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}
