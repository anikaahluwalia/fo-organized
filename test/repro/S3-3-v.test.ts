import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { FoCallError } from "../../server/fo/types.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3-3 (skeptic's extra evidence): a summary that failed to send for an OLDER plan keeps the
// "Text me a summary" button away from every later plan too. NotifyDecision (web/src/App.tsx:518-519)
// takes the first summary in the notifications that isn't complete, whatever plan it was about, and
// shows only its status. The server would accept a new summary here (notify.ts:70 lets a failed
// prior through, and the new plan has no summary key), so only the web app is in the way.

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

test("a summary that failed for an earlier plan doesn't hide 'Text me a summary' for the plan you just applied", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  let connected = false;
  fo.onAsk = async (_args, n) => {
    if (!connected) throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
    return reply(`kiki-${n}`, "complete", { response: "Sent you the note.\nKIKI-STATUS: SENT" });
  };
  await organized(rig);
  const first = rig.app.notifyPreview()!;
  rig.app.notifySend({ contentHash: first.contentHash, clientRequestId: "summary-1" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).notifications[0]?.state, "failed", "the first summary didn't go out (Fo wasn't connected)");

  // Fo is connected again. A new invoice is filed (texts are off; approved in the app).
  connected = true;
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve-invoice" });
  await rig.app.settle();
  assert.equal(rig.app.notifyPreview()?.planId, plan.id, "the summary on offer is now about the invoice you just filed");

  const w = await web();
  const view = await rig.app.view();
  const card = w
    .html(w.Decisions, { view: { ...view, settings: { ...view.settings, autoText: false } }, act: { busy: null, error: null, run: async () => undefined } })
    .replace(/<[^>]+>/g, " | ")
    .replace(/&#x27;/g, "'")
    .replace(/(\s*\|\s*)+/g, " | ");
  assert.match(card, /Text me a summary|Try again/, `the card for the new plan only shows the old summary's failure: ${card}`);
});
