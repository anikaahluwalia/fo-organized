// S4-X4: undoing a plan that filed into two projects rewrites only the first project's index. The
// second project's index CSV in Drive keeps listing the file where it no longer is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { one } from "../../server/db.ts";
import { makeRig } from "../helpers.ts";

const KITCHEN_INDEX = "Kitchen - document index (kept by Kiki).csv";

test("undo of a plan that filed into Flooring and Kitchen leaves both indexes saying where the files are now", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  const root = one<{ r: string }>(rig.db, "SELECT root_file_id AS r FROM workspaces WHERE active = 1")!.r;
  const bill = rig.drive.addFile("kitchen bill.txt", root, "text/plain", "INVOICE\nNorthside Building Supply\nInvoice No: N-5590\nDate: 2026-10-08\nProject: Kitchen\nTotal (CAD): $80.00");
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  assert.equal(plan.ops.filter((o) => o.kind === "write_index").length, 2, "the plan keeps two indexes");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "organize" });
  await rig.app.settle();

  const { planId } = rig.app.proposeUndo(plan.id);
  const undo = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(undo.id, { contentHash: undo.contentHash, clientRequestId: "undo" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === planId)?.status, "applied");
  assert.equal(rig.drive.pathOf(bill), "Renovation paperwork/kitchen bill.txt", "the kitchen bill is back at the top");

  const csv = [...rig.drive.files.values()].find((f) => f.name === KITCHEN_INDEX)?.content?.toString("utf8") ?? "";
  const row = csv.split("\r\n").find((l) => l.includes("N-5590")) ?? "";
  assert.doesNotMatch(row, /Projects\/Kitchen\/Invoices/, `the Kitchen index in Drive still lists the bill where it no longer is: ${row}`);
});
