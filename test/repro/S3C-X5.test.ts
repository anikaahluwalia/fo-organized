import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3C-X5: the text Fo is asked to send you says 'Reply "go ahead" and I'll do it.' (notify.ts:287,
// 289), and the setting reads 'Reply "go ahead" to Fo and Kiki files it.' (App.tsx:686). ROADMAP.md:
// "a text reply starts a separate Fo conversation (Lukas, Wajo). So for now the user answers Fo
// inside Kiki". A "go ahead" texted back is only counted if Fo relays it into Kiki's conversation
// as a bound report (README: "only been exercised with the mock"); otherwise the request expires
// after 30 minutes while the app says it's waiting for Fo to relay your decision.

test("the proposal Fo texts you points you to Kiki for your answer instead of asking for a text reply", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();

  const request = fo.asks.find((a) => a.message.includes("Kiki approval handoff"))!.message;
  const body = /-----BEGIN APPROVED BODY-----\n([\s\S]*?)\n-----END APPROVED BODY-----/.exec(request)![1]!;
  assert.doesNotMatch(body, /Reply "go ahead"/, `the text asks for a reply Kiki can't tie to the request:\n${body}`);
  assert.match(body, /\bin (the )?Kiki( app)?\b/i, "and says where your answer counts");
});
