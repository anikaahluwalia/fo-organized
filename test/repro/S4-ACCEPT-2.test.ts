// S4-ACCEPT, clause 2: "Drive is read back". A Drive that answers "done" without applying the
// change must not produce a verified step. Evidence: these pass on the current code.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { FakeDrive } from "../../server/google/fake.ts";
import type { DriveFile } from "../../server/google/types.ts";
import type { PlanView } from "../../shared/api.ts";
import { makeRig, organized, type TestRig } from "../helpers.ts";

const WORKSPACE = "Renovation paperwork";
const INDEX = "Flooring - document index (kept by Kiki).csv";

/** Answers a move or a content write as if it worked, without doing it. */
class SaysDoneDrive extends FakeDrive {
  ignoreUpdateOf: string | null = null;
  ignoreContentOf: string | null = null;
  async update(id: string, change: { name?: string; addParent?: string; removeParent?: string }): Promise<DriveFile> {
    if (id !== this.ignoreUpdateOf) return super.update(id, change);
    const f = await super.getFile(id);
    return { ...f, name: change.name ?? f.name, parents: change.addParent ? [change.addParent] : f.parents };
  }
  async updateContent(id: string, mimeType: string, content: Buffer | string): Promise<DriveFile> {
    if (id !== this.ignoreContentOf) return super.updateContent(id, mimeType, content);
    return super.getFile(id);
  }
}

function newRig(t: TestContext, drive: FakeDrive): TestRig {
  const rig = makeRig({ drive });
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

const fileNamed = (drive: FakeDrive, name: string) => [...drive.files.values()].find((f) => f.name === name && !f.trashed)!;
const approve = (rig: TestRig, plan: PlanView) => rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });

test("a move Drive says it made, but didn't, isn't reported as applied", async (t) => {
  const drive = new SaysDoneDrive("mock");
  const rig = newRig(t, drive);
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  const deposit = fileNamed(drive, "Oakline invoice deposit.pdf").id;
  drive.ignoreUpdateOf = deposit;
  approve(rig, plan);
  await rig.app.settle();

  const view = await rig.app.view();
  const after = view.plans.find((p) => p.id === plan.id)!;
  assert.equal(after.status, "partial");
  const step = after.ops.find((o) => o.kind === "move_rename" && o.before?.name === "Oakline invoice deposit.pdf")!;
  assert.equal(step.state, "failed");
  assert.match(step.error ?? "", /Drive reports a different result/);
  assert.equal(drive.pathOf(deposit), `${WORKSPACE}/Oakline invoice deposit.pdf`);
  assert.equal(view.index.flatMap((p) => p.rows).find((r) => r.reference === "INV-3307")?.folder, "(workspace folder)", "the index shows where the file really is");
  assert.equal(view.activity.events.some((e) => e.kind === "verified"), false, "nothing claims it's done");
});

test("an index write Drive says it made, but didn't, isn't reported as applied", async (t) => {
  const drive = new SaysDoneDrive("mock");
  const rig = newRig(t, drive);
  await organized(rig);
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  drive.ignoreContentOf = fileNamed(drive, INDEX).id;
  approve(rig, plan);
  await rig.app.settle();

  const after = (await rig.app.view()).plans.find((p) => p.id === plan.id)!;
  assert.equal(after.status, "partial");
  const write = after.ops.find((o) => o.kind === "write_index")!;
  assert.equal(write.state, "failed");
  assert.match(write.error ?? "", /different index contents/);
});
