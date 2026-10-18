// Screenshot a page at a given size with real mobile emulation (headless windows can't go below
// 500px wide), and report horizontal overflow and where each heading sits.
//   node scripts/ui/shot.mjs http://localhost:8796 out.png [width=1280] [height=1600]
import fs from "node:fs";
import { LIVE_PORT, openOverPort, sleep } from "./chrome.mjs";

const [url, out, width = "1280", height = "1600"] = process.argv.slice(2);
if (!url || !out) throw new Error("usage: shot.mjs <url> <out.png> [width] [height]");
if (new URL(url).port === String(LIVE_PORT)) console.warn("Note: this is the user's live Kiki. Only look; don't click or post anything.");
const { send, close } = await openOverPort();
try {
  await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: Number(width) < 700 });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await sleep(3500);
  const facts = await send("Runtime.evaluate", {
    expression: "JSON.stringify({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, headings: [...document.querySelectorAll('h1, h2, .kiki-status')].map((h) => [h.textContent.trim().slice(0, 40), Math.round(h.getBoundingClientRect().top)]) })",
    returnByValue: true,
  });
  const f = JSON.parse(facts.result.result.value);
  console.log(`viewport ${f.viewport}px, page ${f.scrollWidth}px wide${f.scrollWidth > f.viewport ? "  <- HORIZONTAL OVERFLOW" : ""}`);
  for (const [text, top] of f.headings) console.log(`  ${String(top).padStart(5)}  ${text}`);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log(`saved ${out}`);
} finally {
  close();
}
