import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { FoCallError } from "../../server/fo/types.ts";
import { FakeFo, makeRig, organized } from "../helpers.ts";

// S3B-X5: a text about a proposal that failed to send stays at the top of the Decisions card, with
// its "Reply go ahead" body, after you approved and applied that proposal in the app.
// textIsCurrent (web/src/App.tsx:363-367) treats every text that isn't complete as current, so it
// stays until the next text, contrary to its own comment ("an older text about a plan that's gone
// shouldn't read as being about the plan on screen now").

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

/** The app's Decisions card, as the text the person reads (one "|" between elements). */
async function decisionsCard(rig: ReturnType<typeof makeRig>): Promise<string> {
  const w = await web();
  const view = await rig.app.view();
  const html = w.html(w.Decisions, { view: { ...view, settings: { ...view.settings, autoText: rig.app.autoTextEnabled() } }, act: { busy: null, error: null, run: async () => undefined } });
  return html
    .replace(/<[^>]+>/g, " | ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/(\s*\|\s*)+/g, " | ");
}

test("a failed text about a proposal you then applied in the app doesn't keep asking you to reply 'go ahead'", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  t.after(() => rig.app.close());
  fo.onAsk = async () => {
    throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
  };
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  assert.equal((await rig.app.view()).notifications[0]?.state, "failed");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve-in-app" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === plan.id)?.status, "applied");

  const card = await decisionsCard(rig);
  assert.match(card, /Done: \d+ of \d+ changes verified in Drive/);
  assert.doesNotMatch(card, /Want me to file it in Projects\/Flooring\/Invoices\? Reply "go ahead" and I'll do it/, `the card still shows the old text asking for "go ahead": ${card}`);
});
