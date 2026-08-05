#!/usr/bin/env node
// tests/regressions.mjs — по одному тесту на каждый дефект из ревью.
// Запуск: node tests/regressions.mjs
// Зависимостей нет; настоящие codex/claude не нужны — используются заглушки.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import readline from "node:readline";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
// На Windows абсолютный путь не является валидным URL для ESM-загрузчика.
const ROOT_URL = pathToFileURL(ROOT).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-"));
const results = [];

function t(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e.message || String(e) });
    }
  })();
}

// Заглушка codex — это shebang-скрипт: Windows такой файл запустить не может,
// а права 0600 и кавычки в имени файла там тоже не проверяются. Такие тесты
// честно помечаются пропущенными, а не выдаются за пройденные.
const WIN = process.platform === "win32";
function tExec(name, fn) {
  if (WIN) {
    results.push({ name, ok: true, skipped: true });
    return Promise.resolve();
  }
  return t(name, fn);
}

const fresh = (n) => {
  const d = path.join(TMP, n);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Заглушка codex: поведение задаётся переменной FAKE. */
function fakeCodex(dir) {
  const p = path.join(dir, "codex");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const fs=require("fs"),path=require("path");
const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("codex 0.0.0-fake");process.exit(0)}
if(a[0]==="login"){console.log("Logged in as fake@example.com");process.exit(0)}
if(a[0]==="exec"&&a[1]==="--help"){console.log(process.env.FAKE_HELP||"Usage: codex exec\\n  --sandbox <mode>\\n  --skip-git-repo-check\\n  --cd <dir>\\n  --image <file>");process.exit(0)}
if(a[0]==="debug"&&a[1]==="models"){console.log(process.env.FAKE_MODELS||JSON.stringify({models:[{id:"m-one",display_name:"One"}]}));process.exit(0)}
if(a[0]==="exec"){
  fs.writeFileSync(process.env.FAKE_ARGV_OUT||"/dev/null",JSON.stringify(a));
  let prompt=""; try{prompt=fs.readFileSync(0,"utf8")}catch{}
  const mode=process.env.FAKE||"ok";
  if(mode==="exit7"){console.log("PARTIAL OUTPUT");console.error("fatal detail");process.exit(7)}
  if(mode==="slow"){setTimeout(()=>process.exit(0),60000);return}
  if(mode==="notimage"){const f=path.join(process.env.FAKE_STRAY,"secret.txt");fs.writeFileSync(f,"top secret");console.log("SAVED: "+f);process.exit(0)}
  if(mode==="outside"){const f=path.join(require("os").tmpdir(),"outside-"+Date.now()+".png");fs.writeFileSync(f,Buffer.from(${JSON.stringify(PNG.toString("base64"))},"base64"));console.log("SAVED: "+f);process.exit(0)}
  const m=/^\\s+(\\/\\S+\\.png)$/m.exec(prompt);
  if(m){fs.mkdirSync(path.dirname(m[1]),{recursive:true});fs.writeFileSync(m[1],Buffer.from(${JSON.stringify(PNG.toString("base64"))},"base64"));console.log("SAVED: "+m[1])}
  console.log("done");process.exit(0)
}
process.exit(1);
`,
    { mode: 0o755 }
  );
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────── 1. Флаг --ask-for-approval по capabilities

await t("1. --ask-for-approval не добавляется, если exec его не поддерживает", async () => {
  const d = fresh("caps");
  const bin = fakeCodex(d);
  process.env.CODEX_BIN = bin;
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?caps=${Date.now()}`);

  const args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(!args.includes("--ask-for-approval"), "флаг добавлен, хотя help его не содержит");
  assert.ok(args.includes("--sandbox"), "--sandbox должен присутствовать");
});

await tExec("1b. --ask-for-approval добавляется, когда exec его поддерживает", async () => {
  const d = fresh("caps2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --sandbox <mode>\n  --ask-for-approval <policy>\n  --cd <dir>";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?caps2=${Date.now()}`);
  const args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(args.includes("--ask-for-approval"));
  delete process.env.FAKE_HELP;
});

// ───────────────────────────────── 2. Терминальные статусы фоновых задач

await tExec("2a. cancel не перезаписывается завершением процесса", async () => {
  const d = fresh("jobs-cancel");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "slow";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?c=${Date.now()}`);

  const job = core.startJob({ mode: "delegate", task: "x", cwd: d });
  await sleep(300);
  core.cancelJob(job.id);
  assert.equal(core.resolveJob(job.id, d).status, "cancelled", "сразу после отмены");
  await sleep(1200);
  assert.equal(core.resolveJob(job.id, d).status, "cancelled", "после завершения процесса");
  delete process.env.FAKE;
});

await tExec("2b. код возврата переживает перезапуск, ненулевой != done", async () => {
  const d = fresh("jobs-exit");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "exit7";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?e=${Date.now()}`);

  const job = core.startJob({ mode: "delegate", task: "x", cwd: d });
  await sleep(1200);
  // Имитируем перезапуск: свежий модуль, обработчика exit нет
  const core2 = await import(`${ROOT_URL}/scripts/codex-core.mjs?e2=${Date.now()}`);
  const j = core2.resolveJob(job.id, d);
  assert.equal(j.status, "failed", `ожидался failed, получено ${j.status}`);
  assert.equal(j.exitCode, 7);
  delete process.env.FAKE;
});

await tExec("2c. дескрипторы не текут при массовом запуске", async () => {
  const d = fresh("jobs-fd");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?fd=${Date.now()}`);

  const count = () => {
    try {
      return fs.readdirSync(`/proc/${process.pid}/fd`).length;
    } catch {
      return -1;
    }
  };
  const before = count();
  if (before < 0) return; // не Linux — пропускаем
  for (let i = 0; i < 40; i++) core.startJob({ mode: "delegate", task: `t${i}`, cwd: d });
  await sleep(200);
  const leaked = count() - before;
  assert.ok(leaked < 10, `утечка ${leaked} дескрипторов на 40 задач`);
});

// ───────────────────────────────── 3. Path traversal через job_id

await t("3. job_id вне шаблона отвергается", async () => {
  const d = fresh("traversal");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?tr=${Date.now()}`);

  const outside = path.join(d, "outside-job.json");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, JSON.stringify({ id: "x", pid: 1, status: "running" }));

  for (const bad of ["../../outside-job", "../outside-job", "job-XXXX", "job-1234567", "/etc/passwd", ""]) {
    assert.equal(core.resolveJob(bad, d), null, `принят недопустимый id: ${bad}`);
    const c = core.cancelJob(bad);
    assert.equal(c.ok, false, `cancelJob принял: ${bad}`);
  }
  assert.equal(core.jobOutput("../../etc/passwd"), "", "jobOutput прочитал внешний файл");
});

// ───────────────────────────────── 4. Ограничение инструментов claude_task

await t("4. Codex не может расширить allowlist администратора", async () => {
  const d = fresh("tools");
  const argvFile = path.join(d, "claude-argv.json");
  fs.writeFileSync(
    path.join(d, "claude"),
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log("ok");`,
    { mode: 0o755 }
  );
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(exposed, JSON.stringify({ servers: {}, allow_task: true, task_tools: ["Read"] }));

  const res = await talk(
    `${ROOT}/bridge/mcp-claude.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_task", arguments: { task: "x", allowed_tools: ["Edit", "Bash"], write: true } },
      },
    ],
    { CLAUDE_BIN: path.join(d, "claude"), CODEX_BRIDGE_EXPOSED: exposed }
  );
  assert.ok(res.length >= 2, "мост не ответил");
  const call = res.find((m) => m.id === 2);
  assert.equal(call.result.isError, true, "расширение allowlist не отклонено");
  assert.match(call.result.content[0].text, /не вход|расширению не подлежит/);
  assert.ok(!fs.existsSync(argvFile), "claude был запущен, хотя запрос вне allowlist");
});

await tExec("4b. при write:false write-инструменты вырезаны принудительно", async () => {
  const d = fresh("tools-ro");
  const argvFile = path.join(d, "claude-argv.json");
  fs.writeFileSync(
    path.join(d, "claude"),
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log("ok");`,
    { mode: 0o755 }
  );
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(
    exposed,
    JSON.stringify({ servers: {}, allow_task: true, task_tools: ["Read", "Edit", "Bash"] })
  );
  await talk(
    `${ROOT}/bridge/mcp-claude.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_task", arguments: { task: "x", write: false } },
      },
    ],
    { CLAUDE_BIN: path.join(d, "claude"), CODEX_BRIDGE_EXPOSED: exposed }
  );
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.ok(argv.includes("--tools"), `использован не --tools: ${argv.join(" ")}`);
  assert.ok(!argv.includes("--allowedTools"), "--allowedTools не ограничивает набор, использовать нельзя");
  const passed = argv[argv.indexOf("--tools") + 1].split(",").filter(Boolean);
  for (const w of ["Edit", "Bash", "Write"]) {
    assert.ok(!passed.includes(w), `${w} не вырезан при write:false`);
  }
  assert.ok(argv.includes("--disallowedTools"), "нет страховочного --disallowedTools");
});

// ───────────────────────────────── 5. Валидация изображений

await tExec("5a. текстовый файл не принимается за изображение", async () => {
  const d = fresh("img-fake");
  const stray = path.join(d, "gen");
  fs.mkdirSync(stray, { recursive: true });
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CODEX_HOME = d;
  process.env.FAKE = "notimage";
  process.env.FAKE_STRAY = stray;
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?i=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false, "текстовый файл принят как изображение");
  assert.match(r.error, /не является изображением|вне проекта/);
  delete process.env.FAKE;
});

await t("5b. out_dir с .. и абсолютный путь отвергаются", async () => {
  const d = fresh("img-path");
  process.env.CODEX_BIN = fakeCodex(d);
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?p=${Date.now()}`);
  for (const bad of ["../outside-images", "/tmp/anywhere", "a/../../b"]) {
    const r = img.generateImage({ prompt: "x", out_dir: bad, cwd: d });
    assert.equal(r.ok, false, `принят out_dir: ${bad}`);
  }
});

await t("5c. SAVED вне проекта и вне каталога Codex отвергается", async () => {
  const d = fresh("img-outside");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CODEX_HOME = path.join(d, "codexhome");
  fs.mkdirSync(path.join(d, "codexhome", "generated_images"), { recursive: true });
  process.env.FAKE = "outside";
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?o=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false, "принят файл извне проекта");
  delete process.env.FAKE;
});

await tExec("5d. ненулевой код Codex не считается успехом", async () => {
  const d = fresh("img-exit");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.FAKE = "exit7";
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?x=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false);
  assert.match(r.error, /кодом 7/);
  delete process.env.FAKE;
});

// ───────────────────────────────── 6. Безопасность config.toml

await t("6a. $& в пути не портит блок", async () => {
  const d = fresh("toml-amp");
  const cfg = path.join(d, "config.toml");
  process.env.CODEX_BRIDGE_CONFIG = cfg;
  const root = path.join(d, "plug$&in");
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?a=${Date.now()}`);
  lb.link(root);
  assert.equal(lb.linkedPath(), path.join(root, "bridge", "mcp-claude.mjs"));
  assert.ok(!fs.readFileSync(cfg, "utf8").includes(">>> codex-bridge (claude) >>>\n# Управляется".repeat(2)));
});

await tExec("6b. кавычка в пути даёт валидную TOML-строку", async () => {
  const d = fresh("toml-quote");
  process.env.CODEX_BRIDGE_CONFIG = path.join(d, "config.toml");
  const root = path.join(d, 'pl"ug');
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?q=${Date.now()}`);
  lb.link(root);
  const txt = fs.readFileSync(process.env.CODEX_BRIDGE_CONFIG, "utf8");
  assert.match(txt, /args = \["[^"]*\\"[^"]*"\]/, "кавычка не экранирована");
  assert.equal(lb.linkedPath(), path.join(root, "bridge", "mcp-claude.mjs"));
});

await t("6c. unlink удаляет все управляемые блоки", async () => {
  const d = fresh("toml-dup");
  const cfg = path.join(d, "config.toml");
  process.env.CODEX_BRIDGE_CONFIG = cfg;
  const blk = (p) =>
    `# >>> codex-bridge (claude) >>>\n[mcp_servers.claude-bridge]\ncommand = "node"\nargs = ["${p}"]\n# <<< codex-bridge (claude) <<<\n`;
  fs.writeFileSync(cfg, `model = "x"\n\n${blk("/old/1")}\n${blk("/old/2")}\n`);
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?d=${Date.now()}`);
  lb.unlink();
  const txt = fs.readFileSync(cfg, "utf8");
  assert.ok(!txt.includes("codex-bridge"), "остались блоки");
  assert.match(txt, /model = "x"/, "пользовательские настройки потеряны");
});

await t("6d. конфликт с чужой таблицей обнаруживается, файл не портится", async () => {
  const d = fresh("toml-conflict");
  const cfg = path.join(d, "config.toml");
  process.env.CODEX_BRIDGE_CONFIG = cfg;
  const original = '[mcp_servers.claude-bridge]\ncommand = "my-own"\n';
  fs.writeFileSync(cfg, original);
  const root = path.join(d, "plug");
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?cf=${Date.now()}`);
  const r = lb.link(root);
  assert.equal(r.action, "conflict");
  assert.equal(fs.readFileSync(cfg, "utf8"), original, "файл изменён при конфликте");
});

// ───────────────────────────────── 7. Ненулевой код задачи

await tExec("7. runJob: частичный вывод при exit!=0 не выдаётся за успех", async () => {
  const d = fresh("exitcode");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "exit7";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ec=${Date.now()}`);
  const r = await core.runJob({ mode: "ask", question: "x", cwd: d }, { waitMs: 20_000 });
  assert.equal(r.ok, false, "частичный вывод принят за успех");
  assert.equal(r.exitCode, 7);
  assert.equal(r.partialOutput, "PARTIAL OUTPUT");
  delete process.env.FAKE;
});

// ───────────────────────────────── 8. Права и секреты

await tExec("8. exposed.json создаётся с 0600 и без литеральных секретов", async () => {
  const d = fresh("perm");
  const exposed = path.join(d, "cfg", "exposed.json");
  process.env.CODEX_BRIDGE_EXPOSED = exposed;
  const tp = await import(`${ROOT_URL}/bridge/tool-proxy.mjs?perm=${Date.now()}`);

  const { env, dropped } = tp.sanitizeEnv({ TOKEN: "sk-literal-secret", REF: "${MY_VAR}" });
  assert.deepEqual(Object.keys(env), ["REF"], "литеральный секрет попал в конфиг");
  assert.deepEqual(dropped, ["TOKEN"]);

  tp.writeExposed({ servers: {}, allow_task: false });
  const mode = fs.statSync(exposed).mode & 0o777;
  assert.equal(mode, 0o600, `права ${mode.toString(8)} вместо 600`);
  assert.equal(fs.statSync(path.dirname(exposed)).mode & 0o777, 0o700);
});

await t("8b. ${VAR} раскрывается при запуске", async () => {
  const tp = await import(`${ROOT_URL}/bridge/tool-proxy.mjs?ex=${Date.now()}`);
  process.env.MY_TEST_VAR = "value-42";
  assert.equal(tp.expandEnv("${MY_TEST_VAR}"), "value-42");
  assert.equal(tp.expandEnv("${NOT_SET_VAR:-fallback}"), "fallback");
  delete process.env.MY_TEST_VAR;
});

// ───────────────────────────────── 9. Неполный каталог не блокирует

await tExec("9. при неполном каталоге незнакомая модель пропускается", async () => {
  const d = fresh("models");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = "not json at all";
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(d);
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(d, ".codex", "config.toml"), 'model = "configured-only"\n');

  const m = await import(`${ROOT_URL}/scripts/models.mjs?m=${Date.now()}`);
  const r = m.fetchModels({ force: true });
  assert.equal(r.complete, false, "неполный каталог помечен как полный");
  const k = m.knownModel("some-other-model");
  assert.equal(k.known, true, "рабочая модель отклонена по неполному каталогу");
  process.chdir(prevCwd);
  delete process.env.FAKE_MODELS;
});

await tExec("9b. каталог, окружённый служебным текстом, разбирается", async () => {
  const d = fresh("models2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = 'notice\n{"models":[{"id":"m-one","display_name":"One"}]}\nnotice after';
  const m = await import(`${ROOT_URL}/scripts/models.mjs?m2=${Date.now()}`);
  const r = m.fetchModels({ force: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(
    r.models.some((x) => x.id === "m-one"),
    `каталог не разобран: ${JSON.stringify(r.models)}`
  );
  delete process.env.FAKE_MODELS;
});

// ───────────────────────────────── 9c/9d. Уровни усилий (найдено на живом Codex)

await tExec("9c. effort сверяется с supported_reasoning_efforts модели", async () => {
  const d = fresh("efforts");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = JSON.stringify({
    models: [
      { id: "gpt-5.6-sol", display_name: "Sol", supported_reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
      { id: "old-model", display_name: "Old", supported_reasoning_efforts: ["minimal", "low"] },
    ],
  });
  const m = await import(`${ROOT_URL}/scripts/models.mjs?eff=${Date.now()}`);
  m.fetchModels({ force: true });

  // minimal реально отвергается gpt-5.6-sol — это и сломалось на живом запуске
  assert.ok(m.validateEffort("gpt-5.6-sol", "minimal"), "minimal пропущен для модели, которая его не принимает");
  assert.equal(m.validateEffort("gpt-5.6-sol", "low"), null, "low отклонён");
  assert.equal(m.validateEffort("gpt-5.6-sol", "xhigh"), null, "xhigh отклонён");
  assert.equal(m.validateEffort("old-model", "minimal"), null, "minimal отклонён у модели, которая его принимает");
  assert.ok(m.validateEffort("gpt-5.6-sol", "turbo"), "несуществующий уровень пропущен");
  delete process.env.FAKE_MODELS;
});

await t("9d. при неполном каталоге effort не блокируется", async () => {
  const d = fresh("efforts2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = "not json";
  const prev = process.cwd();
  process.chdir(d);
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(d, ".codex", "config.toml"), 'model = "unknown-model"\n');
  const m = await import(`${ROOT_URL}/scripts/models.mjs?eff2=${Date.now()}`);
  m.fetchModels({ force: true });
  assert.equal(m.validateEffort("unknown-model", "high"), null, "заблокировал по неполному каталогу");
  process.chdir(prev);
  delete process.env.FAKE_MODELS;
});

await t("9e. отказ API по уровню усилий объясняется, шум кэша Codex отфильтрован", async () => {
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?exp=${Date.now()}`);

  const stderr = [
    "2026-08-03T11:44:27.127313Z ERROR codex_models_manager::cache: failed to load models cache: missing field `supports_reasoning_summaries` at line 86 column 5",
    "Unsupported value: 'minimal' is not supported with the 'gpt-5.6-sol-1p-codexswic-ev3' model.",
    "Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.",
  ].join("\n");

  const clean = core.denoise(stderr);
  assert.ok(!/models cache/.test(clean), "служебный шум Codex не отфильтрован");
  assert.ok(/Unsupported value/.test(clean), "полезная строка потеряна");

  const reason = core.explainCodexFailure(clean);
  assert.ok(reason, "причина не распознана");
  assert.match(reason, /не принимает уровень усилий "minimal"/);
  assert.match(reason, /low/, "не перечислены поддерживаемые значения");

  assert.match(core.explainCodexFailure("Error: not logged in"), /codex login/);
  assert.match(core.explainCodexFailure("error: unexpected argument '--ask-for-approval'"), /exec-caps\.json/);
});

// ───────────────── 14. Нераскрытые плейсхолдеры (найдено при первом запуске)

await t("14a. литеральный ${CLAUDE_PLUGIN_DATA} не создаёт каталог в проекте", async () => {
  const d = fresh("placeholder");
  const prev = process.cwd();
  process.chdir(d);
  process.env.CLAUDE_PLUGIN_DATA = "${CLAUDE_PLUGIN_DATA}"; // подстановка не сработала
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ph=${Date.now()}`);
  const dir = core.dataDir();

  assert.ok(path.isAbsolute(dir), `относительный путь: ${dir}`);
  assert.ok(!dir.includes("${"), `плейсхолдер попал в путь: ${dir}`);
  assert.ok(
    !fs.existsSync(path.join(d, "${CLAUDE_PLUGIN_DATA}")),
    "в проекте создан каталог с именем плейсхолдера"
  );
  process.chdir(prev);
  delete process.env.CLAUDE_PLUGIN_DATA;
});

await t("14b. относительный CLAUDE_PLUGIN_DATA отвергается", async () => {
  const d = fresh("relative");
  const prev = process.cwd();
  process.chdir(d);
  process.env.CLAUDE_PLUGIN_DATA = "some/relative/dir";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?rel=${Date.now()}`);
  assert.ok(path.isAbsolute(core.dataDir()));
  assert.ok(!fs.existsSync(path.join(d, "some")), "создан относительный каталог в проекте");
  process.chdir(prev);
  delete process.env.CLAUDE_PLUGIN_DATA;
});

await t("14c. нераскрытый ${user_config.*} не уходит в аргументы codex", async () => {
  const d = fresh("usercfg");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.CODEX_BRIDGE_MODEL = "${user_config.default_model}";
  process.env.CODEX_BRIDGE_EFFORT = "${user_config.default_effort}";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?uc=${Date.now()}`);
  const args = core.buildArgs({ mode: "ask", cwd: d });

  assert.ok(!args.some((a) => String(a).includes("${")), `плейсхолдер в аргументах: ${args.join(" ")}`);
  assert.ok(!args.includes("-m"), "пустая модель передана в -m");
  delete process.env.CODEX_BRIDGE_MODEL;
  delete process.env.CODEX_BRIDGE_EFFORT;
});

await t("14d. .mcp.json не переопределяет автоэкспортируемые CLAUDE_*", async () => {
  const mcp = JSON.parse(fs.readFileSync(`${ROOT}/.mcp.json`, "utf8"));
  for (const [name, srv] of Object.entries(mcp.mcpServers)) {
    for (const key of Object.keys(srv.env || {})) {
      assert.ok(
        !key.startsWith("CLAUDE_"),
        `сервер ${name} переопределяет ${key}, которая и так экспортируется Claude Code`
      );
    }
  }
});

// ────────── 15. Сбой песочницы Windows (найдено при запуске на Windows)

await t("15a. сбой песочницы распознаётся, а не выглядит отказом пользователя", async () => {
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?sb=${Date.now()}`);

  const real =
    "windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to " +
    "launch helper: helper=codex-windows-sandbox-setup.exe, error=program not found";
  const r = core.explainCodexFailure(real);
  assert.ok(r, "причина не распознана");
  assert.match(r, /песочниц/i);
  assert.match(r, /мост исправен/, "не сказано, что MCP-сервер тут ни при чём");
  assert.match(r, /npm install -g @openai\/codex/, "нет действия по починке");

  // Именно так сбой выходит наружу и увёл диагностику в сторону
  const masked = core.explainCodexFailure("user cancelled MCP tool call");
  assert.ok(masked, "маскированная форма не распознана");
  assert.match(masked, /песочниц|setup/i);
});

await tExec("15b. bypass_sandbox выключен по умолчанию и включается явно", async () => {
  const d = fresh("bypass");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP =
    "Usage: codex exec\n  --sandbox <mode>\n  --cd <dir>\n  --dangerously-bypass-approvals-and-sandbox";

  delete process.env.CODEX_BRIDGE_BYPASS_SANDBOX;
  let core = await import(`${ROOT_URL}/scripts/codex-core.mjs?b1=${Date.now()}`);
  let args = core.buildArgs({ mode: "ask", cwd: d });
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"), "обход включён без настройки");
  assert.ok(args.includes("--sandbox"), "песочница не запрошена");

  // Нераскрытый плейсхолдер настройки не должен включать аварийный режим
  process.env.CODEX_BRIDGE_BYPASS_SANDBOX = "${user_config.bypass_sandbox}";
  core = await import(`${ROOT_URL}/scripts/codex-core.mjs?b2=${Date.now()}`);
  assert.equal(core.bypassSandboxEnabled(), false, "плейсхолдер включил обход");

  process.env.CODEX_BRIDGE_BYPASS_SANDBOX = "true";
  core = await import(`${ROOT_URL}/scripts/codex-core.mjs?b3=${Date.now()}`);
  args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"), "обход не применился");
  assert.ok(!args.includes("--sandbox"), "конфликтующие флаги переданы вместе");
  delete process.env.CODEX_BRIDGE_BYPASS_SANDBOX;
  delete process.env.FAKE_HELP;
});

await t("15c. рассинхрон версий Codex обнаруживается", async () => {
  const d = fresh("health");
  const home = path.join(d, "codexhome");
  fs.mkdirSync(path.join(home, ".sandbox-bin"), { recursive: true });
  process.env.CODEX_HOME = home;
  process.env.CODEX_BIN = fakeCodex(d); // сообщает версию 0.0.0-fake

  // Воспроизводим ровно наблюдавшуюся картину
  for (const f of [
    "codex-command-runner-0.145.0-alpha.18.exe",
    "codex-command-runner-0.146.0-alpha.3.1.exe",
    "codex-command-runner-0.146.0-alpha.9.2.exe",
  ]) {
    fs.writeFileSync(path.join(home, ".sandbox-bin", f), "");
  }
  fs.writeFileSync(path.join(home, "config.toml"), "[windows]\nsandbox = 'elevated'\n");

  const h = await import(`${ROOT_URL}/scripts/codex-health.mjs?h=${Date.now()}`);
  const bin = h.inspectSandboxBin();
  assert.equal(bin.hasWindowsSetup, false, "отсутствие windows-sandbox-setup не замечено");
  assert.deepEqual(bin.versions.sort(), ["0.145.0-alpha.18", "0.146.0-alpha.3.1", "0.146.0-alpha.9.2"]);
  assert.equal(h.windowsSandboxMode(), "elevated", "режим песочницы не прочитан из config.toml");

  const r = h.inspect();
  assert.ok(r.problems.length, "рассинхрон версий не отмечен как проблема");
  assert.match(h.format(r), /Решение:/, "нет готового действия");
  delete process.env.CODEX_HOME;
});

// ────────── 16. Прогресс вместо слепого таймаута

const JSONL = [
  '{"type":"thread.started","thread_id":"019f-abc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"**Scanning docs for exec JSON schema**"}}',
  '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","exit_code":0}}',
  '{"type":"error","message":"Reconnecting... 1/5"}',
  '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/a.ts"}]}}',
  '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Итоговый ответ модели."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}',
].join("\n");

await t("16a. поток событий превращается в ленту действий и ответ", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?e=${Date.now()}`);

  const { text: answer, events } = ev.extractOutput(JSONL);
  assert.equal(answer, "Итоговый ответ модели.", "ответ не извлечён из agent_message");
  assert.ok(ev.isFinished(events), "завершение не распознано");
  assert.deepEqual(ev.usageOf(events), { input_tokens: 24763, output_tokens: 122 });

  const trail = ev.progressTrail(JSONL);
  assert.ok(trail.some((l) => /размышляет: Scanning docs/.test(l)), `нет рассуждений: ${trail}`);
  assert.ok(trail.some((l) => /запускает: ls/.test(l)), `нет запуска команды: ${trail}`);
  assert.ok(trail.some((l) => /правит файлы: src\/a\.ts/.test(l)), `нет правки файлов: ${trail}`);
  assert.ok(trail.some((l) => /переподключение/.test(l)), "реконнект потерян");
});

await t("16b. реконнект не считается фатальной ошибкой", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?f=${Date.now()}`);
  assert.equal(ev.isFatalError({ type: "error", message: "Reconnecting... 1/5" }), false);
  assert.equal(ev.isFatalError({ type: "error", message: "stream broke" }), true);
  assert.equal(ev.isFatalError({ type: "turn.failed", error: { message: "boom" } }), true);
});

await t("16c. не-JSON вывод не теряется (старый Codex без --json)", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?g=${Date.now()}`);
  const r = ev.extractOutput("обычный текстовый ответ\nвторая строка");
  assert.equal(r.text, "обычный текстовый ответ\nвторая строка", "текст потерян при отсутствии событий");
  assert.equal(r.events.length, 0);
});

await tExec("16d. таймаут показывает, что модель успела сделать", async () => {
  const d = fresh("timeout-trail");
  const bin = path.join(d, "codex");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("codex 0.0.0-fake");process.exit(0)}
if(a[0]==="login"){console.log("Logged in");process.exit(0)}
if(a[0]==="exec"&&a[1]==="--help"){console.log("Usage: codex exec\\n  --json\\n  --sandbox <mode>\\n  --cd <dir>");process.exit(0)}
if(a[0]==="exec"){
  process.stdout.write(${JSON.stringify(JSONL.split("\n").slice(0, 5).join("\n") + "\n")});
  setTimeout(()=>process.exit(0), 60000); // зависаем после нескольких событий
}`,
    { mode: 0o755 }
  );
  process.env.CODEX_BIN = bin;
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?to=${Date.now()}`);

  const r = await core.runJob({ mode: "ask", question: "x", cwd: d }, { waitMs: 2500 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true, "таймаут не помечен");
  // Работа не убита и не перезапущена: та же задача продолжает идти
  assert.equal(core.resolveJob(r.job.id, d).status, "running", "задача убита по истечении ожидания");
  const trail = r.trail.join("\n");
  assert.match(trail, /размышляет|запускает/, `в ленте нет действий: ${trail}`);
  core.cancelJob(r.job.id);
});

await tExec("16e. --json добавляется в аргументы, когда поддержан", async () => {
  const d = fresh("jsonflag");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --json\n  --sandbox <mode>";
  let core = await import(`${ROOT_URL}/scripts/codex-core.mjs?j1=${Date.now()}`);
  assert.ok(core.buildArgs({ mode: "ask", cwd: d }).includes("--json"), "--json не добавлен");

  process.env.FAKE_HELP = "Usage: codex exec\n  --sandbox <mode>";
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data2");
  core = await import(`${ROOT_URL}/scripts/codex-core.mjs?j2=${Date.now()}`);
  assert.ok(!core.buildArgs({ mode: "ask", cwd: d }).includes("--json"), "--json добавлен без поддержки");
  delete process.env.FAKE_HELP;
});

// ───────────────────────────────── 10. Парсер аргументов setup

await t("10. setup отвергает флаг вместо значения и взаимоисключающие пары", async () => {
  const d = fresh("args");
  const env = { ...process.env, CODEX_BRIDGE_EXPOSED: path.join(d, "e.json"), CODEX_BIN: fakeCodex(d) };
  const run = (a) => spawnSync("node", [`${ROOT}/scripts/setup.mjs`, ...a], { encoding: "utf8", env, cwd: d });

  const r1 = run(["--expose", "tracker", "--tools", "--link-back"]);
  assert.notEqual(r1.status, 0, "флаг принят как значение --tools");

  const r2 = run(["--expose"]);
  assert.notEqual(r2.status, 0, "--expose без значения прошёл");

  const r3 = run(["--wat"]);
  assert.notEqual(r3.status, 0, "неизвестный флаг проигнорирован");

  const r4 = run(["--allow-task", "--deny-task"]);
  assert.notEqual(r4.status, 0, "взаимоисключающая пара выполнена");
});

// ───────────────────────────────── 11. Precedence MCP-серверов

await tExec("11. local имеет приоритет над project и user", async () => {
  const d = fresh("precedence");
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(d, "proj", ".claude"), { recursive: true });

  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { srv: { command: "user-command" } } })
  );
  fs.writeFileSync(
    path.join(d, "proj", ".mcp.json"),
    JSON.stringify({ mcpServers: { srv: { command: "project-command" } } })
  );
  fs.writeFileSync(
    path.join(d, "proj", ".claude", "settings.local.json"),
    JSON.stringify({ mcpServers: { srv: { command: "local-command" } } })
  );

  const out = spawnSync(
    "node",
    [
      "-e",
      `const tp=await import(${JSON.stringify(`${ROOT}/bridge/tool-proxy.mjs`)});
       console.log(JSON.stringify(tp.discoverClaudeServers(${JSON.stringify(path.join(d, "proj"))})));`,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home }, input: "" }
  );
  const found = JSON.parse((out.stdout || "{}").trim() || "{}");
  assert.equal(found.srv?.command, "local-command", `выбран ${found.srv?.command}`);
});

// ───────────────────────────────── 12. MCP-протокол

await t("12a. сервер не заявляет неподдерживаемую версию протокола", async () => {
  const res = await talk(`${ROOT}/scripts/mcp-image.mjs`, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } },
  ]);
  assert.notEqual(res[0].result.protocolVersion, "2099-01-01", "заявлена несуществующая версия");
});

await t("12b. битый JSON даёт parse error, а не молчание", async () => {
  const res = await talkRaw(`${ROOT}/scripts/mcp-image.mjs`, "{ not json\n");
  assert.equal(res[0]?.error?.code, -32700, `получено: ${JSON.stringify(res[0])}`);
});

await t("12c. наружу не уходит stack trace", async () => {
  const res = await talk(`${ROOT}/scripts/mcp-image.mjs`, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_check_params", arguments: {} } },
  ]);
  const body = JSON.stringify(res);
  assert.ok(!/\n\s+at\s+.+:\d+:\d+/.test(body), "в ответе есть stack trace");
});

// ───────────────────────────────── 13. Клиент реагирует на смерть сервера

await t("13. вызов после смерти сервера падает сразу, а не по таймауту", async () => {
  const d = fresh("client-die");
  const srv = path.join(d, "dying.mjs");
  fs.writeFileSync(
    srv,
    `import readline from "node:readline";
const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");
readline.createInterface({input:process.stdin}).on("line",l=>{
  const m=JSON.parse(l);
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"d",version:"1"}}});
  if(m.method==="tools/list"){send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"t",description:"d",inputSchema:{type:"object"}}]}});
    process.stderr.write("умираю по своей причине\\n"); setTimeout(()=>process.exit(3),50); return}
});`
  );
  const { McpStdioClient } = await import(`${ROOT_URL}/bridge/mcp-client.mjs?dc=${Date.now()}`);
  const c = new McpStdioClient({ alias: "dying", command: "node", args: [srv], timeoutMs: 20_000 });
  await c.start();
  await sleep(400);
  const began = Date.now();
  let err = null;
  try {
    await c.call("t", {});
  } catch (e) {
    err = e;
  }
  const took = Date.now() - began;
  assert.ok(err, "ошибка не получена");
  assert.ok(took < 3000, `ждали ${took}мс вместо мгновенного отказа`);
  assert.match(err.message, /умираю|завершил|недоступен/, `stderr потерян: ${err.message}`);
  c.stop();
});

// ───────────────────────────────── вспомогательное: разговор с MCP-сервером

function talkRaw(server, raw, env = {}) {
  return new Promise((resolve) => {
    const c = spawn("node", [server], { env: { ...process.env, ...env } });
    const out = [];
    readline.createInterface({ input: c.stdout }).on("line", (l) => {
      if (l.trim()) {
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
    });
    c.stderr.on("data", () => {});
    c.on("close", () => resolve(out));
    c.stdin.write(raw);
    c.stdin.end();
    setTimeout(() => {
      c.kill();
      resolve(out);
    }, 15_000);
  });
}

function talk(server, msgs, env = {}) {
  return talkRaw(server, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env);
}

// ───────────────────────────────── 17. Продолжение треда (codex exec resume)

await t("17a. resume не получает флагов, которых у него нет", async () => {
  const d = fresh("resume-args");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --json\n  --sandbox <mode>\n  --ask-for-approval <p>\n  --cd <dir>\n  --skip-git-repo-check";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ra=${Date.now()}`);

  const id = "019fd169-624d-70f0-8ab9-fcab01aaa476";
  const args = core.buildArgs({ mode: "chat", cwd: d, resume: id, sandbox: "workspace-write" });
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume", "resume не первый подкомандой");
  for (const flag of ["--sandbox", "--cd", "--ask-for-approval"]) {
    assert.ok(!args.includes(flag), `${flag} передан resume, который его не знает`);
  }
  assert.ok(args.includes(`sandbox_mode="workspace-write"`), `режим песочницы потерян: ${args.join(" ")}`);
  assert.ok(args.includes(`approval_policy="never"`), "политика подтверждений потеряна при записи");
  assert.equal(args[args.length - 1], "-", "промпт не со stdin");
  assert.equal(args[args.length - 2], id, "id треда не перед промптом");
  delete process.env.FAKE_HELP;
});

await t("17b. обычный запуск сохраняет --sandbox и --cd", async () => {
  const d = fresh("resume-args2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?rb=${Date.now()}`);
  const args = core.buildArgs({ mode: "chat", cwd: d });
  assert.ok(args.includes("--sandbox"), "потерян --sandbox у обычного запуска");
  assert.ok(args.includes("--cd"), "потерян --cd у обычного запуска");
  assert.ok(!args.includes("resume"));
});

await t("17c. сводки размышлений включаются настройкой", async () => {
  const d = fresh("summary");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.CODEX_BRIDGE_REASONING_SUMMARY = "detailed";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?rs=${Date.now()}`);
  assert.ok(
    core.buildArgs({ mode: "ask", cwd: d }).includes(`model_reasoning_summary="detailed"`),
    "настройка сводок не дошла до Codex"
  );
  delete process.env.CODEX_BRIDGE_REASONING_SUMMARY;
});

// ───────────────────────────────── 18. Воркер задачи вместо /bin/sh

const WORKER = `${ROOT}/scripts/job-worker.mjs`;

/** Запускает воркер на произвольной команде и ждёт код возврата. */
function runWorker(dir, { args, timeoutMs = 0, prompt = "" }) {
  const spec = {
    bin: args ? process.execPath : path.join(dir, "no-such-binary-12345"),
    args: args || [],
    promptFile: path.join(dir, "p"),
    outFile: path.join(dir, "o"),
    codeFile: path.join(dir, "c"),
    noteFile: path.join(dir, "n"),
    cwd: dir,
    timeoutMs,
  };
  fs.writeFileSync(spec.promptFile, prompt);
  const specFile = path.join(dir, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const child = spawn(process.execPath, [WORKER, specFile], { stdio: "ignore" });
  const read = (f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };
  return {
    child,
    spec,
    async settled(waitMs = 15_000) {
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        const code = read(spec.codeFile);
        if (code !== null) return { code: Number(code), note: read(spec.noteFile), out: read(spec.outFile) || "" };
        await sleep(50);
      }
      return { code: null, note: read(spec.noteFile), out: read(spec.outFile) || "" };
    },
  };
}

await t("18a. воркер работает без /bin/sh и метит события временем", async () => {
  const d = fresh("worker-ok");
  const emit = `process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"t-1"})+"\\n");` +
    `process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"готово"}})+"\\n");`;
  const w = runWorker(d, { args: ["-e", emit] });
  const r = await w.settled();
  assert.equal(r.code, 0, `код возврата ${r.code}, журнал: ${r.out}`);
  const events = r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events[0]._ts, "воркер не проставил метку времени: сам Codex её не шлёт");
  assert.equal(events[1].item.text, "готово");
});

await t("18b. отказ запуска — failed с причиной, а не «процесс исчез»", async () => {
  const d = fresh("worker-spawn");
  const w = runWorker(d, { args: null });
  const r = await w.settled();
  assert.equal(r.code, 127, `ожидался 127, получен ${r.code}`);
  assert.equal(r.note, "spawn_failed");
  assert.match(r.out, /не удалось запустить Codex/, "причина отказа не попала в журнал");
});

await t("18c. таймаут воркера помечается и убивает процесс", async () => {
  const d = fresh("worker-timeout");
  const w = runWorker(d, { args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 800 });
  const r = await w.settled();
  assert.equal(r.code, 124, `ожидался 124, получен ${r.code}`);
  assert.equal(r.note, "timeout");
  assert.match(r.out, /таймаут задачи/, "причина таймаута не в журнале");
});

await t("18d. статус задачи берётся из пометки воркера", async () => {
  const d = fresh("note-status");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ns=${Date.now()}`);
  const jobs = path.join(d, "data", "jobs");
  fs.mkdirSync(jobs, { recursive: true });

  const cases = [
    ["job-aaaa1111", "124", "timeout", "timeout"],
    ["job-bbbb2222", "130", "cancelled", "cancelled"],
    ["job-cccc3333", "127", "spawn_failed", "failed"],
    ["job-dddd4444", "3", null, "failed"],
  ];
  for (const [id, code, note, expected] of cases) {
    fs.writeFileSync(
      path.join(jobs, `${id}.json`),
      JSON.stringify({ id, pid: 999_999, mode: "ask", cwd: d, repo: d, status: "running", startedAt: new Date().toISOString() })
    );
    fs.writeFileSync(path.join(jobs, `${id}.code`), code);
    if (note) fs.writeFileSync(path.join(jobs, `${id}.note`), note);
    assert.equal(core.resolveJob(id, d).status, expected, `${id}: пометка ${note} дала не тот статус`);
  }
});

// ───────────────────────────────── 19. Наблюдение за задачей без блокировки

await t("19. followJob отдаёт события по мере появления и не ждёт вечно", async () => {
  const d = fresh("follow");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?fj=${Date.now()}`);
  const jobs = path.join(d, "data", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const id = "job-eeee5555";
  fs.writeFileSync(
    path.join(jobs, `${id}.json`),
    JSON.stringify({ id, pid: 999_999, mode: "ask", cwd: d, repo: d, status: "running", startedAt: new Date().toISOString() })
  );
  const out = path.join(jobs, `${id}.out`);
  fs.writeFileSync(out, "");

  const seen = [];
  const follow = core.followJob(id, { timeoutMs: 8000, onEvent: (e) => seen.push(e.type), pollMs: 50 });
  await sleep(150);
  fs.appendFileSync(out, JSON.stringify({ type: "turn.started" }) + "\n");
  await sleep(200);
  assert.ok(seen.includes("turn.started"), "событие не пришло до завершения задачи");
  fs.appendFileSync(out, JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
  fs.writeFileSync(path.join(jobs, `${id}.code`), "0");
  const r = await follow;
  assert.equal(r.finished, true, "завершение по коду возврата не распознано");
  assert.equal(r.timedOut, false);

  // Ожидание с истёкшим сроком не убивает задачу и возвращает управление
  fs.writeFileSync(path.join(jobs, `${id}.code`), "0");
  const quick = await core.followJob(id, { timeoutMs: 200, pollMs: 50 });
  assert.equal(quick.finished, true);
});

// ───────────────────────────────── 20. Прогресс и отмена в MCP-транспорте

function progressServer(dir) {
  const p = path.join(dir, "srv.mjs");
  fs.writeFileSync(
    p,
    `import { serve, text } from ${JSON.stringify(`${ROOT_URL}/scripts/mcp-lib.mjs`)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
serve({
  name: "fixture",
  tools: [{ name: "work", description: "d", inputSchema: { type: "object", properties: {} } }],
  handle: async (name, args, ctx) => {
    for (let i = 0; i < 8; i++) {
      ctx.notify("шаг " + i);
      await sleep(120);
      if (ctx.signal.aborted) return text("ABORTED");
    }
    return text("DONE");
  },
});
`
  );
  return p;
}

await t("20a. прогресс идёт с монотонным счётчиком и только с токеном", async () => {
  const d = fresh("progress");
  const srv = progressServer(d);

  const withToken = await talk(srv, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {}, _meta: { progressToken: "tok" } } },
  ]);
  const notes = withToken.filter((m) => m.method === "notifications/progress");
  assert.ok(notes.length >= 2, `уведомлений о прогрессе нет: ${JSON.stringify(withToken).slice(0, 200)}`);
  const seq = notes.map((n) => n.params.progress);
  assert.deepEqual(
    seq,
    [...seq].sort((a, b) => a - b),
    `progress не монотонен: ${seq}`
  );
  assert.ok(notes.every((n) => n.params.progressToken === "tok"), "чужой токен в уведомлении");
  assert.ok(withToken.some((m) => m.id === 2 && m.result), "ответ не пришёл");

  const noToken = await talk(srv, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {} } },
  ]);
  assert.equal(
    noToken.filter((m) => m.method === "notifications/progress").length,
    0,
    "уведомления без progressToken: их некуда адресовать"
  );
});

await t("20c. лента прогресса выключается настройкой", async () => {
  const d = fresh("progress-off");
  const srv = progressServer(d);
  // Известный дефект части сборок Claude Code: получение notifications/progress
  // закрывает соединение (anthropics/claude-code#47378). Выключатель нужен,
  // чтобы это лечилось настройкой, а не правкой кода.
  const out = await talk(
    srv,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {}, _meta: { progressToken: "tok" } } },
    ],
    { CODEX_BRIDGE_PROGRESS: "false" }
  );
  assert.equal(out.filter((m) => m.method === "notifications/progress").length, 0, "уведомления идут при выключенной ленте");
  assert.ok(out.some((m) => m.id === 2 && m.result), "сам вызов перестал отвечать");
});

await t("20b. отмена доходит до обработчика и ответ не отправляется", async () => {
  const d = fresh("cancel-mcp");
  const srv = progressServer(d);
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {} } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "user" } },
  ];
  const out = await talk(srv, msgs);
  assert.ok(!out.some((m) => m.id === 2), `на отменённый вызов пришёл ответ: ${JSON.stringify(out)}`);
});

// ───────────────────────────────── 21. Состояние разговоров

await t("21a. имя чата проверяется, обход каталога невозможен", async () => {
  const d = fresh("chat-slug");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const store = await import(`${ROOT_URL}/scripts/chat-store.mjs?cs=${Date.now()}`);
  for (const bad of ["../evil", "a/b", "", ".hidden", "x".repeat(60), "a b"]) {
    assert.equal(store.isValidSlug(bad), false, `принято недопустимое имя: ${JSON.stringify(bad)}`);
    assert.equal(store.readChat(bad), null, `прочитан чат по недопустимому имени: ${bad}`);
  }
  assert.ok(store.isValidSlug("default"));
  assert.ok(store.isValidSlug("gpt-5.6-sol"));
});

await t("21b. параллельный ход по одному треду блокируется", async () => {
  const d = fresh("chat-lock");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const store = await import(`${ROOT_URL}/scripts/chat-store.mjs?cl=${Date.now()}`);

  let released = false;
  const first = store.withChatLock("t", async () => {
    await sleep(400);
    released = true;
    return "ok";
  });
  await sleep(80);
  let busy = null;
  try {
    await store.withChatLock("t", async () => "второй");
  } catch (e) {
    busy = e;
  }
  assert.ok(busy?.busy, "второй ход не был отклонён — треды перепишут друг друга");
  assert.equal(released, false, "первый ход успел завершиться, проверка бессмысленна");
  assert.equal(await first, "ok");
  // Замок снят — следующий ход проходит
  assert.equal(await store.withChatLock("t", async () => "третий"), "третий");
});

await t("21c. чат хранит модель, effort и тред между ходами", async () => {
  const d = fresh("chat-state");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const store = await import(`${ROOT_URL}/scripts/chat-store.mjs?ct=${Date.now()}`);
  store.writeChat({ slug: "a", model: "m-one", effort: "high", threadId: "t-1", cwd: d, turns: 1, updatedAt: new Date().toISOString() });
  const c = store.readChat("a");
  assert.equal(c.model, "m-one");
  assert.equal(c.effort, "high");
  assert.equal(c.threadId, "t-1");
  assert.ok(store.listChats(d).some((x) => x.slug === "a"));
  assert.ok(store.deleteChat("a"));
  assert.equal(store.readChat("a"), null);
});

await t("21d. модель по умолчанию хранится по репозиторию и сбрасывается", async () => {
  const d = fresh("prefs");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const prefs = await import(`${ROOT_URL}/scripts/prefs.mjs?pf=${Date.now()}`);
  prefs.writePrefs("/repo/a", { model: "m-one", effort: "high" });
  prefs.writePrefs("/repo/b", { model: "m-two" });
  assert.equal(prefs.readPrefs("/repo/a").model, "m-one");
  assert.equal(prefs.readPrefs("/repo/b").model, "m-two", "значения репозиториев смешались");
  assert.equal(prefs.readPrefs("/repo/b").effort, null);
  prefs.writePrefs("/repo/a", { model: null, effort: null });
  assert.equal(prefs.readPrefs("/repo/a").model, null, "сброс не сработал");
});

// ───────────────────────────────── 22. Нормализация событий

await t("22a. сводка размышлений не обрезается до первой строки", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?n1=${Date.now()}`);
  const long = "Первая строка размышления\n" + "далее подробности ".repeat(30);
  const n = ev.normalize({ type: "item.completed", item: { type: "reasoning", text: long } });
  assert.equal(n.kind, "reasoning");
  assert.ok(n.title.length < 200, "в ленте не короткая строка");
  assert.ok(n.detail.length > 300, `сводка урезана до ${n.detail.length} символов`);
  assert.ok(n.detail.includes("далее подробности"), "потеряно содержимое сводки");
});

await t("22b. нормализуются все типы item, которые шлёт Codex", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?n2=${Date.now()}`);
  const cases = [
    [{ type: "thread.started", thread_id: "t-9" }, "status"],
    [{ type: "item.completed", item: { type: "reasoning", text: "думаю" } }, "reasoning"],
    [{ type: "item.started", item: { type: "command_execution", command: "ls" } }, "command"],
    [{ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts", kind: "modify" }] } }, "file"],
    [{ type: "item.completed", item: { type: "mcp_tool_call", server: "s", tool: "t" } }, "mcp"],
    [{ type: "item.started", item: { type: "web_search", query: "q" } }, "web"],
    [{ type: "item.completed", item: { type: "todo_list", items: [{ text: "a", completed: true }] } }, "todo"],
    [{ type: "item.completed", item: { type: "collab_tool_call", tool: "sub" } }, "mcp"],
    [{ type: "item.completed", item: { type: "agent_message", text: "ответ" } }, "message"],
    [{ type: "item.completed", item: { type: "error", message: "мелкая беда" } }, "error"],
    [{ type: "turn.failed", error: { message: "конец" } }, "error"],
  ];
  for (const [e, kind] of cases) {
    const n = ev.normalize(e);
    assert.ok(n, `событие не нормализовано: ${JSON.stringify(e)}`);
    assert.equal(n.kind, kind, `${JSON.stringify(e)} → ${n.kind}, ожидалось ${kind}`);
    assert.ok(n.title, "пустая строка ленты");
  }
  assert.equal(ev.threadIdOf([{ type: "thread.started", thread_id: "t-9" }]), "t-9");
});

await t("22c. чужой вывод не утекает в ленту целиком", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?n3=${Date.now()}`);
  const secret = "ключ-" + "x".repeat(9000);
  const n = ev.normalize({
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "s", tool: "t", arguments: { token: secret }, result: secret },
  });
  assert.ok(!JSON.stringify(n).includes(secret), "аргументы и результат чужого инструмента ушли наружу");

  const big = ev.normalize({
    type: "item.completed",
    item: { type: "command_execution", command: "cat big", aggregated_output: "z".repeat(50_000), exit_code: 0 },
  });
  assert.ok(big.detail.length < 5000, `вывод команды не усечён: ${big.detail.length}`);
});

// ───────────────────────────────── отчёт

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
for (const r of results) {
  const mark = r.skipped ? "  skip" : r.ok ? "  ok  " : "  FAIL";
  console.log(`${mark}  ${r.name}${r.ok ? "" : `\n         ${r.error}`}`);
}
const ran = results.length - skipped.length;
console.log(
  `\n${ran - failed.length}/${ran} пройдено` + (skipped.length ? `, ${skipped.length} пропущено (нужен POSIX)` : "")
);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
