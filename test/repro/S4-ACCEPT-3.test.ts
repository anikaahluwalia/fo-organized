// S4-ACCEPT, clause 3: "partial failures stay visible and resumable".
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one, run } from "../../server/db.ts";
import type { FakeDrive } from "../../server/google/fake.ts";
import { DriveError } from "../../server/google/types.ts";
import type { PlanView } from "../../shared/api.ts";
import { makeRig, type TestRig } from "../helpers.ts";

const WORKSPACE = "Renovation paperwork";

function newRig(t: TestContext): TestRig {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

const only = (drive: FakeDrive, name: string) => [...drive.files.values()].find((f) => f.name === name && !f.trashed)!;
const approve = (rig: TestRig, plan: PlanView) => rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
/** The job queue waits 2s, 4s, ... before retrying; make the waiting retries due now. */
const retryNow = (rig: TestRig) => run(rig.db, "UPDATE jobs SET run_after = ? WHERE state = 'queued'", new Date(0).toISOString());
const status = (rig: TestRig, id: string) => one<{ s: string }>(rig.db, "SELECT status AS s FROM plans WHERE id = ?", id)!.s;

async function firstProposal(rig: TestRig): Promise<PlanView> {
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  return (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
}

test("evidence: a passing Drive problem that outlasts the retries leaves a resumable partial plan, and Try again finishes it once", async (t) => {
  const rig = newRig(t);
  const plan = await firstProposal(rig);
  const deposit = only(rig.drive, "Oakline invoice deposit.pdf").id;
  rig.drive.fail({ op: "update", fileId: deposit, mode: "error", error: new DriveError("Google Drive had a temporary problem.", "server", { status: 503 }), times: 3 });
  approve(rig, plan);
  await rig.app.settle();
  for (let i = 0; i < 2 && status(rig, plan.id) === "executing"; i++) {
    retryNow(rig);
    await rig.app.settle();
  }

  let view = await rig.app.view();
  let after = view.plans.find((p) => p.id === plan.id)!;
  assert.equal(after.status, "partial");
  assert.equal(after.canResume, true);
  const step = after.ops.find((o) => o.kind === "move_rename" && o.before?.name === "Oakline invoice deposit.pdf")!;
  assert.notEqual(step.state, "verified");
  assert.match(step.error ?? "", /temporary problem/);
  assert.equal(view.kiki.state, "error");

  rig.app.resumePlan(plan.id);
  await rig.app.settle();
  view = await rig.app.view();
  after = view.plans.find((p) => p.id === plan.id)!;
  assert.equal(after.status, "applied");
  const updates = rig.drive.calls.filter((c) => c.op === "update");
  assert.equal(updates.filter((c) => c.id === deposit).length, 4, "three refused tries, then one move");
  assert.equal(new Set(updates.filter((c) => c.id !== deposit).map((c) => c.id)).size, updates.filter((c) => c.id !== deposit).length, "every other file moved once");
  assert.equal(rig.drive.pathOf(deposit), `${WORKSPACE}/Projects/Flooring/Invoices/2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf`);
});

test("after a partial failure, Kiki's next look at the folder keeps the partial plan visible and resumable", async (t) => {
  const rig = newRig(t);
  const plan = await firstProposal(rig);
  rig.drive.fail({ op: "update", fileId: only(rig.drive, "Oakline invoice deposit.pdf").id, mode: "error", error: new DriveError("Drive refused: you don't have permission to move this file.", "permission", { status: 403 }) });
  approve(rig, plan);
  await rig.app.settle();
  assert.equal(status(rig, plan.id), "partial");

  // The live app looks at the folder 1 second after a plan finishes, and every 10 seconds after.
  rig.app.refreshInventory();
  await rig.app.settle();

  const view = await rig.app.view();
  const shown = view.plans.find((p) => p.id === plan.id);
  assert.ok(
    shown && shown.status === "partial" && shown.canResume,
    `the partial plan left the view: ${JSON.stringify(view.plans.map((p) => [p.version, p.status, p.title, p.ops.map((o) => `${o.kind}:${o.state}`)]))}`,
  );
});
