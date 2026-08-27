// Воспроизводит реальный обмен из docs/example-debate.md с паузами для записи GIF.
// Первым делом очищает экран: иначе в кадр попадает строка запуска самого скрипта.
process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

const D = (ms) => new Promise((r) => setTimeout(r, ms));
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const say = async (line, wait = 420) => {
  console.log(line);
  await D(wait);
};

await say("");
await say(`${cyan("›")} /codex-bridge:challenge ${bold("the capability cache")}`, 900);
await say("");
await say(dim("  · session opened"), 500);
await say(dim("  · started thinking"), 700);
await say(dim("  · running: rg -n capsCache scripts/"), 700);
await say(dim("  · thinking: the cache stores the measurement failure too"), 900);
await say("");
await say(`  ${yellow("GPT")}  You are wrong in the place that matters.`, 700);
await say(`       A broken ${bold("codex exec --help")} still writes to stderr,`, 600);
await say("       and non-empty output is accepted as a successful probe.", 600);
await say("       The wrong flag set then survives restarts.", 1100);
await say("");
await say(`${cyan("$")} node verify-capabilities.mjs`, 900);
await say("probed: true | sandbox: false | cd: false | json: false", 500);
await say(`args: ${bold('["exec","-"]')}`, 700);
await say(`--cd: ${red("LOST")}   --sandbox: ${red("LOST")}   --json: ${red("LOST")}`, 1300);
await say("");
await say(`  ${yellow("GPT")} was right. Codex would have edited the wrong repository.`, 900);
await say(dim("  fixed in cc2f8a1"), 1600);
