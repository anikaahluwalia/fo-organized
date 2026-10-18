// Kiki learns from your answers: where you put a kind of document, and that you keep names. A
// lesson only shapes the next proposal (which you still approve), and you can forget it.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one } from "../server/db.ts";
import { checkPattern, matchLesson, plainPattern, type PlaceLesson } from "../server/domain/lessons.ts";
import { adjustOrganize } from "../server/services/plans.ts";
import { makeRig, organized, type TestRig } from "./helpers.ts";

const timesheet = (title: string) => `NOTES\nTitle: ${title}\nHours: 12`;

async function rig(t: TestContext): Promise<TestRig & { root: string }> {
  const r = makeRig();
  r.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => r.app.close());
  await organized(r);
  const root = one<{ root_file_id: string }>(r.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  return Object.assign(r, { root });
}

/** Drops a file and waits for Kiki's proposal. */
async function drop(r: TestRig & { root: string }, name: string, content: string) {
  const id = r.drive.addFile(name, r.root, "text/plain", content);
  r.app.refreshInventory();
  await r.app.settle();
  return { id, plan: (await r.app.view()).plans.find((p) => p.status === "proposed") };
}

async function approve(r: TestRig, planId: string) {
  const plan = (await r.app.view()).plans.find((p) => p.id === planId)!;
  r.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `ok-${plan.id}` });
  await r.app.settle();
}

test("you put a timesheet in Work; the next timesheet is proposed for Work, like last time", async (t) => {
  const r = await rig(t);
  const first = await drop(r, "Timesheet Aug 23-29.txt", timesheet("Timesheet Aug 23-29"));
  assert.ok(first.plan, "Kiki asks where it goes");
  const placed = r.app.placeFile(first.plan.id, first.id, "Work");
  await approve(r, placed.planId);
  assert.match(r.drive.pathOf(first.id), /\/Projects\/Work\//);

  const lessons = (await r.app.view()).lessons;
  assert.equal(lessons.length, 1);
  assert.match(lessons[0]!.text, /^Timesheet documents go in Work › Notes\.$/);

  const next = await drop(r, "Timesheet Sep 1-7.txt", timesheet("Timesheet Sep 1-7"));
  const move = next.plan?.ops.find((o) => o.kind === "move_rename" && o.before?.name === "Timesheet Sep 1-7.txt");
  assert.ok(move, "proposed, not asked about");
  assert.match(move.after!.path, /^Projects\/Work\//);
  assert.match(move.reason ?? "", /like the timesheet documents you filed there before/);
  assert.match(r.drive.pathOf(next.id), new RegExp(`/Timesheet Sep 1-7\\.txt$`), "and nothing moved before you approve");

  await approve(r, next.plan!.id);
  assert.equal((await r.app.view()).lessons[0]!.examples, 2, "your yes backs it up");
});

test("forgetting a lesson takes it back: the next one is asked about again", async (t) => {
  const r = await rig(t);
  const first = await drop(r, "Timesheet Aug 23-29.txt", timesheet("Timesheet Aug 23-29"));
  await approve(r, r.app.placeFile(first.plan!.id, first.id, "Work").planId);
  r.app.forgetLesson((await r.app.view()).lessons[0]!.id);
  assert.deepEqual((await r.app.view()).lessons, []);
  const next = await drop(r, "Timesheet Sep 1-7.txt", timesheet("Timesheet Sep 1-7"));
  assert.equal(next.plan?.ops.some((o) => o.before?.name === "Timesheet Sep 1-7.txt"), false);
  assert.match(next.plan?.title ?? "", /Where does "Timesheet Sep 1-7\.txt" go\?/);
});

test("a lesson never overrides what a document says: a stated project still decides", async (t) => {
  const r = await rig(t);
  const first = await drop(r, "Timesheet Aug 23-29.txt", timesheet("Timesheet Aug 23-29"));
  await approve(r, r.app.placeFile(first.plan!.id, first.id, "Work").planId);
  const next = await drop(r, "Timesheet flooring.txt", "NOTES\nTitle: Timesheet for the floors\nProject: Flooring\nHours: 3");
  const move = next.plan?.ops.find((o) => o.before?.name === "Timesheet flooring.txt");
  assert.match(move?.after?.path ?? "", /^Projects\/Flooring\//);
});

test("keeping names on two separate proposals: Kiki stops proposing renames", async (t) => {
  const r = await rig(t);
  for (const [i, name] of ["Northside receipt one.txt", "Northside receipt two.txt"].entries()) {
    const d = await drop(r, name, `RECEIPT\nNorthside Building Supply\nReceipt No: R-${100 + i}\nDate: 2026-10-1${i}\nProject: Flooring\nTotal (CAD): $10.00`);
    const op = d.plan!.ops.find((o) => o.before?.name === name)!;
    assert.notEqual(op.after?.name, name, "Kiki proposes a new name");
    const kept = adjustOrganize(r.app.ctx, d.plan!.id, { [d.id]: { keepName: true } });
    await approve(r, kept.planId);
  }
  assert.ok((await r.app.view()).lessons.some((l) => l.kind === "keep_names"));
  const d = await drop(r, "Northside receipt three.txt", "RECEIPT\nNorthside Building Supply\nReceipt No: R-300\nDate: 2026-10-20\nProject: Flooring\nTotal (CAD): $10.00");
  const op = d.plan!.ops.find((o) => o.before?.name === "Northside receipt three.txt")!;
  assert.equal(op.after?.name, "Northside receipt three.txt");
  assert.match(op.reason ?? "", /Keeps its name, as you usually do/);
});

test("Kiki keeps a description of a kind of document only if its words come from the document", () => {
  const facts = null;
  const name = "Ahluwalia,Anika_Timesheet_Aug23,2026-Aug29,2026.xlsm - DOM Weekly Timesheet (1).pdf";
  assert.deepEqual(checkPattern({ description: "weekly timesheets", keywords: ["timesheet"] }, name, facts), []);
  assert.match(checkPattern({ description: "payroll sheets", keywords: ["payroll"] }, name, facts).join(" "), /isn't in the document/);
  assert.match(checkPattern({ description: "august files", keywords: ["aug"] }, name, facts).join(" "), /doesn't tell documents apart/);
  assert.match(checkPattern({ description: "pdf files", keywords: ["pdf"] }, name, facts).join(" "), /doesn't tell documents apart/);
  assert.deepEqual(plainPattern("Timesheet Aug 23-29.txt", null), { description: "timesheet documents", keywords: ["timesheet"] });
  const lessons: PlaceLesson[] = [
    { id: "a", description: "timesheets", keywords: ["timesheet"], place: "Projects/Work/Notes", examples: 1, updatedAt: "2026-10-18" },
    { id: "b", description: "DOM timesheets", keywords: ["dom", "timesheet"], place: "Projects/DOM/Notes", examples: 1, updatedAt: "2026-10-17" },
  ];
  assert.equal(matchLesson(lessons, name, null)?.id, "b", "the more specific one");
  assert.equal(matchLesson(lessons, "receipt.pdf", null), null);
});
