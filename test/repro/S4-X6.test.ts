// S4-X6 (feature gap): every filing proposal in a workspace is a new version of one series
// ("organize:<workspace>"), and the view lists only the latest version of each series. Once a
// later filing exists, the first organizing plan (and its "Undo these changes…") is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig, organized } from "../helpers.ts";

test("after a later filing is applied, the first organizing plan can still be undone from the app", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await organized(rig);
  const first = (await rig.app.view()).plans.find((p) => p.status === "applied")!;
  assert.equal(first.canUndo, true);
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const second = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  rig.app.approvePlan(second.id, { contentHash: second.contentHash, clientRequestId: "file-invoice" });
  await rig.app.settle();

  const view = await rig.app.view();
  assert.ok(
    view.plans.some((p) => p.id === first.id && p.canUndo),
    `the first plan left the view: ${JSON.stringify(view.plans.map((p) => [p.version, p.status, p.title, p.canUndo]))}`,
  );
});
