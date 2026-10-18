// S4-1: a retry can rewrite an index file the user edited or moved out of the workspace.
// Each test asserts the correct behavior: it fails on the current code for the stated reason.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one, run } from "../../server/db.ts";
import { DriveError } from "../../server/google/types.ts";
import type { FakeDrive } from "../../server/google/fake.ts";
import type { PlanView } from "../../shared/api.ts";
import { makeRig, organized, type TestRig } from "../helpers.ts";

const INDEX = "Flooring - document index (kept by Kiki).csv";
const USER_NOTES = "Dad's notes,keep these\r\n";

function newRig(t: TestContext): TestRig {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

function only(drive: FakeDrive, name: string) {
  const found = [...drive.files.values()].filter((f) => f.name === name && !f.trashed);
  assert.equal(found.length, 1, `expected exactly one "${name}" in Drive, found ${found.length}`);
  return found[0]!;
}

async function planById(rig: TestRig, id: string): Promise<PlanView> {
  const plan = (await rig.app.view()).plans.find((p) => p.id === id);
  assert.ok(plan, `plan ${id} isn't in the view`);
  return plan;
}

async function proposal(rig: TestRig): Promise<PlanView> {
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(plan, "expected an open proposal");
  return plan;
}

const approve = (rig: TestRig, plan: PlanView) => rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
const permissionDenied = () => new DriveError("Drive refused: you don't have permission to move this file.", "permission", { status: 403 });
const passingProblem = () => new DriveError("Google Drive had a temporary problem.", "server", { status: 503 });
const contentOf = (drive: FakeDrive, id: string) => drive.files.get(id)?.content?.toString("utf8") ?? null;
/** Calls since mark that wrote file content to this file. */
const writesTo = (drive: FakeDrive, mark: number, id: string) => drive.calls.slice(mark).filter((c) => (c.op === "updateContent" || c.op === "createFile") && c.id === id);
/** The job queue waits 2s, 4s, ... before retrying; make the waiting retries due now. */
const retryNow = (rig: TestRig) => run(rig.db, "UPDATE jobs SET run_after = ? WHERE state = 'queued'", new Date(0).toISOString());
const planStatus = (rig: TestRig, id: string) => one<{ status: string }>(rig.db, "SELECT status FROM plans WHERE id = ?", id)?.status;

/** The first organizing plan, applied except for the deposit invoice (Drive refused to move it). The index was created. */
async function partialFirstPlan(t: TestContext) {
  const rig = newRig(t);
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const plan = await proposal(rig);
  assert.equal(plan.ops.find((o) => o.kind === "write_index")?.title, "Create the project index file");
  rig.drive.fail({ op: "update", fileId: only(rig.drive, "Oakline invoice deposit.pdf").id, mode: "error", error: permissionDenied() });
  approve(rig, plan);
  await rig.app.settle();
  assert.equal(planStatus(rig, plan.id), "partial");
  return { rig, plan, index: only(rig.drive, INDEX).id };
}

test("Try again doesn't overwrite an index Kiki created and you edited since", async (t) => {
  const { rig, plan, index } = await partialFirstPlan(t);
  await rig.drive.updateContent(index, "text/csv", USER_NOTES); // you add your notes to the index in Drive

  rig.app.resumePlan(plan.id);
  await rig.app.settle();

  assert.equal(contentOf(rig.drive, index), USER_NOTES, "your edit to the index was overwritten by the retry");
  assert.notEqual((await planById(rig, plan.id)).ops.find((o) => o.kind === "write_index")?.state, "verified");
});

test("Try again doesn't write to an index Kiki created and you moved out of the workspace", async (t) => {
  const { rig, plan, index } = await partialFirstPlan(t);
  rig.drive.touch(index, { parent: "root" }); // you drag it into My Drive, outside the workspace
  rig.app.refreshInventory(); // and Kiki's regular look at the folder has noticed it's gone
  await rig.app.settle();
  const before = contentOf(rig.drive, index);
  const mark = rig.drive.calls.length;

  rig.app.resumePlan(plan.id);
  await rig.app.settle();

  assert.deepEqual(writesTo(rig.drive, mark, index), [], "Kiki wrote to a file outside the workspace");
  assert.equal(contentOf(rig.drive, index), before);
});

test("a job retry after a passing Drive error doesn't overwrite an index you edited in between", async (t) => {
  const rig = newRig(t);
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const plan = await proposal(rig);
  // Kiki creates the index, then Drive has a passing problem before she finishes (reading it back):
  // the job retries later.
  rig.drive.fail({ op: "readContent", mode: "error", error: passingProblem(), times: 1 });
  approve(rig, plan);
  await rig.app.settle();
  assert.equal(planStatus(rig, plan.id), "executing", "waiting for the job's retry");
  const index = only(rig.drive, INDEX).id;
  await rig.drive.updateContent(index, "text/csv", USER_NOTES); // meanwhile you edit the new index

  retryNow(rig);
  await rig.app.settle();

  assert.equal(contentOf(rig.drive, index), USER_NOTES, "the retry overwrote your edit");
});

test("a job retry after a passing Drive error doesn't write to an index you moved out of the workspace in between", async (t) => {
  const rig = newRig(t);
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const plan = await proposal(rig);
  rig.drive.fail({ op: "updateContent", mode: "error", error: passingProblem() });
  approve(rig, plan);
  await rig.app.settle();
  const index = only(rig.drive, INDEX).id;
  rig.drive.touch(index, { parent: "root" }); // meanwhile you drag it into My Drive
  const mark = rig.drive.calls.length;

  retryNow(rig);
  await rig.app.settle();

  assert.deepEqual(writesTo(rig.drive, mark, index), [], "the retry wrote to a file outside the workspace");
});

test("Try again doesn't write to an existing index you moved out of the workspace", async (t) => {
  const rig = newRig(t);
  await organized(rig);
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const plan = await proposal(rig);
  assert.equal(plan.ops.find((o) => o.kind === "write_index")?.title, "Update the project index file");
  rig.drive.fail({ op: "update", fileId: only(rig.drive, "Northside invoice Oct 17.pdf").id, mode: "error", error: permissionDenied() });
  approve(rig, plan);
  await rig.app.settle();
  assert.equal(planStatus(rig, plan.id), "failed");
  const index = only(rig.drive, INDEX).id;
  rig.drive.touch(index, { parent: "root" }); // you drag the index into My Drive
  const before = contentOf(rig.drive, index);
  const mark = rig.drive.calls.length;

  rig.app.resumePlan(plan.id);
  await rig.app.settle();

  assert.deepEqual(writesTo(rig.drive, mark, index), [], "Kiki wrote to a file outside the workspace");
  assert.equal(contentOf(rig.drive, index), before);
});

test("same root cause without a retry: an existing index moved out after the proposal is written to", async (t) => {
  const rig = newRig(t);
  await organized(rig);
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const plan = await proposal(rig);
  const index = only(rig.drive, INDEX).id;
  rig.drive.touch(index, { parent: "root" }); // moved out after Kiki proposed, before you approved
  const before = contentOf(rig.drive, index);
  const mark = rig.drive.calls.length;

  approve(rig, plan);
  await rig.app.settle();

  assert.deepEqual(writesTo(rig.drive, mark, index), [], "Kiki wrote to a file outside the workspace");
  assert.equal(contentOf(rig.drive, index), before);
});
