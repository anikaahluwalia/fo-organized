import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { FoCallError } from "../../server/fo/types.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3-4: a failed text can show as still sending.
//
// A text (Fo texting you about a new find, or the summary note you asked for) is a notify task in
// the Fo engine (server/fo/engine.ts). What you're shown comes from the notifications in the view
// (server/services/view.ts), labelled by the web app (web/src/App.tsx FoTextStatus and
// NotifyDecision) and by the side panel (extension/lib.js foText). These tests make Fo fail in
// ways the engine records, then read the labels the person actually sees.

const STILL_SENDING = /is texting you…|is sending you the note…|Waiting on (Mock )?Fo…/;

// The web app's components, compiled from web/src/*.tsx for this test only ------------------------

const WEB = new URL("../../web/src/", import.meta.url);
let hooked = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function web(): Promise<{ Decisions: any; html: (component: unknown, props: Record<string, unknown>) => string }> {
  if (!hooked) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { transformSync } = (await import("rolldown/utils")) as any;
    registerHooks({
      load(url, context, next) {
        if (url.startsWith(WEB.href) && url.endsWith(".tsx")) {
          const file = fileURLToPath(url);
          const out = transformSync(file, fs.readFileSync(file, "utf8"), { lang: "tsx", jsx: { runtime: "automatic" } });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    html: (component, props) => renderToStaticMarkup(React.createElement(component as any, props)),
  };
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " | ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/(\s*\|\s*)+/g, " | ");

type Rig = ReturnType<typeof makeRig> & { fo: FakeFo };

/** The app's Decisions card, as text. */
async function decisionsCard(rig: Rig): Promise<string> {
  const w = await web();
  const view = await rig.app.view();
  return textOf(w.html(w.Decisions, { view: { ...view, settings: { ...view.settings, autoText: rig.app.autoTextEnabled() } }, act: { busy: null, error: null, run: async () => undefined } }));
}

/** What the Chrome side panel says about the latest text (extension/lib.js foText). */
async function panelLabel(rig: Rig): Promise<string> {
  const lib = await import(new URL("../../extension/lib.js", import.meta.url).href);
  const [latest] = (await rig.app.view()).notifications;
  assert.ok(latest, "there is a text to describe");
  return lib.foText(latest).label as string;
}

function foRig(t: TestContext): Rig {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  return { ...rig, fo };
}

async function askForSummary(rig: Rig): Promise<void> {
  const preview = rig.app.notifyPreview()!;
  rig.app.notifySend({ contentHash: preview.contentHash, clientRequestId: "summary-1" });
  await rig.app.settle();
}

// Tests -------------------------------------------------------------------------------------------

test("when Kiki loses touch with Fo while it's sending your note, the app doesn't keep saying it's sending", async (t) => {
  const rig = foRig(t);
  await organized(rig);
  rig.fo.onAsk = async () => reply("kiki-1", "working", { progress: "Getting your phone number" });
  rig.fo.onPoll = async () => {
    throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
  };
  await askForSummary(rig);
  const [note] = (await rig.app.view()).notifications;
  assert.equal(note?.state, "working", "the engine keeps the task 'working' and stops polling (poll_paused)");
  assert.equal(rig.fo.polls.length, 1, "Kiki stopped checking on the text after Fo's connection error");

  const card = await decisionsCard(rig);
  assert.doesNotMatch(card, STILL_SENDING, `the app still says the note is on its way, though Kiki stopped checking: ${card}`);
  assert.match(card, /Fo isn't connected/, "the app says what happened (Fo's connection error) so you can fix it");
  assert.doesNotMatch(await panelLabel(rig), STILL_SENDING, "the side panel says the same");
});

test("when Fo ends its turn without saying whether it texted you, the app doesn't say it's still texting", async (t) => {
  const rig = foRig(t);
  rig.fo.onAsk = async () => reply("kiki-1", "complete", {});
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const [text] = (await rig.app.view()).notifications;
  assert.equal(text?.purpose, "find");
  assert.deepEqual([text.state, text.outcome], ["complete", "unclear"], "Fo's turn is over and nothing says the text went out");

  const panel = await panelLabel(rig);
  assert.doesNotMatch(panel, STILL_SENDING, `the side panel says: "${panel}"`);
  const card = await decisionsCard(rig);
  assert.doesNotMatch(card, STILL_SENDING, `the app says: ${card}`);
});

test("when Fo ends the summary's turn without saying it sent it, the app doesn't say it's waiting on Fo", async (t) => {
  const rig = foRig(t);
  await organized(rig);
  rig.fo.onAsk = async () => reply("kiki-1", "complete", {});
  await askForSummary(rig);
  const [note] = (await rig.app.view()).notifications;
  assert.deepEqual([note?.purpose, note?.state, note?.outcome], ["summary", "complete", "unclear"]);

  const card = await decisionsCard(rig);
  assert.doesNotMatch(card, STILL_SENDING, `the app says: ${card}`);
  assert.doesNotMatch(await panelLabel(rig), STILL_SENDING);
});

// Evidence that plain failures are labelled correctly (these pass today).

test("control: Fo reporting the text failed, or an ask that never reached Fo, is labelled as not sent", async (t) => {
  const failed = foRig(t);
  await organized(failed);
  failed.fo.onAsk = async () => reply("kiki-1", "failed", { response: "I couldn't send texts right now." });
  await askForSummary(failed);
  assert.equal((await failed.app.view()).notifications[0]?.state, "failed");
  assert.match(await decisionsCard(failed), /The note wasn't sent/);
  assert.equal(await panelLabel(failed), "The note wasn't sent.");

  const unreachable = foRig(t);
  await organized(unreachable);
  unreachable.fo.onAsk = async () => {
    throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
  };
  await askForSummary(unreachable);
  assert.equal((await unreachable.app.view()).notifications[0]?.state, "failed");
  assert.doesNotMatch(await decisionsCard(unreachable), STILL_SENDING);
});
