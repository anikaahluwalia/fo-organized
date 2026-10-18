import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../server/config.ts";
import { createHttpServer } from "../../server/http.ts";
import { makeRig, sleep } from "../helpers.ts";

// S3-5: the pairing code can stay on screen after pairing.
//
// The web app's "Chrome side panel" card (web/src/ExtensionPairing.tsx) shows a one-time code and
// is supposed to take it down once a panel pairs with it. It runs here against the real HTTP
// server (server/http.ts, server/extension.ts). React's hooks are replaced by a tiny stand-in
// (state, effects, re-render until stable) so the component's own effects run; the side panel's
// side of pairing is the same request extension/api.js sends (POST /api/extension/pair).

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

// A minimal hooks runtime for one component ---------------------------------------------------

interface Effect {
  deps: unknown[] | undefined;
  cleanup?: () => void;
}
interface Hooks {
  states: unknown[];
  effects: (Effect | undefined)[];
  si: number;
  ei: number;
  pending: { i: number; fn: () => unknown; deps: unknown[] | undefined }[];
  dirty: boolean;
}
const hooks: Hooks = { states: [], effects: [], si: 0, ei: 0, pending: [], dirty: false };
(globalThis as unknown as { __kikiHooks: Hooks }).__kikiHooks = hooks;

const FAKE_REACT = `const h = globalThis.__kikiHooks;
export function useState(init) {
  const i = h.si++;
  if (h.states.length <= i) h.states.push(typeof init === "function" ? init() : init);
  return [h.states[i], (v) => { const next = typeof v === "function" ? v(h.states[i]) : v; if (!Object.is(next, h.states[i])) { h.states[i] = next; h.dirty = true; } }];
}
export function useEffect(fn, deps) {
  const i = h.ei++;
  const prev = h.effects[i];
  if (!prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]))) h.pending.push({ i, fn, deps });
}`;
const FAKE_JSX = `export const Fragment = "fragment"; export function jsx(type, props) { return { type, props }; } export const jsxs = jsx;`;
const dataUrl = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

const COMPONENT = new URL("../../web/src/ExtensionPairing.tsx", import.meta.url);
let hooked = false;
type Props = { paired?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function component(): Promise<(props: Props) => any> {
  if (!hooked) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { transformSync } = (await import("rolldown/utils")) as any;
    registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL === COMPONENT.href && specifier === "react") return { url: dataUrl(FAKE_REACT), shortCircuit: true };
        if (context.parentURL === COMPONENT.href && specifier === "react/jsx-runtime") return { url: dataUrl(FAKE_JSX), shortCircuit: true };
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url === COMPONENT.href) {
          const file = fileURLToPath(url);
          const out = transformSync(file, fs.readFileSync(file, "utf8"), { lang: "tsx", jsx: { runtime: "automatic" } });
          return { format: "module", source: out.code, shortCircuit: true };
        }
        return next(url, context);
      },
    });
    hooked = true;
  }
  return (await import(COMPONENT.href)).ExtensionPairing;
}

type Tree = { type: unknown; props: Record<string, unknown> } | string | number | boolean | null | undefined | Tree[];
const children = (n: Tree): Tree[] => (Array.isArray(n) ? n : n && typeof n === "object" ? [n.props.children as Tree] : []);
const textOf = (n: Tree): string => (typeof n === "string" || typeof n === "number" ? String(n) : children(n).map(textOf).join(""));
function button(n: Tree, label: RegExp): { props: Record<string, unknown> } | null {
  if (n && typeof n === "object" && !Array.isArray(n) && n.type === "button" && label.test(textOf(n))) return n;
  for (const c of children(n)) {
    const found = button(c, label);
    if (found) return found;
  }
  return null;
}

/** Mounts the card: render() runs it with its effects until it's stable; unmount() runs cleanups. */
async function mount(t: TestContext) {
  const ExtensionPairing = await component();
  hooks.states = [];
  hooks.effects = [];
  const render = (props: Props): Tree => {
    for (let pass = 0; pass < 20; pass++) {
      hooks.si = 0;
      hooks.ei = 0;
      hooks.pending = [];
      hooks.dirty = false;
      const tree = ExtensionPairing(props) as Tree;
      for (const e of hooks.pending) {
        hooks.effects[e.i]?.cleanup?.();
        const cleanup = e.fn();
        hooks.effects[e.i] = { deps: e.deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined };
      }
      if (!hooks.dirty) return tree;
    }
    throw new Error("the card kept re-rendering");
  };
  t.after(() => {
    for (const e of hooks.effects) e?.cleanup?.();
  });
  return render;
}

// The real server, and the browser's fetch for the web app ----------------------------------

function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: `localhost:${port}`, connection: "close", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function startServer(t: TestContext) {
  const rig = makeRig();
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const config = loadConfig({ PORT: String(port), KIKI_MODE: "mock" });
    const server = createHttpServer(rig.app, config, { google: null, fo: null }, "/nonexistent");
    const ok = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!ok) continue;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rig.app.close();
    });
    const web = { origin: config.appOrigin, "content-type": "application/json" };
    // What the web app's fetch does from the page (relative paths, same origin).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (path: string, init: { method?: string; body?: string } = {}) => {
      const res = await request(port, init.method ?? "GET", path, init.method === "POST" ? web : {}, init.body);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json };
    }) as unknown as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    return {
      makeCode: async () => String((await request(port, "POST", "/api/extension/pairing-code", web, "{}")).json.code),
      /** The side panel typing the code (extension/api.js pair()). */
      panelPairs: (code: string) => request(port, "POST", "/api/extension/pair", { origin: EXTENSION, "content-type": "application/json" }, JSON.stringify({ code })),
      /** What the web app polls: GET /api/state's extension block. */
      extensionState: async () => (await request(port, "GET", "/api/state", {})).json.extension as { paired: boolean; pairedAt?: string | null },
    };
  }
  throw new Error("no free port");
}

/** Clicks "Pair side panel" in the card and waits until the new code is on screen. */
async function showCode(render: (p: Props) => Tree, props: Props): Promise<string> {
  const pair = button(render(props), /Pair side panel|Make a new code/);
  assert.ok(pair, "the card has a Pair side panel button");
  void (pair.props.onClick as () => void)();
  for (let i = 0; i < 200; i++) {
    const shown = /Type this code[^]*?(\d{3}) (\d{3})/.exec(textOf(render(props)));
    if (shown) return `${shown[1]}${shown[2]}`;
    await sleep(5);
  }
  assert.fail("the card never showed a code");
}

// Tests ---------------------------------------------------------------------------------------

test("pairing again while a panel is already paired: once the panel uses the code, the card takes it down", async (t) => {
  const s = await startServer(t);
  // A side panel was paired earlier. Then you clicked "Forget this pairing" in the panel (it only
  // forgets in the browser, as the panel says), so the panel asks for a code and you make one.
  assert.equal((await s.panelPairs(await s.makeCode())).status, 200);
  assert.equal((await s.extensionState()).paired, true);

  const render = await mount(t);
  const code = await showCode(render, { ...(await s.extensionState()) });
  assert.equal((await s.panelPairs(code)).status, 200, "the panel paired with the code on screen");
  assert.equal((await s.panelPairs(code)).status, 403, "the code is used up");

  // The app polls GET /api/state every 1.5 s and passes extension.paired to the card.
  const after = textOf(render({ ...(await s.extensionState()) }));
  assert.doesNotMatch(after, /Type this code/, `the used code is still on screen: "${after}"`);
});

test("GET /api/state lets the web app tell that its code was used, even when a panel was already paired", async (t) => {
  const s = await startServer(t);
  assert.equal((await s.panelPairs(await s.makeCode())).status, 200);
  const code = await s.makeCode();
  const before = await s.extensionState();
  assert.equal((await s.panelPairs(code)).status, 200);
  const after = await s.extensionState();
  assert.notDeepEqual(after, before, `GET /api/state's extension block is ${JSON.stringify(after)} both before and after the code was used`);
});

test("control: with no panel paired yet, the card takes the code down once it's used (passes today)", async (t) => {
  const s = await startServer(t);
  const render = await mount(t);
  const code = await showCode(render, { ...(await s.extensionState()) });
  assert.equal((await s.panelPairs(code)).status, 200);
  const after = textOf(render({ ...(await s.extensionState()) }));
  assert.doesNotMatch(after, /Type this code/);
  assert.match(after, /Side panel paired\./);
});
