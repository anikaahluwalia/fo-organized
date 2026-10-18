// S4-X3: once a quote update goes stale, its quotes are no longer held for it, so Kiki's next look
// at the folder proposes filing both quotes as ordinary documents: the "current / superseded"
// decision you made is silently replaced by a plain filing plan (no click needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig } from "../helpers.ts";

test("after a quote update goes stale, Kiki's next look doesn't propose filing its quotes as ordinary documents", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  await rig.app.stageRevision("single");
  await rig.app.settle();
  const r1 = (await rig.app.view()).inventory.files.find((f) => f.name === "Oakline Flooring - revised quote.pdf")!.doc!.docId;
  const { planId } = rig.app.markCurrent(r1);
  const filing = (await rig.app.view()).plans.find((p) => p.kind === "organize" && p.status === "proposed")!;
  rig.app.approvePlan(filing.id, { contentHash: filing.contentHash, clientRequestId: "file-the-rest" });
  await rig.app.settle();
  const revised = [...rig.drive.files.values()].find((f) => f.name === "Oakline Flooring - revised quote.pdf")!;
  rig.drive.touch(revised.id, { name: "Oakline revised quote - keep.pdf" }); // renamed before you approve the update
  const update = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(update.id, { contentHash: update.contentHash, clientRequestId: "make-current" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === planId)?.status, "stale");

  rig.app.refreshInventory(); // the live app's regular look at the folder
  await rig.app.settle();

  const plainFilings = (await rig.app.view()).plans.filter(
    (p) => p.kind === "organize" && p.status === "proposed" && p.ops.some((o) => o.kind === "move_rename" && /revised quote|scan_0012/.test(o.before?.name ?? "")),
  );
  assert.deepEqual(
    plainFilings.map((p) => [p.title, p.ops.filter((o) => o.kind === "move_rename").map((o) => o.before?.name)]),
    [],
    "Kiki proposed filing the quotes of the stale update as ordinary documents",
  );
});
