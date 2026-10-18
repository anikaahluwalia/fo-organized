// Shared helpers for the UI checks: find Chrome, and talk to it over the DevTools protocol.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LIVE_PORT = 8787; // the user's live Kiki: checks never use it

export function chromePath() {
  const candidates = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH.");
  return found;
}

export const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `kiki-${prefix}-`));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Headless Chrome driven over a WebSocket on a debugging port (pages only). */
export async function openOverPort() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(chromePath(), ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir("profile")}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("Chrome didn't start.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => (ws.close(), chrome.kill()) };
}

/**
 * Headless Chrome driven over the DevTools pipe, which can load an unpacked extension
 * (Extensions.loadUnpacked). Branded Chrome 137+ ignores --load-extension.
 */
export function openOverPipe() {
  const chrome = spawn(chromePath(), ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--disable-gpu", `--user-data-dir=${tempDir("profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const out = chrome.stdio[3];
  const inp = chrome.stdio[4];
  let id = 0;
  const pending = new Map();
  let buf = "";
  inp.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((r) => { const n = ++id; pending.set(n, r); out.write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); });
  return { send, close: () => chrome.kill() };
}

export const ok = (reply, what) => {
  if (reply.error) throw new Error(`${what}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
