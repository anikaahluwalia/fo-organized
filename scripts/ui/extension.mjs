// Load the Chrome side panel into real (headless) Chrome against a mock Kiki, pair it with a real
// code, and screenshot it. The extension is copied and pointed at the mock's port first.
//   node scripts/ui/extension.mjs [port=8796] [outDir=.]  [--approve]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_PORT, ok, openOverPipe, sleep, tempDir } from "./chrome.mjs";

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 8796);
const outDir = args.find((a) => !/^\d+$/.test(a) && !a.startsWith("--")) ?? ".";
if (port === LIVE_PORT) throw new Error(`Port ${LIVE_PORT} is the user's live Kiki. Run scripts/ui/mock-kiki.mjs on another port.`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ext = tempDir("extension");
fs.cpSync(path.join(root, "extension"), ext, { recursive: true });
for (const f of fs.readdirSync(ext)) {
  const p = path.join(ext, f);
  if (fs.statSync(p).isFile() && /\.(js|json|html)$/.test(f)) fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll(String(LIVE_PORT), String(port)));
}
const base = `http://localhost:${port}`;
const { send, close } = openOverPipe();
try {
  const { id } = ok(await send("Extensions.loadUnpacked", { path: ext }), "loadUnpacked");
  console.log("extension loaded:", id);
  const { targetId } = ok(await send("Target.createTarget", { url: `chrome-extension://${id}/panel.html` }), "createTarget");
  const { sessionId } = ok(await send("Target.attachToTarget", { targetId, flatten: true }), "attach");
  ok(await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId), "metrics");
  const evaluate = async (expression) => ok(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId), "eval").result.value;
  const shot = async (name) => {
    const r = ok(await send("Page.captureScreenshot", { format: "png" }, sessionId), "shot");
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
    console.log("saved", path.join(outDir, `${name}.png`));
  };
  await send("Page.reload", {}, sessionId);
  await sleep(2500);
  await shot("panel-unpaired");
  const code = await (await fetch(`${base}/api/extension/pairing-code`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" })).json();
  await evaluate(`(() => { const i = document.querySelector('input[aria-label="6-digit pairing code"]'); i.value = ${JSON.stringify(code.code)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('form.pairform').requestSubmit(); return true; })()`);
  await sleep(4000);
  console.log("panel says:", (await evaluate("document.body.innerText")).replace(/\s+/g, " ").slice(0, 300));
  await shot("panel-paired");
  if (args.includes("--approve")) {
    console.log("clicked:", await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => /^Approve/.test(b.textContent.trim())); if (!b) return 'no Approve button'; b.click(); return b.textContent.trim(); })()`));
    await sleep(5000);
    await shot("panel-after-approve");
  }
} finally {
  close();
}
