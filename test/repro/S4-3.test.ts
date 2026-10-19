// S4-3: a collapsed plan counts a skipped step as unverified.
// "Skip this file" on a step excludes it. After the plan is applied, its History row is one line
// that should count only the steps that were meant to run. The web components are compiled from
// web/src with the repo's own bundler (rolldown, which Vite uses) and rendered with React.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import type { AppView, PlanView } from "../../shared/api.ts";
import { makeRig, type TestRig } from "../helpers.ts";

const APP = fileURLToPath(new URL("../../web/src/App.tsx", import.meta.url));
// The side panel's view model (plain JavaScript, no type declarations).
const EXTENSION_LIB = "../../extension/lib.js";
const { buildModel } = (await import(EXTENSION_LIB)) as { buildModel: (view: AppView) => { recent: { label: string | null; counts: { verified: number; total: number } | null }[] } };

interface WebApp {
  HistoryRow: (props: { plan: PlanView; act: FakeAct }) => unknown;
  Decisions: (props: { view: AppView; act: FakeAct }) => unknown;
  renderToStaticMarkup: (element: unknown) => string;
  createElement: (type: unknown, props: unknown) => unknown;
}
interface FakeAct {
  busy: string | null;
  error: string | null;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  setError: (e: string | null) => void;
}

/** web/src/App.tsx compiled as the browser gets it, with HistoryRow and Decisions exposed for the test. */
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
        load: (id) =>
          id === entry
            ? `export { Decisions, HistoryRow } from ${JSON.stringify(APP)};\nexport { renderToStaticMarkup } from "react-dom/server";\nexport { createElement } from "react";`
            : null,
        transform: (code, id) => (id === APP ? { code: `${code}\nexport { Decisions, HistoryRow };` } : null),
      },
    ],
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kiki-web-")), "app.mjs");
  fs.writeFileSync(file, output[0].code);
  return (await import(pathToFileURL(file).href)) as WebApp;
}

const idleAct: FakeAct = { busy: null, error: null, run: async () => {}, setError: () => {} };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function newRig(t: TestContext): TestRig {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

/** The demo's first plan with "Skip this" on the Bright Floors quote, approved and applied. */
async function appliedWithOneSkipped(t: TestContext): Promise<{ rig: TestRig; plan: PlanView; view: AppView }> {
  const rig = newRig(t);
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const v1 = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  const bright = v1.ops.find((o) => o.kind === "move_rename" && o.before?.name === "IMG_2041.pdf")!;
  const { planId } = rig.app.revisePlan(v1.id, [{ seq: bright.seq, exclude: true }]); // "Skip this"
  const v2 = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(v2.id, { contentHash: v2.contentHash, clientRequestId: "skip-one" });
  await rig.app.settle();
  const view = await rig.app.view();
  const plan = view.plans.find((p) => p.id === planId)!;
  assert.equal(plan.status, "applied", "every step you kept was applied and verified");
  assert.deepEqual([plan.counts.verified, plan.counts.excluded, plan.counts.total], [8, 1, 9]);
  return { rig, plan, view };
}

test("the History row of an applied plan doesn't count the step you skipped as unverified", async (t) => {
  const { plan } = await appliedWithOneSkipped(t);
  const web = await webApp();
  const row = text(web.renderToStaticMarkup(web.createElement(web.HistoryRow, { plan, act: idleAct })));
  assert.match(row, /Show steps/, "the row is collapsed");
  assert.doesNotMatch(row, /IMG_2041\.pdf/, "no steps until you ask for them");
  assert.match(row, /Applied and verified in Drive: 8 of 8 changes/, `the row reads: "${row}"`);
});

test("after Skip this, the plan's summary counts only the moves that will happen", async (t) => {
  const { plan } = await appliedWithOneSkipped(t);
  // The approve block shows this summary; Fo's text (newFindText) already leaves skipped steps out.
  assert.match(plan.summary, /move or rename 3 files/, `the summary says: "${plan.summary}"`);
});

test("evidence: the strip and the side panel already count only the steps meant to run", async (t) => {
  const { view } = await appliedWithOneSkipped(t);
  const web = await webApp();
  const decisions = text(web.renderToStaticMarkup(web.createElement(web.Decisions, { view, act: idleAct })));
  assert.match(decisions, /8 of 8 changes applied and verified in Drive\./);
  const [latest] = buildModel(view).recent;
  assert.equal(latest?.label, "Applied and verified");
  assert.deepEqual(latest?.counts, { verified: 8, total: 8 });
});
