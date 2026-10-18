import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig } from "../helpers.ts";

// S3B-X2: the summary of an organized school/work/personal workspace says "(0 invoices, 0 quotes)"
// and names only the first of several index files it wrote. notifyPreview
// (server/services/notify.ts:24-31) counts invoices and quotes by folder name and uses
// ops.find(write_index) for the index.

test("the summary of a non-renovation workspace doesn't count invoices and quotes, and names every index it wrote", async (t) => {
  const rig = makeRig();
  t.after(() => rig.app.close());
  const root = rig.drive.addFolder("Mixed workspace", "root");
  rig.drive.addFile("scan-0.txt", root, "text/plain", "NOTES\nTitle: Induction and invariants\nCourse: CS 245");
  rig.drive.addFile("scan-1.txt", root, "text/plain", "REPORT\nTitle: Accessibility findings\nProject: Nimbus launch");
  rig.drive.addFile("scan-2.txt", root, "text/plain", "ITINERARY\nTitle: Train reservations\nEvent: Kyoto spring 2027");
  await rig.app.selectWorkspace(root);
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve" });
  await rig.app.settle();
  const indexes = [...rig.drive.files.values()].filter((f) => f.name.endsWith("document index (kept by Kiki).csv")).length;
  assert.equal(indexes, 3, "Kiki wrote three index files");

  const { text } = rig.app.notifyPreview()!;
  assert.doesNotMatch(text, /0 invoices, 0 quotes/, `the note Fo would send you: ${text}`);
  for (const project of ["CS 245", "Nimbus launch", "Kyoto spring 2027"]) assert.match(text, new RegExp(project), `the note names the ${project} index: ${text}`);
});
