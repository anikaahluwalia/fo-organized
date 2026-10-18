// S4-ACCEPT, clause 4: "replays and restarts make no duplicates", including a crash between a
// Drive call and recording it. A step interrupted mid-call is settled by reading Drive back.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one, run } from "../../server/db.ts";
import { FakeDrive, type FakeOp } from "../../server/google/fake.ts";
import type { DriveFile } from "../../server/google/types.ts";
import type { PlanView } from "../../shared/api.ts";
import { makeRig, organized, tempDbPath, type TestRig } from "../helpers.ts";

const INDEX = "Flooring - document index (kept by Kiki).csv";
const MUTATIONS: FakeOp[] = ["createFolder", "update", "createFile", "updateContent"];

/**
 * Applies one chosen change and then never answers, as if Kiki's process died right after Google
 * applied it. The app that made the call is abandoned; a new one starts on the same database file.
 */
class CrashingDrive extends FakeDrive {
  crashOnUpdateOf: string | null = null;
  crashOnContentOf: string | null = null;
  crashOnCreateNamed: string | null = null;
  private onCrash: () => void = () => {};
  readonly crashed = new Promise<void>((resolve) => {
    this.onCrash = resolve;
  });
  private hang(): Promise<DriveFile> {
    this.onCrash();
    return new Promise<DriveFile>(() => {});
  }
  async update(id: string, change: { name?: string; addParent?: string; removeParent?: string }): Promise<DriveFile> {
    if (id !== this.crashOnUpdateOf) return super.update(id, change);
    this.crashOnUpdateOf = null;
    await super.update(id, change);
    return this.hang();
  }
  async updateContent(id: string, mimeType: string, content: Buffer | string): Promise<DriveFile> {
    if (id !== this.crashOnContentOf) return super.updateContent(id, mimeType, content);
    this.crashOnContentOf = null;
    await super.updateContent(id, mimeType, content);
    return this.hang();
  }
  async createFile(input: { id?: string; name: string; parentId: string; mimeType: string; content: Buffer | string }): Promise<DriveFile> {
    if (input.name !== this.crashOnCreateNamed) return super.createFile(input);
    this.crashOnCreateNamed = null;
    await super.createFile(input);
    return this.hang();
  }
}

function newRig(t: TestContext, opts: Parameters<typeof makeRig>[0] = {}): TestRig {
  const rig = makeRig(opts);
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

async function restarted(t: TestContext, dbPath: string, drive: FakeDrive): Promise<TestRig> {
  const rig = newRig(t, { drive, db: dbPath });
  rig.app.recover();
  await rig.app.settle();
  return rig;
}

const only = (drive: FakeDrive, name: string) => {
  const found = [...drive.files.values()].filter((f) => f.name === name && !f.trashed);
  assert.equal(found.length, 1, `expected exactly one "${name}" in Drive, found ${found.length}`);
  return found[0]!;
};
const approve = (rig: TestRig, plan: PlanView, id = `approve-${plan.id}`) => rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: id });
const retryNow = (rig: TestRig) => run(rig.db, "UPDATE jobs SET run_after = ? WHERE state = 'queued'", new Date(0).toISOString());
const planView = async (rig: TestRig, id: string) => (await rig.app.view()).plans.find((p) => p.id === id)!;
const indexOp = (plan: PlanView) => plan.ops.find((o) => o.kind === "write_index")!;

/** The demo organized, then the new Northside invoice proposed: one move and an update of the existing index. */
async function secondPlan(rig: TestRig): Promise<PlanView> {
  await organized(rig);
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  assert.equal(indexOp(plan).title, "Update the project index file");
  return plan;
}

test("an index write whose response was lost is settled by reading Drive back, not reported as someone else's edit", async (t) => {
  const rig = newRig(t);
  const plan = await secondPlan(rig);
  const index = only(rig.drive, INDEX).id;
  rig.drive.fail({ op: "updateContent", fileId: index, mode: "lost_after_apply" });
  approve(rig, plan);
  await rig.app.settle();
  retryNow(rig); // the job retries after its backoff
  await rig.app.settle();

  const after = await planView(rig, plan.id);
  assert.doesNotMatch(indexOp(after).error ?? "", /Someone edited/, "Kiki blames someone else for her own write");
  assert.equal(after.status, "applied");
  assert.match(rig.drive.files.get(index)?.content?.toString("utf8") ?? "", /N-5602/, "the index lists the new invoice");
});

test("Kiki dies inside an index write: after the restart the step is settled by reading Drive back, and Try again isn't stuck", async (t) => {
  const dbPath = tempDbPath();
  const drive = new CrashingDrive("mock");
  const first = newRig(t, { drive, db: dbPath });
  const plan = await secondPlan(first);
  const index = only(drive, INDEX).id;
  drive.crashOnContentOf = index;
  approve(first, plan);
  void first.app.settle(); // never finishes: the process "dies" inside the Drive call
  await drive.crashed;
  first.app.close();

  const second = await restarted(t, dbPath, drive);
  let after = await planView(second, plan.id);
  if (after.status !== "applied" && after.canResume) {
    second.app.resumePlan(plan.id);
    await second.app.settle();
    after = await planView(second, plan.id);
  }
  assert.doesNotMatch(indexOp(after).error ?? "", /Someone edited/, "Kiki blames someone else for her own write");
  assert.equal(after.status, "applied");
});

test("evidence: Kiki dies inside a move, restarts, and the replayed approval makes no duplicate folder, move or index", async (t) => {
  const dbPath = tempDbPath();
  const drive = new CrashingDrive("mock");
  const first = newRig(t, { drive, db: dbPath });
  await first.app.createDemoWorkspace();
  await first.app.settle();
  const plan = (await first.app.view()).plans.find((p) => p.status === "proposed")!;
  const mark = drive.calls.length;
  drive.crashOnUpdateOf = only(drive, "invoice final FINAL.pdf").id; // the second move
  approve(first, plan, "click-1");
  void first.app.settle();
  await drive.crashed;
  first.app.close();

  const second = await restarted(t, dbPath, drive);
  assert.equal(approve(second, plan, "click-1").created, false);
  assert.equal(approve(second, plan, "click-2").created, false);
  await second.app.settle();

  assert.equal((await planView(second, plan.id)).status, "applied");
  const changes = drive.calls.slice(mark).filter((c) => MUTATIONS.includes(c.op));
  assert.equal(changes.filter((c) => c.op === "createFolder").length, 4);
  const moved = changes.filter((c) => c.op === "update").map((c) => c.id);
  assert.equal(moved.length, 4);
  assert.equal(new Set(moved).size, 4, "each file moved once");
  only(drive, INDEX);
  for (const name of ["Projects", "Flooring", "Invoices", "Quotes"]) only(drive, name);
  assert.equal(one<{ n: number }>(second.db, "SELECT COUNT(*) AS n FROM change_log")!.n, 8, "4 folders and 4 moves recorded once");
});

test("evidence: Kiki dies right after creating a new index: after the restart there's one index, verified", async (t) => {
  const dbPath = tempDbPath();
  const drive = new CrashingDrive("mock");
  const first = newRig(t, { drive, db: dbPath });
  await first.app.createDemoWorkspace();
  await first.app.settle();
  const plan = (await first.app.view()).plans.find((p) => p.status === "proposed")!;
  drive.crashOnCreateNamed = INDEX;
  approve(first, plan);
  void first.app.settle();
  await drive.crashed;
  first.app.close();

  const second = await restarted(t, dbPath, drive);
  const after = await planView(second, plan.id);
  assert.equal(after.status, "applied");
  assert.equal(indexOp(after).state, "verified");
  only(drive, INDEX);
});
