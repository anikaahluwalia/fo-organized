import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig } from "../helpers.ts";

// S3B-V1 (found by the S3B skeptic): undoing an organize plan that wrote several collection indexes
// restores only the first one. proposeUndo (server/services/plans.ts:493) takes the project from
// rows.find(write_index), and buildUndoPlan (server/domain/plan.ts:614) adds one write_index for it.
// The other indexes keep saying the files sit in their filed folders under their new names, though
// the undo put them back (indexfile.ts writes "File name" and "Folder" columns, and its footer says
// "Last updated from verified Drive state").

test("undoing a plan that filed three collections brings every index it wrote back in line with Drive", async (t) => {
  const rig = makeRig();
  t.after(() => rig.app.close());
  const root = rig.drive.addFolder("Mixed workspace", "root");
  rig.drive.addFile("scan-0.txt", root, "text/plain", "NOTES\nTitle: Induction and invariants\nCourse: CS 245");
  const report = rig.drive.addFile("scan-1.txt", root, "text/plain", "REPORT\nTitle: Accessibility findings\nProject: Nimbus launch");
  rig.drive.addFile("scan-2.txt", root, "text/plain", "ITINERARY\nTitle: Train reservations\nEvent: Kyoto spring 2027");
  await rig.app.selectWorkspace(root);
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve" });
  await rig.app.settle();
  const filedName = rig.drive.files.get(report)!.name;
  assert.notEqual(filedName, "scan-1.txt", "the report was renamed when it was filed");
  assert.match(rig.drive.pathOf(report), /Nimbus launch/);

  const { planId } = rig.app.proposeUndo(plan.id);
  const undo = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(undo.id, { contentHash: undo.contentHash, clientRequestId: "approve-undo" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === planId)?.status, "applied");
  assert.equal(rig.drive.pathOf(report), "Mixed workspace/scan-1.txt", "the undo put the report back");

  const nimbusIndex = [...rig.drive.files.values()].find((f) => f.name === "Nimbus launch - document index (kept by Kiki).csv");
  assert.ok(nimbusIndex, "the Nimbus launch index is still in Drive (nothing is deleted)");
  const content = await rig.drive.readContent(await rig.drive.getFile(nimbusIndex.id), 2_000_000);
  assert.equal(content.kind, "text");
  const text = content.kind === "text" ? content.text : "";
  assert.ok(!text.includes(filedName), `after the undo, the Nimbus launch index still lists the report as "${filedName}" in its filed folder:\n${text}`);
});
