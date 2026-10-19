// Load the Chrome side panel into real (headless) Chrome against a mock Kiki, pair it with a real
// code, and screenshot it. The extension is copied and pointed at the mock's port first.
//   node scripts/ui/extension.mjs [port=8796] [outDir=.] [--approve] [--theme=light|dark] [--width=400]
// Saves panel-unpaired-<theme>.png, panel-paired-<theme>.png and panel-settings-<theme>.png (both
// themes unless --theme is given), and says if the panel scrolls sideways at 360px.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_PORT, ok, openOverPipe, sleep, tempDir } from "./chrome.mjs";

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 8796);
const outDir = args.find((a) => !/^\d+$/.test(a) && !a.startsWith("--")) ?? ".";
const themes = option("theme") ? [option("theme")] : ["light", "dark"];
const width = Number(option("width") ?? 400);
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
  const evaluate = async (expression) => ok(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId), "eval").result.value;
  const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
  const theme = (t) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: t }] }, sessionId);
  /** The whole panel, as tall as its content, in each theme. */
  const shots = async (name) => {
    for (const t of themes) {
      await theme(t);
      await viewport(width, 600);
      await sleep(200);
      const height = await evaluate("Math.ceil(document.documentElement.scrollHeight)");
      await viewport(width, Math.max(600, height));
      await sleep(300);
      const r = ok(await send("Page.captureScreenshot", { format: "png" }, sessionId), "shot");
      const file = path.join(outDir, `panel-${name}-${t}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log("saved", file);
    }
  };
  const overflow = async (name) => {
    await viewport(360, 800);
    await sleep(200);
    const wide = await evaluate(
      "(() => { const w = document.documentElement.clientWidth; if (document.documentElement.scrollWidth <= w) return null; return [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 0.5).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')).join(', '); })()",
    );
    console.log(wide ? `HORIZONTAL OVERFLOW at 360px (${name}): ${wide}` : `no horizontal scroll at 360px (${name})`);
  };
  const click = (selector) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`);

  await viewport(width, 900);
  await send("Page.reload", {}, sessionId);
  await sleep(2500);
  await shots("unpaired");
  await overflow("unpaired");
  const code = await (await fetch(`${base}/api/extension/pairing-code`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" })).json();
  await evaluate(`(() => { const i = document.querySelector('#code'); i.value = ${JSON.stringify(code.code)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); return true; })()`);
  await sleep(4000);
  console.log("panel says:", (await evaluate("document.body.innerText")).replace(/\s+/g, " ").slice(0, 400));
  await shots("paired");
  await overflow("paired");
  if (await click('[data-key="settings"]')) {
    await sleep(500);
    await shots("settings");
    await overflow("settings");
    await click('[data-key="settings-done"]');
    await sleep(500);
  }
  if (args.includes("--approve")) {
    console.log("clicked:", await evaluate(`(() => { const b = document.querySelector('[data-key="approve"]'); if (!b) return 'no Approve button'; b.click(); return b.textContent.trim(); })()`));
    await sleep(5000);
    await shots("after-approve");
  }
} finally {
  close();
}
