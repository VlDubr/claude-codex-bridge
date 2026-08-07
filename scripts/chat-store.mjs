// chat-store.mjs — состояние разговоров с моделями Codex.
//
// Codex умеет продолжать разговор: `codex exec resume <thread_id>`. Чтобы это
// выглядело как переписка с моделью, а не как цепочка не связанных вызовов,
// здесь хранится тред и его параметры. Модель, effort, sandbox и рабочий
// каталог приходится повторять при каждом продолжении: без них Codex молча
// возьмёт текущие значения по умолчанию, и разговор уедет на другую модель.

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./codex-core.mjs";
import { message } from "./i18n-runtime.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/i;
const THREAD_RE = /^[0-9a-fA-F-]{8,64}$/;
// Замок протухает: процесс мог упасть, не сняв его, и тогда чат остался бы
// заблокированным навсегда. Владелец обновляет метку времени, пока идёт ход,
// поэтому порог не обязан покрывать таймаут задачи целиком — прежние 15 минут
// были короче него и снимали замок с ещё работающего хода.
const LOCK_STALE_MS = 2 * 60_000;
const LOCK_TOUCH_MS = 20_000;

export function chatsDir() {
  const dir = path.join(path.dirname(dataDir()), "chats");
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug) && !slug.includes("..");
}

export function isValidThreadId(id) {
  return typeof id === "string" && THREAD_RE.test(id);
}

function chatPath(slug, ext = "json") {
  if (!isValidSlug(slug)) throw new Error(message("chat_invalid_name", slug));
  const dir = chatsDir();
  const p = path.resolve(dir, `${slug}.${ext}`);
  if (path.dirname(p) !== path.resolve(dir)) throw new Error(message("chat_path_outside", slug));
  return p;
}

export function readChat(slug) {
  try {
    return JSON.parse(fs.readFileSync(chatPath(slug), "utf8"));
  } catch {
    return null;
  }
}

export function writeChat(chat) {
  const file = chatPath(chat.slug);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(chat, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, file); // атомарная замена: параллельный читатель не увидит половину
  return chat;
}

export function listChats(cwd) {
  const dir = chatsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter(isValidSlug)
    .map(readChat)
    .filter(Boolean)
    .filter((c) => !cwd || c.cwd === cwd)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function deleteChat(slug) {
  try {
    fs.unlinkSync(chatPath(slug));
    return true;
  } catch {
    return false;
  }
}

/**
 * Захватывает чат на время одного хода.
 *
 * Два параллельных `exec resume` одного треда пишут в один и тот же rollout, и
 * разговор рассыпается. Замок — каталог: mkdir атомарен на всех платформах.
 */
export async function withChatLock(slug, fn) {
  const lock = chatPath(slug, "lock");
  const busy = (key) => {
    const err = new Error(message(key, slug));
    err.busy = true;
    return err;
  };

  // Две попытки: между снятием протухшего замка и захватом успевает вклиниться
  // другой процесс, и это нормальный исход, а не отказ.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {}
      if (age < LOCK_STALE_MS) throw busy("chat_busy");
      if (attempt >= 1) throw busy("chat_stale_lock");
      // Снятие через переименование: удалить и создать заново — две операции,
      // между которыми замок успевает взять другой процесс, и тогда следующий
      // rmdir снимает уже чужой живой замок.
      try {
        fs.renameSync(lock, `${lock}.stale.${process.pid}.${Date.now()}`);
      } catch {}
      try {
        const dir = path.dirname(lock);
        const prefix = `${path.basename(lock)}.stale.`;
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
      } catch {}
    }
  }

  // Ход длится минутами, а замок обязан выглядеть живым всё это время: без
  // обновления метки его снял бы соседний вызов и запустил второй exec resume
  // в тот же тред.
  const beat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lock, now, now);
    } catch {}
  }, LOCK_TOUCH_MS);
  beat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}
