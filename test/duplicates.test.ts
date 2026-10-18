import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionItems } from "../server/services/attention.ts";
import { makeRig, organized, type TestRig } from "./helpers.ts";

const FOLDER = "application/vnd.google-apps.folder";
const CLEAN = "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf";

function setup(rig: TestRig) {
  const files = [...rig.drive.files.values()];
  const quote = files.find((f) => f.name === CLEAN)!;
  const quotesFolder = files.find((f) => f.mimeType === FOLDER && f.name === "Quotes")!;
  const root = rig.app.ctx.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string };
  return { quote, quotesFolder, root: root.root_file_id, content: quote.content as Buffer };
}

async function proposal(rig: TestRig) {
  rig.app.refreshInventory();
  await rig.app.settle();
  return (await rig.app.view()).plans.find((p) => p.status === "proposed");
}

const wsId = (rig: TestRig) => (rig.app.ctx.db.prepare("SELECT id FROM workspaces WHERE active = 1").get() as { id: string }).id;

test("an exact copy dropped into the folder is set aside next to the original, never deleted, and listed once", async () => {
  const rig = makeRig();
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  const { quote, root, content } = setup(rig);
  const copyId = rig.drive.addFile("scan_0012 (1).pdf", root, "application/pdf", content);

  const plan = await proposal(rig);
  assert.ok(plan, "Kiki proposes something");
  assert.equal(plan.title, "Set aside a duplicate copy");
  const move = plan.ops.find((o) => o.kind === "move_rename")!;
  assert.equal(move.before?.name, "scan_0012 (1).pdf");
  assert.equal(move.after?.path, "Renovations/Flooring/Quotes/Duplicates");
  assert.equal(move.after?.name, CLEAN, "same clear name, in its own folder");
  assert.match(move.reason, /exact copy/);
  assert.equal((await rig.app.view()).notifications.length, 0, "housekeeping isn't texted");

  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "dup-1" });
  await rig.app.settle();
  assert.equal(rig.drive.pathOf(copyId), `Renovation paperwork/Renovations/Flooring/Quotes/Duplicates/${CLEAN}`);
  assert.equal(rig.drive.pathOf(quote.id), `Renovation paperwork/Renovations/Flooring/Quotes/${CLEAN}`, "the original stays put");
  assert.equal(rig.drive.files.size, [...rig.drive.files.values()].length);

  const view = await rig.app.view();
  assert.equal(view.index.flatMap((p) => p.rows).filter((r) => r.reference === "Q-1042").length, 1, "the index lists the quote once");
  assert.equal(attentionItems(rig.app.ctx, wsId(rig), "2026-10-17").filter((i) => i.title.includes("Q-1042")).length, 1, "and so does Needs a look");
  assert.equal(await proposal(rig), undefined, "replaying proposes nothing");
  rig.app.close();
});

test("a numbered copy already filed next to the original (an earlier double upload) gets set aside too", async () => {
  const rig = makeRig();
  await organized(rig);
  const { quotesFolder, content } = setup(rig);
  const copyId = rig.drive.addFile("2026-09-28 Quote - Oakline Flooring Co. - Q-1042 (2).pdf", quotesFolder.id, "application/pdf", content);
  const plan = await proposal(rig);
  assert.ok(plan);
  const move = plan.ops.find((o) => o.kind === "move_rename")!;
  assert.equal(move.after?.path, "Renovations/Flooring/Quotes/Duplicates");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "dup-2" });
  await rig.app.settle();
  assert.equal(rig.drive.pathOf(copyId), `Renovation paperwork/Renovations/Flooring/Quotes/Duplicates/${CLEAN}`);
  rig.app.close();
});

test("a file that reads the same but isn't identical is pointed out, not moved, and its numbered name isn't re-proposed", async () => {
  const rig = makeRig();
  await organized(rig);
  const { root, content } = setup(rig);
  // Same quote with a signature line added: maybe the signed copy, so both stay.
  const signedText = Buffer.concat([content, Buffer.from("\n% signed copy\n")]);
  const signedId = rig.drive.addFile("Oakline signed.pdf", root, "application/pdf", signedText);
  const plan = await proposal(rig);
  assert.ok(plan);
  const move = plan.ops.find((o) => o.kind === "move_rename")!;
  assert.equal(move.after?.path, "Renovations/Flooring/Quotes", "filed normally");
  assert.equal(move.after?.name, "2026-09-28 Quote - Oakline Flooring Co. - Q-1042 (2).pdf");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "dup-3" });
  await rig.app.settle();
  assert.match(rig.drive.pathOf(signedId), /Quotes\/2026-09-28 Quote - Oakline Flooring Co\. - Q-1042 \(2\)\.pdf$/);

  const dup = attentionItems(rig.app.ctx, wsId(rig), "2026-10-17").find((i) => i.kind === "duplicate");
  assert.ok(dup, "pointed out");
  assert.match(dup.title, /^2 files look like the same Quote Q-1042/);
  // Before the fix, the numbered file was "moved" onto itself on every look.
  assert.equal(await proposal(rig), undefined, "nothing to do");
  rig.app.close();
});
