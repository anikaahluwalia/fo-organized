import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3B-X4: the summary note you asked for shows twice in the Decisions card, with two different
// labels, one of which calls it a text. Decisions (web/src/App.tsx:690-692) renders FoTextStatus
// for the latest notification of any purpose, and NotifyDecision (web/src/App.tsx:736)
// renders the latest summary again. Kiki asked Fo to send the note "the way you normally reach
// me" (server/services/notify.ts:38), not necessarily as a text.

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

test("the summary note's status appears once in the Decisions card, and isn't called a text", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  t.after(() => rig.app.close());
  fo.onAsk = async () => reply("kiki-1", "complete", { response: "Sent you the note.\nKIKI-STATUS: SENT" });
  await organized(rig);
  const preview = rig.app.notifyPreview()!;
  rig.app.notifySend({ contentHash: preview.contentHash, clientRequestId: "summary-1" });
  await rig.app.settle();

  const card = await decisionsCard(rig);
  const shown = card.split(preview.text).length - 1;
  assert.doesNotMatch(card, /texted you/, `the card calls the note a text: ${card}`);
  assert.equal(shown, 1, `the note's text appears ${shown} times: ${card}`);
});
