// S4-2: "Refresh the plan" on a stale undo or update proposes an unrelated plan.
// The web app's Decisions panel is compiled from web/src with the repo's own bundler (rolldown,
// which Vite uses). The test clicks its "Refresh the plan" button; the button's request goes to the
// real HTTP server in mock mode (FakeDrive, mock reader), as it would in the browser.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { loadConfig } from "../../server/config.ts";
import { createHttpServer } from "../../server/http.ts";
import type { FakeDrive } from "../../server/google/fake.ts";
import type { AppView, PlanView } from "../../shared/api.ts";
import { makeRig, organized, type TestRig } from "../helpers.ts";

const APP = fileURLToPath(new URL("../../web/src/App.tsx", import.meta.url));

interface FakeAct {
  busy: string | null;
  error: string | null;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  setError: (e: string | null) => void;
}
interface WebApp {
  Decisions: (props: { view: AppView; act: FakeAct }) => unknown;
}

/** web/src/App.tsx compiled as the browser gets it, with Decisions exposed for the test. */
async function webApp(): Promise<WebApp> {
  const entry = "kiki-web-test-entry";
  const bundle = await rolldown({
    input: entry,
    platform: "node",
    logLevel: "silent",
    plugins: [
      {
        name: "expose-components",
        resolveId: (id) => (id === entry ? id : null),
        load: (id) => (id === entry ? `export { Decisions } from ${JSON.stringify(APP)};` : null),
        transform: (code, id) => (id === APP ? { code: `${code}\nexport { Decisions };` } : null),
      },
    ],
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kiki-web-")), "app.mjs");
  fs.writeFileSync(file, output[0].code);
  return (await import(pathToFileURL(file).href)) as WebApp;
}

type El = { type?: unknown; props?: { children?: unknown; className?: unknown; onClick?: () => unknown } };
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf((node as El).props?.children) : "";

/** The first element in a rendered element tree that matches (Decisions itself uses no hooks). */
function find(node: unknown, match: (el: El) => boolean): El | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = find(n, match);
      if (found) return found;
    }
    return null;
  }
  const el = node as El;
  return match(el) ? el : find(el.props?.children, match);
}
const isButton = (el: El) => el.type === "button";

/** The real HTTP server for this rig, and the browser's fetch pointed at it (as the web app on that origin). */
async function serve(t: TestContext, rig: TestRig): Promise<{ answers: string[] }> {
  const answers: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const config = loadConfig({ PORT: String(port), KIKI_MODE: "mock" });
    const server = createHttpServer(rig.app, config, { google: null, fo: null }, "/nonexistent");
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!listening) continue;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method, path: String(input), agent: false, headers: { host: `localhost:${port}`, origin: config.appOrigin, "content-type": "application/json", connection: "close" } },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.end(typeof init.body === "string" ? init.body : undefined);
      });
      if (method === "POST") answers.push(`${method} ${String(input)} -> ${res.status} ${res.text}`);
      return new Response(res.text, { status: res.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    t.after(async () => {
      globalThis.fetch = realFetch;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rig.app.close();
      rig.db.close();
    });
    return { answers };
  }
  throw new Error("Couldn't find a free port.");
}

function only(drive: FakeDrive, name: string) {
  const found = [...drive.files.values()].filter((f) => f.name === name && !f.trashed);
  assert.equal(found.length, 1, `expected exactly one "${name}" in Drive, found ${found.length}`);
  return found[0]!;
}

async function planById(rig: TestRig, id: string): Promise<PlanView> {
  const plan = (await rig.app.view()).plans.find((p) => p.id === id);
  assert.ok(plan, `plan ${id} isn't in the view`);
  return plan;
}

const approve = (rig: TestRig, plan: PlanView) => rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
const act: FakeAct = { busy: null, error: null, run: async (_key, fn) => void (await fn()), setError: () => {} };

/** What the browser shows (GET /api/state), and a click on the action of the Decisions panel's "something changed" notice ("Refresh the plan"). */
async function clickRefreshThePlan(rig: TestRig): Promise<void> {
  const view = (await (await fetch("/api/state")).json()) as AppView;
  const tree = (await webApp()).Decisions({ view, act });
  const notice = find(tree, (el) => typeof el.props?.className === "string" && el.props.className.includes("notice--bad"));
  const refresh = (notice && find(notice.props?.children, isButton)) ?? find(tree, (el) => isButton(el) && textOf(el).includes("Refresh the plan"));
  assert.ok(refresh?.props?.onClick, "the Decisions panel offers Refresh the plan");
  await refresh.props.onClick();
  await rig.app.settle();
}

const describeOpen = (view: AppView) => JSON.stringify(view.plans.filter((p) => p.status === "proposed").map((p) => [p.kind, p.title, p.ops.filter((o) => o.kind === "move_rename").map((o) => o.before?.name)]));

test("Refresh the plan on a stale undo proposes the undo again, not something else", async (t) => {
  const rig = makeRig();
  const { answers } = await serve(t, rig);
  await organized(rig);
  const applied = (await rig.app.view()).plans.find((p) => p.status === "applied")!;
  rig.drive.touch(only(rig.drive, "2026-09-20 Quote - Bright Floors Ltd. - BF-77.pdf").id, { name: "Bright Floors - keep.pdf" }); // you rename one filed quote
  const { planId } = rig.app.proposeUndo(applied.id);
  approve(rig, await planById(rig, planId));
  await rig.app.settle();
  assert.equal((await planById(rig, planId)).status, "stale");

  await clickRefreshThePlan(rig);

  const view = await rig.app.view();
  assert.ok(
    view.plans.some((p) => p.status === "proposed" && p.kind === "undo" && p.title === `Undo "${applied.title}"`),
    `no fresh undo of "${applied.title}" was proposed. Open proposals: ${describeOpen(view)}. Server: ${answers.join(" | ")}`,
  );
});

test("Refresh the plan on a stale quote update proposes the update again, not an ordinary filing of the quotes", async (t) => {
  const rig = makeRig();
  const { answers } = await serve(t, rig);
  // Both Oakline quotes are in the messy folder; you say the revision is the current one.
  await rig.app.createDemoWorkspace();
  await rig.app.stageRevision("single");
  await rig.app.settle();
  const r1 = (await rig.app.view()).inventory.files.find((f) => f.name === "Oakline Flooring - revised quote.pdf")!.doc!.docId;
  const { planId: updateId } = rig.app.markCurrent(r1);
  assert.equal((await planById(rig, updateId)).kind, "version_update");
  const filing = (await rig.app.view()).plans.find((p) => p.kind === "organize" && p.status === "proposed")!;
  approve(rig, filing); // the rest of the folder is filed first
  await rig.app.settle();
  rig.drive.touch(only(rig.drive, "Oakline Flooring - revised quote.pdf").id, { name: "Oakline revised quote - keep.pdf" }); // renamed before you approve the update
  approve(rig, await planById(rig, updateId));
  await rig.app.settle();
  assert.equal((await planById(rig, updateId)).status, "stale");

  await clickRefreshThePlan(rig);

  const view = await rig.app.view();
  const open = view.plans.filter((p) => p.status === "proposed");
  const filesQuotes = open.filter((p) => p.kind === "organize" && p.ops.some((o) => o.kind === "move_rename" && /revised quote|scan_0012/.test(o.before?.name ?? "")));
  assert.deepEqual(filesQuotes.map((p) => p.title), [], `Refresh the plan proposed filing the quotes as ordinary documents. Server: ${answers.join(" | ")}`);
  assert.ok(open.some((p) => p.kind === "version_update"), `no fresh quote update was proposed. Open proposals: ${describeOpen(view)}`);
});
