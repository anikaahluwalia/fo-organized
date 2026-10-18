// A throwaway mock Kiki for UI checks: fresh data, labelled Mock, never the live port.
//   node scripts/ui/mock-kiki.mjs [port=8796] [--demo | --organized]
// --demo sets up the renovation folder and waits for Kiki's proposal; --organized also approves it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_PORT, sleep, tempDir } from "./chrome.mjs";

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 8796);
if (port === LIVE_PORT) throw new Error(`Port ${LIVE_PORT} is the user's live Kiki. Pick another.`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = `http://localhost:${port}`;
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], {
  cwd: root,
  env: { ...process.env, KIKI_MODE: "mock", PORT: String(port), APP_ORIGIN: base, DATA_DIR: tempDir("data") },
  stdio: ["ignore", "inherit", "inherit"],
});
const H = { "content-type": "application/json", origin: base };
const post = (p, body = {}) => fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then((r) => r.json());
const state = () => fetch(`${base}/api/state`).then((r) => r.json());
for (let i = 0; i < 80; i++) {
  try {
    await state();
    break;
  } catch {
    await sleep(250);
  }
}
if (args.includes("--demo") || args.includes("--organized")) {
  await post("/api/workspace/demo");
  let plan;
  for (let i = 0; i < 80 && !plan; i++) {
    plan = (await state()).plans.find((p) => p.status === "proposed");
    if (!plan) await sleep(250);
  }
  if (args.includes("--organized") && plan) {
    await post(`/api/plans/${plan.id}/approve`, { contentHash: plan.contentHash, clientRequestId: `ui-check-${plan.id}` });
    for (let i = 0; i < 80; i++) {
      if ((await state()).plans.find((p) => p.id === plan.id)?.status === "applied") break;
      await sleep(250);
    }
  }
}
console.log(`Mock Kiki ready at ${base}`);
process.on("SIGINT", () => (server.kill(), process.exit(0)));
process.on("SIGTERM", () => (server.kill(), process.exit(0)));
