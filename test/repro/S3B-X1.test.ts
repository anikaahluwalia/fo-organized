import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig, organized } from "../helpers.ts";

// S3B-X1: "Text me a summary" after an undo tells you Kiki organized and filed your documents.
// notifyPreview (server/services/notify.ts:17-34) summarizes the latest applied plan of any kind
// with the same sentence: "I organized ... filed and renamed N documents". For an undo plan, the
// verified moves put the files back where they were.

test("the summary of an applied undo says Kiki put files back, not that she organized and filed them", async (t) => {
  const rig = makeRig();
  t.after(() => rig.app.close());
  await organized(rig);
  const applied = (await rig.app.view()).plans.find((p) => p.status === "applied")!;
  const { planId } = rig.app.proposeUndo(applied.id);
  const undo = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(undo.id, { contentHash: undo.contentHash, clientRequestId: "approve-undo" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === planId)?.status, "applied");
  assert.ok([...rig.drive.files.values()].some((f) => f.name === "scan_0012.pdf"), "the quote is back under its old name");

  const { text } = rig.app.notifyPreview()!;
  assert.doesNotMatch(text, /I organized|filed and renamed/, `the note Fo would send you: ${text}`);
});
