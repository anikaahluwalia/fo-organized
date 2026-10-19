// Step 2 findings from the 2026-10-18 reviews, each reproduced before it's fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePdf } from "../server/demo/pdf.ts";
import { MESSY_FOLDER } from "../server/demo/renovation.ts";
import { mockRead } from "../server/domain/documents.ts";
import { makeRig, organized, type TestRig } from "./helpers.ts";

const proposed = async (rig: TestRig) => (await rig.app.view()).plans.find((p) => p.status === "proposed");
const look = async (rig: TestRig) => {
  rig.app.refreshInventory();
  await rig.app.settle();
};
const wsRoot = (rig: TestRig) => (rig.app.ctx.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id;

test("a name you chose for a file is kept after it's applied; Kiki doesn't propose renaming it back", async () => {
  const rig = makeRig();
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  let plan = (await proposed(rig))!;
  const step = plan.ops.find((o) => o.before?.name === "Oakline invoice deposit.pdf")!;
  const { planId } = rig.app.revisePlan(plan.id, [{ seq: step.seq, newName: "Oakline deposit (paid Oct 3)" }]);
  plan = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "named" });
  await rig.app.settle();
  assert.ok([...rig.drive.files.values()].some((f) => f.name === "Oakline deposit (paid Oct 3).pdf"));
  await look(rig);
  const again = await proposed(rig);
  assert.equal(again?.ops.some((o) => o.before?.name === "Oakline deposit (paid Oct 3).pdf") ?? false, false, "your name stays");
  rig.app.close();
});

test("your edits to a proposal survive when a quote update takes a different file out of it", async () => {
  const rig = makeRig();
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  // The revised Oakline quote is in the dump too, so the filing plan includes both Oakline quotes.
  await rig.app.stageRevision("single");
  await rig.app.settle();
  let plan = (await proposed(rig))!;
  const deposit = plan.ops.find((o) => o.before?.name === "Oakline invoice deposit.pdf")!;
  rig.app.revisePlan(plan.id, [{ seq: deposit.seq, newName: "Oakline deposit" }]);
  // You say the revision is the current one: that update takes both Oakline quotes out of the filing plan.
  const r1 = (await rig.app.view()).inventory.files.find((f) => f.name === "Oakline Flooring - revised quote.pdf")!.doc!.docId;
  rig.app.markCurrent(r1);
  plan = (await rig.app.view()).plans.find((p) => p.kind === "organize" && p.status === "proposed")!;
  assert.equal(plan.ops.some((o) => o.before?.name === "Oakline Flooring - revised quote.pdf"), false, "the revision left the filing plan");
  assert.equal(plan.ops.find((o) => o.before?.name === "Oakline invoice deposit.pdf")?.after?.name, "Oakline deposit.pdf", "your name for the deposit is still there");
  rig.app.close();
});

test("after you undo a filing, Kiki doesn't propose the same filing again", async () => {
  const rig = makeRig();
  await organized(rig);
  const applied = (await rig.app.view()).plans.find((p) => p.status === "applied")!;
  const { planId } = rig.app.proposeUndo(applied.id);
  const undo = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(undo.id, { contentHash: undo.contentHash, clientRequestId: "undo" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === planId)?.status, "applied");
  await look(rig);
  assert.equal(await proposed(rig), undefined, "no re-proposal of what you just undid");
  rig.app.close();
});

test("the exact copy you accepted is the one kept; the other copy is set aside", async () => {
  const rig = makeRig();
  await organized(rig);
  const quote = [...rig.drive.files.values()].find((f) => f.name === "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf")!;
  // The same quote again, saved later with a clear name, and that's the one you mark accepted.
  const later = rig.drive.addFile("Oakline Q-1042 accepted.pdf", wsRoot(rig), "application/pdf", quote.content as Buffer);
  await look(rig);
  const laterDoc = (await rig.app.view()).inventory.files.find((f) => f.fileId === later)!.doc!.docId;
  rig.app.acceptQuote(laterDoc, true);
  const plan = (await proposed(rig)) ?? null;
  await look(rig);
  const now = (await proposed(rig)) ?? plan;
  const setAside = now?.ops.filter((o) => o.kind === "move_rename" && o.after?.path.endsWith("/Duplicates")).map((o) => o.before?.name) ?? [];
  assert.ok(!setAside.includes("Oakline Q-1042 accepted.pdf"), "the accepted copy is never the one set aside");
  rig.app.close();
});

test("two empty files aren't exact copies of each other", async () => {
  const rig = makeRig();
  await organized(rig);
  // Claude reads an empty file as an unclear document (the mock reader refuses), which is what put one aside live.
  const reader = rig.app.ctx.reader;
  const read = reader.read.bind(reader);
  reader.read = async (content, name) => (content.kind === "text" && !content.text.trim() ? mockRead("") : read(content, name));
  rig.drive.addFile("notes.txt", wsRoot(rig), "text/plain", "");
  rig.drive.addFile("notes copy.txt", wsRoot(rig), "text/plain", "");
  await look(rig);
  const plan = await proposed(rig);
  assert.equal(plan?.ops.some((o) => o.after?.path.endsWith("Duplicates")) ?? false, false);
  rig.app.close();
});

test("a plan's title says what it does, for any kind of workspace", async () => {
  const rig = makeRig();
  const root = rig.drive.addFolder("Semester files", "root");
  rig.drive.addFile("scan.pdf", root, "application/pdf", makePdf(MESSY_FOLDER[0]!.title, MESSY_FOLDER[0]!.lines));
  await rig.app.selectWorkspace(root);
  await rig.app.settle();
  const plan = (await proposed(rig))!;
  assert.doesNotMatch(plan.title, /renovation/i, "not every workspace is renovation paperwork");
  assert.match(plan.title, /Semester files/);
  rig.app.close();
});

test("a collection's index lists every document filed into it, however its project was spelled", async () => {
  const rig = makeRig();
  const root = rig.drive.addFolder("Semester files", "root");
  rig.drive.addFile("lecture 7.txt", root, "text/plain", "NOTES\nTitle: Induction and invariants\nCourse: CS 245 - Logic and Computation");
  rig.drive.addFile("lecture 8.txt", root, "text/plain", "NOTES\nTitle: Structural induction\nCourse: CS245");
  await rig.app.selectWorkspace(root);
  await rig.app.settle();
  const plan = (await proposed(rig))!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "file-both" });
  await rig.app.settle();
  const paths = [...rig.drive.files.values()].filter((f) => f.name.endsWith(".txt")).map((f) => rig.drive.pathOf(f.id));
  assert.deepEqual(new Set(paths.map((p) => p.split("/").slice(0, 3).join("/"))).size, 1, "both lectures are in one collection");
  const collection = paths[0]!.split("/")[2]!;
  const view = await rig.app.view();
  assert.equal(view.index.find((p) => p.name === collection)?.rows.length, 2, "the collection's index lists both");
  assert.deepEqual(view.index.map((p) => p.name), [collection], "no leftover sections for the other spellings");
  const csv = [...rig.drive.files.values()].find((f) => f.name === `${collection} - document index (kept by Kiki).csv`);
  const rows = String(csv?.content ?? "").split("\n").filter((l) => l.startsWith("notes,"));
  assert.equal(rows.length, 2, "the index file in Drive lists both");
  rig.app.close();
});

test("after you undo setting a copy aside, Kiki doesn't propose setting it aside again", async () => {
  const rig = makeRig();
  await organized(rig);
  const quote = [...rig.drive.files.values()].find((f) => f.name === "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf")!;
  rig.drive.addFile("scan_0012 (1).pdf", wsRoot(rig), "application/pdf", quote.content as Buffer);
  await look(rig);
  const setAside = (await proposed(rig))!;
  assert.match(setAside.title, /Set aside/);
  rig.app.approvePlan(setAside.id, { contentHash: setAside.contentHash, clientRequestId: "aside" });
  await rig.app.settle();
  const { planId } = rig.app.proposeUndo(setAside.id);
  const undo = (await rig.app.view()).plans.find((p) => p.id === planId)!;
  rig.app.approvePlan(undo.id, { contentHash: undo.contentHash, clientRequestId: "undo-aside" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === planId)?.status, "applied");
  await look(rig);
  assert.equal(await proposed(rig), undefined, "no re-proposal of what you just undid");
  rig.app.close();
});

test("a project named with a colon or a slash is still filed, under a name a folder can have", async () => {
  const rig = makeRig();
  const root = rig.drive.addFolder("Work", "root");
  rig.drive.addFile("kickoff.txt", root, "text/plain", "NOTES\nTitle: Kickoff\nProject: Q3/Q4 planning");
  rig.drive.addFile("lecture.txt", root, "text/plain", "NOTES\nTitle: Induction\nCourse: CS 245: Logic and Computation");
  await rig.app.selectWorkspace(root);
  await rig.app.settle();
  const plan = (await proposed(rig))!;
  const moved = plan.ops.filter((o) => o.kind === "move_rename").map((o) => `${o.after?.path}`);
  assert.deepEqual(moved.sort(), ["Projects/CS 245 - Logic and Computation/Notes", "Projects/Q3-Q4 planning/Notes"]);
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "safe-names" });
  await rig.app.settle();
  const view = await rig.app.view();
  assert.deepEqual(view.index.map((p) => [p.name, p.rows.length]).sort(), [["CS 245 - Logic and Computation", 1], ["Q3-Q4 planning", 1]]);
  rig.app.close();
});

test("a plan that only writes a missing index again is titled for that, not as setting copies aside", async () => {
  const rig = makeRig();
  await organized(rig);
  const index = [...rig.drive.files.values()].find((f) => f.name.endsWith("(kept by Kiki).csv"))!;
  rig.drive.touch(index.id, { parent: "root" }); // you moved it out of the workspace
  await look(rig);
  // Kiki doesn't propose index upkeep unprompted; you ask for organizing.
  rig.app.proposeOrganize();
  const plan = await proposed(rig);
  assert.deepEqual(plan?.ops.map((o) => o.kind), ["write_index"], "Kiki proposes writing the index again");
  assert.equal(plan?.title, "Update the index");
  rig.app.close();
});
