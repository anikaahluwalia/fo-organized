import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionItems } from "../server/services/attention.ts";
import { makeRig, organized, type TestRig } from "./helpers.ts";

const rows = async (rig: TestRig) => (await rig.app.view()).index.flatMap((p) => p.rows);
const row = async (rig: TestRig, ref: string) => (await rows(rig)).find((r) => r.reference === ref)!;

async function approveLatest(rig: TestRig, planId: string) {
  const plan = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
  await rig.app.settle();
  return (await rig.app.view()).plans.find((p) => p.id === planId)!;
}

test("you say which quote is current: Kiki proposes the same reviewed update, with you as the source", async () => {
  const rig = makeRig();
  await organized(rig);
  // The revised quote arrives with nobody asking about it, and gets filed as a quote of its own.
  await rig.app.stageRevision("single");
  await rig.app.settle();
  const filing = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  await approveLatest(rig, filing.id);
  const ws = (rig.app.ctx.db.prepare("SELECT id FROM workspaces WHERE active = 1").get() as { id: string }).id;
  const unclear = attentionItems(rig.app.ctx, ws, "2026-10-17").find((i) => i.kind === "which_current");
  assert.ok(unclear, "two Oakline quotes and neither is current");

  const r1 = await row(rig, "Q-1042-R1");
  const { planId } = rig.app.markCurrent(r1.docId);
  const plan = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  assert.equal(plan.kind, "version_update");
  assert.equal(plan.title, "Make Q-1042-R1 the current flooring quote");
  assert.equal(plan.evidence?.source, "You");
  assert.equal(plan.evidence?.statement, "You said Q-1042-R1 is the current quote.");
  assert.equal(plan.diff?.total?.delta, -470);
  assert.equal(rig.app.markCurrent(r1.docId).planId, planId, "asking twice gives the same proposal");

  const applied = await approveLatest(rig, planId);
  assert.equal(applied.status, "applied");
  assert.equal((await row(rig, "Q-1042-R1")).status, "current");
  assert.equal((await row(rig, "Q-1042-R1")).acceptedAt, null, "current isn't accepted");
  const old = await row(rig, "Q-1042");
  assert.equal(old.status, "superseded");
  assert.equal(old.folder, "Renovations/Flooring/Quotes/Superseded");
  assert.ok(!attentionItems(rig.app.ctx, ws, "2026-10-17").some((i) => i.kind === "which_current"));
  assert.throws(() => rig.app.markCurrent(r1.docId), { status: 409 }, "already current");
  assert.throws(() => rig.app.markCurrent(old.docId), { status: 409 }, "a superseded quote isn't made current again this way");
  rig.app.close();
});

test("a contractor's only quote is simply recorded as current", async () => {
  const rig = makeRig();
  await organized(rig);
  const bf = await row(rig, "BF-77");
  const { planId } = rig.app.markCurrent(bf.docId);
  const plan = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  assert.equal(plan.title, "Mark BF-77 as the current flooring quote");
  assert.equal(plan.ops.some((o) => o.kind === "move_rename"), false, "nothing moves");
  await approveLatest(rig, planId);
  assert.equal((await row(rig, "BF-77")).status, "current");
  assert.equal((await row(rig, "Q-1042")).status, "unresolved", "another contractor's quote is untouched");
  rig.app.close();
});
