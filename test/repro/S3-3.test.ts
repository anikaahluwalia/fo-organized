import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { run } from "../../server/db.ts";
import { FoCallError } from "../../server/fo/types.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3-3: "Text me a summary" can send nothing.
//
// The summary is the note Kiki asks Fo to send you after a plan is verified in Drive
// (server/services/notify.ts notifyPreview / notifySend, web/src/App.tsx NotifyDecision).
// These tests drive the real app with a scripted Fo, and render the web app's own
// NotifyDecision/Decisions components (compiled from web/src with React's server renderer) to see
// what the person is shown.

const TEXTED = "Texted you.\nKIKI-STATUS: SENT";
const NOTE_SENT = "Sent you the note.\nKIKI-STATUS: SENT";

// The web app's components, compiled from web/src/*.tsx for this test only ------------------------

const WEB = new URL("../../web/src/", import.meta.url);
let hooked = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function web(): Promise<{ Decisions: any; NotifyDecision: any; html: (component: unknown, props: Record<string, unknown>) => string }> {
  if (!hooked) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { transformSync } = (await import("rolldown/utils")) as any;
    registerHooks({
      load(url, context, next) {
        if (url.startsWith(WEB.href) && url.endsWith(".tsx")) {
          const file = fileURLToPath(url);
          const out = transformSync(file, fs.readFileSync(file, "utf8"), { lang: "tsx", jsx: { runtime: "automatic" } });
          // App.tsx keeps these components private; export them to this test.
          const extra = file.endsWith("/App.tsx") ? "\nexport { FoTextStatus, NotifyDecision, Decisions };\n" : "";
          return { format: "module", source: `${out.code}${extra}`, shortCircuit: true };
        }
        return next(url, context);
      },
    });
    hooked = true;
  }
  const appModule = await import(new URL("App.tsx", WEB).href);
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  return {
    Decisions: appModule.Decisions,
    NotifyDecision: appModule.NotifyDecision,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    html: (component, props) => renderToStaticMarkup(React.createElement(component as any, props)),
  };
}

const idleAct = { busy: null, error: null, run: async () => undefined };
/** What the person reads in the Decisions card: its text, tags stripped and entities decoded. */
const decisionsCard = async (rig: ReturnType<typeof makeRig>) => {
  const w = await web();
  const view = await rig.app.view();
  const html = w.html(w.Decisions, { view: { ...view, settings: { ...view.settings, autoText: rig.app.autoTextEnabled() } }, act: idleAct });
  return html
    .replace(/<[^>]+>/g, " | ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/(\s*\|\s*)+/g, " | ");
};

// Helpers -----------------------------------------------------------------------------------------

function foRig(t: TestContext) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  return { ...rig, fo };
}

/** The exact bodies Kiki asked Fo to send, in order. */
const bodies = (fo: FakeFo) => fo.asks.map((a) => /-----BEGIN APPROVED BODY-----\n([\s\S]*?)\n-----END APPROVED BODY-----/.exec(a.message)?.[1] ?? null);

/** What the web app does when you click "Text me a summary", then "Send". */
async function textMeASummary(rig: ReturnType<typeof makeRig>, clientRequestId: string) {
  const preview = rig.app.notifyPreview();
  assert.ok(preview, "there is a verified result to summarize");
  const sent = rig.app.notifySend({ contentHash: preview.contentHash, clientRequestId });
  await rig.app.settle();
  return { preview, sent };
}

// Tests -------------------------------------------------------------------------------------------

test("after Fo texted you about a proposal, 'Text me a summary' for that plan still sends the summary", async (t) => {
  const rig = foRig(t);
  rig.fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: n === 1 ? TEXTED : NOTE_SENT });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  assert.equal(rig.fo.asks.length, 1, "Fo texted you about the new invoice");
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve-in-app" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === plan.id)?.status, "applied");

  const { preview, sent } = await textMeASummary(rig, "summary-1");

  assert.equal(rig.fo.asks.length, 2, `Fo was never asked to send the summary; notifySend answered ${JSON.stringify(sent)}`);
  assert.equal(bodies(rig.fo)[1], preview.text, "Fo was asked to send exactly the previewed summary");
  const html = await decisionsCard(rig);
  assert.doesNotMatch(html, /Text me a summary/, "right after you sent it, the app shows the summary's status, not the same button again");
});

async function notSentOnce(t: TestContext) {
  const rig = foRig(t);
  rig.fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: n === 1 ? "I couldn't text you just now.\nKIKI-STATUS: NOT-SENT" : NOTE_SENT });
  await organized(rig);
  await textMeASummary(rig, "summary-1");
  assert.equal((await rig.app.view()).notifications[0]?.outcome, "not_sent");
  return rig;
}

test("after Fo says it didn't send the summary, asking for it again sends it", async (t) => {
  const rig = await notSentOnce(t);
  const { sent } = await textMeASummary(rig, "summary-2");
  assert.equal(rig.fo.asks.length, 2, `asking again sent nothing; notifySend answered ${JSON.stringify(sent)}`);
});

test("after Fo says it didn't send the summary, the app offers a way to ask again", async (t) => {
  const rig = await notSentOnce(t);
  const html = await decisionsCard(rig);
  assert.match(html, /didn't send the note/);
  assert.match(html, /Text me a summary|Try again/, `the app offers a way to ask again after Fo didn't send it: ${html}`);
});

test("when Fo couldn't send the summary at all, the app lets you ask for it again", async (t) => {
  const rig = foRig(t);
  rig.fo.onAsk = async () => {
    throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
  };
  await organized(rig);
  await textMeASummary(rig, "summary-1");
  assert.equal((await rig.app.view()).notifications[0]?.state, "failed");

  const html = await decisionsCard(rig);
  assert.match(html, /The note wasn't sent/);
  assert.match(html, /Text me a summary|Try again/, "a summary that failed to send can be asked for again from the app");
});

test("when the app offers 'Text me a summary' again later, sending it isn't a silent no-op", async (t) => {
  const rig = foRig(t);
  rig.fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: NOTE_SENT });
  await organized(rig);
  const first = await textMeASummary(rig, "summary-1");
  assert.equal(rig.fo.asks.length, 1);
  // 31 minutes later: the app no longer shows that summary's status.
  run(rig.db, "UPDATE fo_tasks SET created_at = ?, updated_at = ? WHERE id = ?", new Date(Date.now() - 31 * 60_000).toISOString(), new Date(Date.now() - 31 * 60_000).toISOString(), first.sent.taskId);

  const offered = /Text me a summary/.test(await decisionsCard(rig));
  assert.ok(offered, "the app offers the button again");
  const { sent } = await textMeASummary(rig, "summary-2");
  const asked: number = rig.fo.asks.length;
  assert.ok(!offered || asked === 2, `the app offered "Text me a summary", but clicking Send sent nothing (notifySend answered ${JSON.stringify(sent)})`);
});

test("the summary never goes out with nothing in it", async (t) => {
  const rig = foRig(t);
  rig.fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: NOTE_SENT });
  await organized(rig);
  // "This is the current one" on Q-1042, and you edited the index file in Drive meanwhile, so
  // Kiki records Q-1042 as current but doesn't overwrite your index: the plan is partly done.
  const q = (await rig.app.view()).index.flatMap((p) => p.rows).find((r) => r.reference === "Q-1042")!;
  const { planId } = rig.app.markCurrent(q.docId);
  const index = [...rig.drive.files.values()].find((f) => f.name === "Flooring - document index (kept by Kiki).csv")!;
  await rig.drive.updateContent(index.id, "text/csv", "My own notes");
  const plan = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve-current" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === planId)?.status, "partial");

  const preview = rig.app.notifyPreview()!;
  assert.doesNotMatch(preview.text, /in Google Drive: \./, `the summary lists nothing: ${preview.text}`);
  assert.match(preview.text, /Q-1042/, `the summary says what was verified (Q-1042 recorded as current): ${preview.text}`);
});
