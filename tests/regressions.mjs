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

const ROOT = path.resolve(import.meta.dirname, "..");
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
  const core = await import(`${ROOT}/scripts/codex-core.mjs?caps=${Date.now()}`);

  const args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(!args.includes("--ask-for-approval"), "флаг добавлен, хотя help его не содержит");
  assert.ok(args.includes("--sandbox"), "--sandbox должен присутствовать");
});

await t("1b. --ask-for-approval добавляется, когда exec его поддерживает", async () => {
  const d = fresh("caps2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --sandbox <mode>\n  --ask-for-approval <policy>\n  --cd <dir>";
  const core = await import(`${ROOT}/scripts/codex-core.mjs?caps2=${Date.now()}`);
  const args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(args.includes("--ask-for-approval"));
  delete process.env.FAKE_HELP;
});

// ───────────────────────────────── 2. Терминальные статусы фоновых задач

await t("2a. cancel не перезаписывается завершением процесса", async () => {
  const d = fresh("jobs-cancel");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "slow";
  const core = await import(`${ROOT}/scripts/codex-core.mjs?c=${Date.now()}`);

  const job = core.startJob({ mode: "delegate", task: "x", cwd: d });
  await sleep(300);
  core.cancelJob(job.id);
  assert.equal(core.resolveJob(job.id, d).status, "cancelled", "сразу после отмены");
  await sleep(1200);
  assert.equal(core.resolveJob(job.id, d).status, "cancelled", "после завершения процесса");
  delete process.env.FAKE;
});

await t("2b. код возврата переживает перезапуск, ненулевой != done", async () => {
  const d = fresh("jobs-exit");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "exit7";
  const core = await import(`${ROOT}/scripts/codex-core.mjs?e=${Date.now()}`);

  const job = core.startJob({ mode: "delegate", task: "x", cwd: d });
  await sleep(1200);
  // Имитируем перезапуск: свежий модуль, обработчика exit нет
  const core2 = await import(`${ROOT}/scripts/codex-core.mjs?e2=${Date.now()}`);
  const j = core2.resolveJob(job.id, d);
  assert.equal(j.status, "failed", `ожидался failed, получено ${j.status}`);
  assert.equal(j.exitCode, 7);
  delete process.env.FAKE;
});

await t("2c. дескрипторы не текут при массовом запуске", async () => {
  const d = fresh("jobs-fd");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT}/scripts/codex-core.mjs?fd=${Date.now()}`);

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
  const core = await import(`${ROOT}/scripts/codex-core.mjs?tr=${Date.now()}`);

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

await t("4b. при write:false write-инструменты вырезаны принудительно", async () => {
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

await t("5a. текстовый файл не принимается за изображение", async () => {
  const d = fresh("img-fake");
  const stray = path.join(d, "gen");
  fs.mkdirSync(stray, { recursive: true });
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CODEX_HOME = d;
  process.env.FAKE = "notimage";
  process.env.FAKE_STRAY = stray;
  const img = await import(`${ROOT}/scripts/image-core.mjs?i=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false, "текстовый файл принят как изображение");
  assert.match(r.error, /не является изображением|вне проекта/);
  delete process.env.FAKE;
});

await t("5b. out_dir с .. и абсолютный путь отвергаются", async () => {
  const d = fresh("img-path");
  process.env.CODEX_BIN = fakeCodex(d);
  const img = await import(`${ROOT}/scripts/image-core.mjs?p=${Date.now()}`);
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
  const img = await import(`${ROOT}/scripts/image-core.mjs?o=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false, "принят файл извне проекта");
  delete process.env.FAKE;
});

await t("5d. ненулевой код Codex не считается успехом", async () => {
  const d = fresh("img-exit");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.FAKE = "exit7";
  const img = await import(`${ROOT}/scripts/image-core.mjs?x=${Date.now()}`);
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
  const lb = await import(`${ROOT}/scripts/link-back.mjs?a=${Date.now()}`);
  lb.link(root);
  assert.equal(lb.linkedPath(), path.join(root, "bridge", "mcp-claude.mjs"));
  assert.ok(!fs.readFileSync(cfg, "utf8").includes(">>> codex-bridge (claude) >>>\n# Управляется".repeat(2)));
});

await t("6b. кавычка в пути даёт валидную TOML-строку", async () => {
  const d = fresh("toml-quote");
  process.env.CODEX_BRIDGE_CONFIG = path.join(d, "config.toml");
  const root = path.join(d, 'pl"ug');
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT}/scripts/link-back.mjs?q=${Date.now()}`);
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
  const lb = await import(`${ROOT}/scripts/link-back.mjs?d=${Date.now()}`);
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
  const lb = await import(`${ROOT}/scripts/link-back.mjs?cf=${Date.now()}`);
  const r = lb.link(root);
  assert.equal(r.action, "conflict");
  assert.equal(fs.readFileSync(cfg, "utf8"), original, "файл изменён при конфликте");
});

// ───────────────────────────────── 7. Ненулевой код в runSync

await t("7. runSync: частичный вывод при exit!=0 не выдаётся за успех", async () => {
  const d = fresh("exitcode");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "exit7";
  const core = await import(`${ROOT}/scripts/codex-core.mjs?ec=${Date.now()}`);
  const r = core.runSync({ mode: "ask", question: "x", cwd: d });
  assert.equal(r.ok, false, "частичный вывод принят за успех");
  assert.equal(r.exitCode, 7);
  assert.equal(r.partialOutput, "PARTIAL OUTPUT");
  delete process.env.FAKE;
});

// ───────────────────────────────── 8. Права и секреты

await t("8. exposed.json создаётся с 0600 и без литеральных секретов", async () => {
  const d = fresh("perm");
  const exposed = path.join(d, "cfg", "exposed.json");
  process.env.CODEX_BRIDGE_EXPOSED = exposed;
  const tp = await import(`${ROOT}/bridge/tool-proxy.mjs?perm=${Date.now()}`);

  const { env, dropped } = tp.sanitizeEnv({ TOKEN: "sk-literal-secret", REF: "${MY_VAR}" });
  assert.deepEqual(Object.keys(env), ["REF"], "литеральный секрет попал в конфиг");
  assert.deepEqual(dropped, ["TOKEN"]);

  tp.writeExposed({ servers: {}, allow_task: false });
  const mode = fs.statSync(exposed).mode & 0o777;
  assert.equal(mode, 0o600, `права ${mode.toString(8)} вместо 600`);
  assert.equal(fs.statSync(path.dirname(exposed)).mode & 0o777, 0o700);
});

await t("8b. ${VAR} раскрывается при запуске", async () => {
  const tp = await import(`${ROOT}/bridge/tool-proxy.mjs?ex=${Date.now()}`);
  process.env.MY_TEST_VAR = "value-42";
  assert.equal(tp.expandEnv("${MY_TEST_VAR}"), "value-42");
  assert.equal(tp.expandEnv("${NOT_SET_VAR:-fallback}"), "fallback");
  delete process.env.MY_TEST_VAR;
});

// ───────────────────────────────── 9. Неполный каталог не блокирует

await t("9. при неполном каталоге незнакомая модель пропускается", async () => {
  const d = fresh("models");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = "not json at all";
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(d);
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(d, ".codex", "config.toml"), 'model = "configured-only"\n');

  const m = await import(`${ROOT}/scripts/models.mjs?m=${Date.now()}`);
  const r = m.fetchModels({ force: true });
  assert.equal(r.complete, false, "неполный каталог помечен как полный");
  const k = m.knownModel("some-other-model");
  assert.equal(k.known, true, "рабочая модель отклонена по неполному каталогу");
  process.chdir(prevCwd);
  delete process.env.FAKE_MODELS;
});

await t("9b. каталог, окружённый служебным текстом, разбирается", async () => {
  const d = fresh("models2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = 'notice\n{"models":[{"id":"m-one","display_name":"One"}]}\nnotice after';
  const m = await import(`${ROOT}/scripts/models.mjs?m2=${Date.now()}`);
  const r = m.fetchModels({ force: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(
    r.models.some((x) => x.id === "m-one"),
    `каталог не разобран: ${JSON.stringify(r.models)}`
  );
  delete process.env.FAKE_MODELS;
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

await t("11. local имеет приоритет над project и user", async () => {
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
  const { McpStdioClient } = await import(`${ROOT}/bridge/mcp-client.mjs?dc=${Date.now()}`);
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

// ───────────────────────────────── отчёт

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.ok ? "" : `\n         ${r.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} пройдено`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
