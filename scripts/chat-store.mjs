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

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/i;
const THREAD_RE = /^[0-9a-fA-F-]{8,64}$/;
// Замок протухает: процесс мог упасть, не сняв его, и тогда чат остался бы
// заблокированным навсегда.
const LOCK_STALE_MS = 15 * 60_000;

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
  if (!isValidSlug(slug)) throw new Error(`Недопустимое имя чата: ${JSON.stringify(slug)}`);
  const dir = chatsDir();
  const p = path.resolve(dir, `${slug}.${ext}`);
  if (path.dirname(p) !== path.resolve(dir)) throw new Error(`Путь чата вышел за пределы каталога: ${slug}`);
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
  try {
    fs.mkdirSync(lock);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {}
    if (age < LOCK_STALE_MS) {
      const err = new Error(`Чат "${slug}" сейчас занят другим ходом. Дождись ответа или начни новый чат.`);
      err.busy = true;
      throw err;
    }
    // Замок протух — снимаем и берём заново.
    try {
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
    } catch {
      const err = new Error(`Не удалось снять устаревший замок чата "${slug}".`);
      err.busy = true;
      throw err;
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}
