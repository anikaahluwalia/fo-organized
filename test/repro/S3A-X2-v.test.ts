import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3A-X2 skeptic pass (passes; evidence only): is the setting's event visible in view().activity at the point
// S3A-X2 checks it (so that assertion isn't vacuous)?
test("probe: the autoText setting event is in the activity list S3A-X2 checks", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const events = (await rig.app.view()).activity.events.map((e) => e.message);
  assert.ok(events.some((m) => /You answer them here in Kiki/.test(m)), "the event is visible, so S3A-X2's events assertion is effective");
});
