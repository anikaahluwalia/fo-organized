// Render an .excalidraw file to PNG with the Chrome already on this machine (no Python, no extra
// browser download). Used by the excalidraw-diagram skill's render-and-check loop.
//   node scripts/ui/render-excalidraw.mjs docs/diagrams/kiki.excalidraw [--out file.png] [--scale 2]
import fs from "node:fs";
import path from "node:path";
import { openOverPort, sleep } from "./chrome.mjs";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out" && args[args.indexOf(a) - 1] !== "--scale");
if (!input) throw new Error("usage: render-excalidraw.mjs <file.excalidraw> [--out file.png] [--scale 2]");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : input.replace(/\.excalidraw$/, "") + ".png";
const scale = args.includes("--scale") ? Number(args[args.indexOf("--scale") + 1]) : 2;

const data = JSON.parse(fs.readFileSync(input, "utf8"));
if (data.type !== "excalidraw" || !Array.isArray(data.elements) || data.elements.length === 0) throw new Error("Not an Excalidraw file with elements.");

// Pinned so a render today matches a render next month.
const PAGE = `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:#fff}#root{display:inline-block}#root svg{display:block}</style>
<div id="root"></div>
<script type="module">
  import { exportToSvg } from "https://esm.sh/@excalidraw/excalidraw@0.18.0?bundle";
  window.renderDiagram = async (d) => {
    try {
      const svg = await exportToSvg({ elements: d.elements, appState: { ...(d.appState || {}), viewBackgroundColor: (d.appState || {}).viewBackgroundColor || "#ffffff", exportBackground: true, exportWithDarkMode: false }, files: d.files || {} });
      document.getElementById("root").replaceChildren(svg);
      const r = svg.getBoundingClientRect();
      return { ok: true, width: Math.ceil(r.width), height: Math.ceil(r.height) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  };
  window.__ready = true;
</script>`;

const { send, close } = await openOverPort();
try {
  await send("Emulation.setDeviceMetricsOverride", { width: 2400, height: 1600, deviceScaleFactor: scale, mobile: false });
  await send("Page.enable");
  await send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(PAGE).toString("base64")}` });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(250);
    ready = (await send("Runtime.evaluate", { expression: "window.__ready === true", returnByValue: true })).result?.result?.value === true;
  }
  if (!ready) throw new Error("Excalidraw didn't load (needs network access to esm.sh).");
  const r = (await send("Runtime.evaluate", { expression: `window.renderDiagram(${JSON.stringify(data)})`, awaitPromise: true, returnByValue: true })).result.result.value;
  if (!r?.ok) throw new Error(`Render failed: ${r?.error ?? "unknown"}`);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: r.width, height: r.height, scale: 1 }, captureBeyondViewport: true });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log(out);
} finally {
  close();
}
