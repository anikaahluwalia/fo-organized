import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig, organized } from "./helpers.ts";

test("the demo loop: organize, a new invoice arrives, it's proposed and filed after approval", async () => {
  const rig = makeRig();
  await organized(rig);
  let view = await rig.app.view();
  assert.equal(view.plans.find((p) => p.title === 'Organize "Renovation paperwork"')?.status, "applied");

  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  view = await rig.app.view();
  const proposal = view.plans.find((p) => p.status === "proposed");
  assert.ok(proposal, "a proposal for the new invoice");
  const move = proposal.ops.find((o) => o.kind === "move_rename")!;
  assert.equal(move.after?.path, "Projects/Flooring/Invoices");
  assert.equal(move.after?.name, "2026-10-17 Invoice - Northside Building Supply - N-5602.pdf");
  assert.equal(view.notifications[0]?.purpose, "find");

  rig.app.approvePlan(proposal.id, { contentHash: proposal.contentHash, clientRequestId: "approve-invoice" });
  await rig.app.settle();
  view = await rig.app.view();
  assert.equal(view.plans.find((p) => p.id === proposal.id)?.status, "applied");
  const filed = [...rig.drive.files.values()].find((f) => f.name.includes("N-5602"))!;
  assert.equal(rig.drive.pathOf(filed.id), "Renovation paperwork/Projects/Flooring/Invoices/2026-10-17 Invoice - Northside Building Supply - N-5602.pdf");
  rig.app.close();
});
