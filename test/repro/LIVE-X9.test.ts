// LIVE-X9: .env.example, the file the setup starts from, is out of date. It offers PAPERCHASE_MODE
// (the server reads KIKI_MODE, so PAPERCHASE_MODE=mock silently stays live), and it has no
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, without which live Drive and Gmail can't connect.
// (Only reads the template; never .env.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../server/config.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const template = fs.readFileSync(path.join(repo, ".env.example"), "utf8");
const keys = [...template.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);

test(".env.example lists what live Drive needs", () => {
  assert.deepEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter((k) => !keys.includes(k)), [], `the template has: ${keys.join(", ")}`);
});

test("every mode switch in .env.example is one the server reads", () => {
  const modeKeys = keys.filter((k) => k.endsWith("_MODE"));
  const ignored = modeKeys.filter((k) => loadConfig({ [k]: "mock" }).claudeMode === "live" && loadConfig({ [k]: "mock" }).foMode === "live" && loadConfig({ [k]: "mock" }).driveMode === "live");
  assert.deepEqual(ignored, [], `setting these to "mock" changes nothing: ${ignored.join(", ")}`);
});
