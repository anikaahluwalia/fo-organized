// S4-ACCEPT, clause 5: "undo works where nothing changed since".
// Note: test/organize.test.ts ("a file changed after organizing makes its undo step stale...")
// asserts that the steps after the changed file are skipped. That is the behavior these tests flag.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { all } from "../../server/db.ts";
import type { FakeDrive } from "../../server/google/fake.ts";
import type { PlanView } from "../../shared/api.ts";
import { makeRig, organized, type TestRig } from "../helpers.ts";

const WORKSPACE = "Renovation paperwork";
const BRIGHT_FILED = "2026-09-20 Quote - Bright Floors Ltd. - BF-77.pdf";

function newRig(t: TestContext): TestRig {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

const only = (drive: FakeDrive, name: string) => [...drive.files.values()].find((f) => f.name === name && !f.trashed)!;
const planView = async (rig: TestRig, id: string) => (await rig.app.view()).plans.find((p) => p.id === id)!;
const approve = (rig: TestRig, plan: PlanView, id: string) => rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: id });

/** The demo organized; then you rename one filed quote in Drive. Returns where each other file started. */
async function organizedThenOneRenamed(t: TestContext) {
  const rig = newRig(t);
  await organized(rig);
  const applied = (await rig.app.view()).plans.find((p) => p.status === "applied")!;
  const unchanged = applied.ops
    .filter((o) => o.kind === "move_rename" && o.after?.name !== BRIGHT_FILED)
    .map((o) => ({ id: only(rig.drive, o.after!.name).id, original: `${WORKSPACE}/${o.before!.path ? `${o.before!.path}/` : ""}${o.before!.name}` }));
  const bright = only(rig.drive, BRIGHT_FILED).id;
  rig.drive.touch(bright, { name: "Bright Floors - keep.pdf" });
  return { rig, applied, unchanged, bright };
}

test("undo puts back every file that didn't change, and leaves the one you changed", async (t) => {
  const { rig, applied, unchanged, bright } = await organizedThenOneRenamed(t);
  const { planId } = rig.app.proposeUndo(applied.id);
  approve(rig, await planView(rig, planId), "undo-1");
  await rig.app.settle();

  assert.equal(rig.drive.pathOf(bright), `${WORKSPACE}/Projects/Flooring/Quotes/Bright Floors - keep.pdf`, "your rename is kept");
  assert.deepEqual(
    unchanged.map((f) => rig.drive.pathOf(f.id)),
    unchanged.map((f) => f.original),
    `files that didn't change weren't put back: ${JSON.stringify((await planView(rig, planId)).ops.map((o) => `${o.seq}:${o.state}`))}`,
  );
});

test("after an undo stopped at a changed file, undoing again still puts back the files that didn't change", async (t) => {
  const { rig, applied, unchanged } = await organizedThenOneRenamed(t);
  const first = rig.app.proposeUndo(applied.id).planId;
  approve(rig, await planView(rig, first), "undo-1");
  await rig.app.settle();
  const allBack = () => unchanged.every((f) => rig.drive.pathOf(f.id) === f.original);

  let second: string | null = null;
  if (!allBack()) {
    // You ask again (the original plan's "Undo these changes…"), and approve what Kiki proposes.
    second = rig.app.proposeUndo(applied.id).planId;
    approve(rig, await planView(rig, second), "undo-2");
    await rig.app.settle();
  }

  assert.deepEqual(
    unchanged.map((f) => rig.drive.pathOf(f.id)),
    unchanged.map((f) => f.original),
    `the files that didn't change can never be put back: ${second ? JSON.stringify((await planView(rig, second)).ops.map((o) => `${o.seq}:${o.title}:${o.state}`)) : ""}`,
  );
});

test("evidence: undoing a quote update where nothing changed restores both statuses and moves the old quote back", async (t) => {
  const rig = newRig(t);
  await organized(rig);
  await rig.app.stageRevision("single");
  await rig.app.settle();
  const filing = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  approve(rig, filing, "file-r1");
  await rig.app.settle();
  const r1 = (await rig.app.view()).index.flatMap((p) => p.rows).find((r) => r.reference === "Q-1042-R1")!;
  const statuses = () => all<{ ref: string; status: string }>(rig.db, "SELECT json_extract(facts_json, '$.reference.value') AS ref, version_status AS status FROM documents WHERE doc_type = 'quote' ORDER BY ref");
  const before = statuses();
  const oldQuote = only(rig.drive, "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf").id;
  const { planId } = rig.app.markCurrent(r1.docId);
  approve(rig, await planView(rig, planId), "make-current");
  await rig.app.settle();
  assert.equal(rig.drive.pathOf(oldQuote), `${WORKSPACE}/Projects/Flooring/Quotes/Superseded/2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf`);

  const undo = rig.app.proposeUndo(planId).planId;
  approve(rig, await planView(rig, undo), "undo-update");
  await rig.app.settle();
  assert.equal((await planView(rig, undo)).status, "applied");
  assert.deepEqual(statuses(), before);
  assert.equal(rig.drive.pathOf(oldQuote), `${WORKSPACE}/Projects/Flooring/Quotes/2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf`);
});
