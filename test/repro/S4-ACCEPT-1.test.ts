// S4-ACCEPT, clause 1: "Only the approved version runs" (with a double approval and a restart).
// Evidence: these pass on the current code.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one } from "../../server/db.ts";
import { AppError } from "../../server/errors.ts";
import { FakeDrive, type FakeOp } from "../../server/google/fake.ts";
import type { PlanView } from "../../shared/api.ts";
import { makeRig, tempDbPath, type TestRig } from "../helpers.ts";

const MUTATIONS: FakeOp[] = ["createFolder", "update", "createFile", "updateContent"];
const WORKSPACE = "Renovation paperwork";

function newRig(t: TestContext, opts: Parameters<typeof makeRig>[0] = {}): TestRig {
  const rig = makeRig(opts);
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

async function planById(rig: TestRig, id: string): Promise<PlanView> {
  const plan = (await rig.app.view()).plans.find((p) => p.id === id);
  assert.ok(plan, `plan ${id} isn't in the view`);
  return plan;
}

test("a revised proposal: the old version can't be approved, a double approval and a restart run the new version once", async (t) => {
  const dbPath = tempDbPath();
  const drive = new FakeDrive("mock");
  const first = newRig(t, { drive, db: dbPath });
  await first.app.createDemoWorkspace();
  await first.app.settle();
  const v1 = (await first.app.view()).plans.find((p) => p.status === "proposed")!;
  const deposit = v1.ops.find((o) => o.kind === "move_rename" && o.before?.name === "Oakline invoice deposit.pdf")!;
  const v2 = await planById(first, first.app.revisePlan(v1.id, [{ seq: deposit.seq, newName: "Oakline deposit" }]).planId);

  const mark = drive.calls.length;
  assert.throws(() => first.app.approvePlan(v1.id, { contentHash: v1.contentHash, clientRequestId: "from-an-old-screen" }), (e) => e instanceof AppError && e.code === "stale_plan");
  assert.throws(() => first.app.approvePlan(v2.id, { contentHash: v1.contentHash, clientRequestId: "old-hash" }), (e) => e instanceof AppError && e.code === "hash_mismatch");
  assert.equal(first.app.approvePlan(v2.id, { contentHash: v2.contentHash, clientRequestId: "click-1" }).created, true);
  assert.equal(first.app.approvePlan(v2.id, { contentHash: v2.contentHash, clientRequestId: "click-2" }).created, false);
  first.app.close(); // Kiki stops before the job runs

  const second = newRig(t, { drive, db: dbPath });
  second.app.recover();
  assert.equal(second.app.approvePlan(v2.id, { contentHash: v2.contentHash, clientRequestId: "click-1" }).created, false, "the replayed click is the same approval");
  await second.app.settle();

  assert.equal((await planById(second, v2.id)).status, "applied");
  assert.equal(one<{ n: number }>(second.db, "SELECT COUNT(*) AS n FROM plan_approvals")!.n, 1);
  assert.equal(one<{ s: string }>(second.db, "SELECT status AS s FROM plans WHERE id = ?", v1.id)!.s, "superseded");
  const changes = drive.calls.slice(mark).filter((c) => MUTATIONS.includes(c.op));
  assert.equal(changes.filter((c) => c.op === "createFolder").length, 4);
  const moved = changes.filter((c) => c.op === "update").map((c) => c.id);
  assert.equal(moved.length, 4);
  assert.equal(new Set(moved).size, 4, "each file moved exactly once");
  assert.equal(changes.filter((c) => c.op === "createFile").length, 1, "one index file");
  const named = [...drive.files.values()].find((f) => f.name === "Oakline deposit.pdf");
  assert.ok(named, "the name from the approved version was used");
  assert.equal(drive.pathOf(named.id), `${WORKSPACE}/Projects/Flooring/Invoices/Oakline deposit.pdf`);
});

test("a proposal replaced while you were approving it runs nothing from either version", async (t) => {
  const rig = newRig(t);
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const v1 = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  // A new file arrives; Kiki's next look replaces the proposal before your approval reaches her.
  rig.drive.addFile("kitchen bill.pdf", one<{ r: string }>(rig.db, "SELECT root_file_id AS r FROM workspaces WHERE active = 1")!.r, "text/plain", "INVOICE\nNorthside Building Supply\nInvoice No: N-5590\nDate: 2026-10-08\nProject: Kitchen\nTotal (CAD): $80.00");
  rig.app.refreshInventory();
  await rig.app.settle();
  const mark = rig.drive.calls.length;
  assert.throws(() => rig.app.approvePlan(v1.id, { contentHash: v1.contentHash, clientRequestId: "late" }), (e) => e instanceof AppError && e.code === "stale_plan");
  await rig.app.settle();
  assert.deepEqual(rig.drive.calls.slice(mark).filter((c) => MUTATIONS.includes(c.op)), []);
});
