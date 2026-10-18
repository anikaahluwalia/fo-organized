// S4-X2: after a partial failure, Kiki's next look re-proposes the step Drive refused as a new
// find, and (with "Text me when Kiki finds something new" on) asks Fo to text that the document
// "just landed". It didn't: it has been in the folder all along, and Drive refused to move it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveError } from "../../server/google/types.ts";
import { makeRig } from "../helpers.ts";

test("a document Drive refused to move isn't texted about as a new document that just landed", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  rig.app.updateSettings({ autoText: true });
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  const deposit = [...rig.drive.files.values()].find((f) => f.name === "Oakline invoice deposit.pdf")!.id;
  rig.drive.fail({ op: "update", fileId: deposit, mode: "error", error: new DriveError("Drive refused: you don't have permission to move this file.", "permission", { status: 403 }) });
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === plan.id)?.status, "partial");

  rig.app.refreshInventory(); // the live app looks again 1 second after a plan finishes
  await rig.app.settle();

  const texts = (await rig.app.view()).notifications.map((n) => n.text ?? "");
  assert.deepEqual(texts.filter((s) => /just landed/.test(s) && /INV-3307/.test(s)), [], "Fo was asked to text that the refused invoice just landed");
});
