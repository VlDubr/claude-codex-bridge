import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.claude-plugin/plugin.json"
);

let cachedVersion;

export function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion;

  try {
    const { version } = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    cachedVersion = typeof version === "string" && version ? version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }

  return cachedVersion;
}
