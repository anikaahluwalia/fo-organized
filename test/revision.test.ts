import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGmail } from "../server/google/gmail.ts";
import { makeRig, organized, type TestRig } from "./helpers.ts";

const CONTRACTOR = { contractorName: "Oakline Flooring", contractorEmail: "quotes@oakline.example", consent: true };

/** Organizes the demo folder, then has Fo ask Oakline whether Q-1042 is final. The mock contractor answers right away. */
async function askedOakline(rig: TestRig) {
  await organized(rig);
  rig.app.updateSettings({ userName: "Anika" });
  let view = await rig.app.view();
  const quote = view.index.flatMap((p) => p.rows).find((r) => r.reference === "Q-1042");
  assert.ok(quote, "Q-1042 is in the index");
  const { versionId } = rig.app.createOutreachDraft(quote.docId, CONTRACTOR);
  view = await rig.app.view();
  const draft = view.outreach.find((o) => o.documentId === quote.docId)?.draft;
  assert.ok(draft);
  rig.app.approveAndSend(versionId, { contentHash: draft.contentHash, clientRequestId: "send-q1042" });
  await rig.app.settle();
  // Fo reported it sent; Kiki follows the conversation. Check it now rather than in a second.
  view = await rig.app.view();
  const watch = view.outreach.find((o) => o.documentId === quote.docId)?.dispatches[0]?.watch;
  assert.ok(watch && watch.state === "watching", "Kiki follows the Fo conversation");
  rig.app.checkNow(watch.id);
  await rig.app.settle();
  view = await rig.app.view();
  const update = view.updates[0];
  assert.ok(update, "Kiki picked up the contractor's reply");
  return update;
}

const rows = async (rig: TestRig) => (await rig.app.view()).index.flatMap((p) => p.rows);

test("the revised quote was emailed: Kiki finds it in Gmail, saves it after approval, and files it as current", async () => {
  const gmail = new FakeGmail();
  const rig = makeRig({ gmail, watchIntervalSeconds: 3600 });
  const update = await askedOakline(rig);

  // Nothing matching in Drive, so she looked in Gmail (read-only) for mail from that contractor since Fo asked.
  assert.equal(update.status, "needs_clarification");
  assert.deepEqual(
    gmail.searches.map((s) => s.from),
    ["quotes@oakline.example"],
  );
  assert.equal(update.emailAttachments.length, 1);
  assert.equal(update.emailAttachments[0]!.filename, "Oakline Flooring - revised quote.pdf");
  assert.equal(update.emailAttachments[0]!.saved, false);
  assert.match(update.question ?? "", /found "Oakline Flooring - revised quote.pdf"/);
  assert.equal([...rig.drive.files.values()].filter((f) => f.name === "Oakline Flooring - revised quote.pdf").length, 0, "nothing saved before approval");

  // Saving is a change, so it waits for the user. Saving twice makes one file.
  const first = await rig.app.saveGmailAttachment(update.id, 0);
  const again = await rig.app.saveGmailAttachment(update.id, 0);
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.fileId, first.fileId);
  await rig.app.settle();

  let view = await rig.app.view();
  const after = view.updates.find((u) => u.id === update.id)!;
  assert.equal(after.status, "proposed");
  const plan = view.plans.find((p) => p.id === after.planId)!;
  assert.equal(plan.kind, "version_update");
  assert.equal(plan.diff?.total?.delta, -470);
  // The organizing plan never tried to file the revised quote as an ordinary document.
  assert.ok(!view.plans.some((p) => p.kind === "organize" && p.status === "proposed" && p.ops.some((o) => o.before?.name === "Oakline Flooring - revised quote.pdf")));

  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve-update" });
  await rig.app.settle();
  const index = await rows(rig);
  assert.equal(index.find((r) => r.reference === "Q-1042-R1")?.status, "current");
  assert.equal(index.find((r) => r.reference === "Q-1042")?.status, "superseded");
  const saved = rig.drive.files.get(first.fileId)!;
  assert.match(rig.drive.pathOf(saved.id), /^Renovation paperwork\/Renovations\/Flooring\/Quotes\/[^/]+Q-1042-R1\.pdf$/);
  assert.equal([...rig.drive.files.values()].filter((f) => f.name.includes("Q-1042-R1")).length, 1, "one copy");
  rig.app.close();
});

test("the revised quote lands in Drive while Kiki waits: she links it without Check again", async () => {
  const rig = makeRig({ watchIntervalSeconds: 3600 });
  const update = await askedOakline(rig);
  assert.equal(update.status, "needs_clarification");
  assert.equal(update.emailAttachments.length, 0);
  assert.match(update.question ?? "", /pick it up/);

  await rig.app.stageRevision("single");
  await rig.app.settle();
  const view = await rig.app.view();
  const after = view.updates.find((u) => u.id === update.id)!;
  assert.equal(after.status, "proposed", "picked up on her own");
  assert.ok(
    !view.plans.some((p) => p.kind === "organize" && p.status === "proposed" && p.ops.some((o) => o.before?.name === "Oakline Flooring - revised quote.pdf")),
    "held for the update, not filed as new",
  );
  assert.ok(view.activity.events.some((e) => e.message.includes("landed in the folder")));
  rig.app.close();
});

test("none of these: rejected candidates become ordinary documents and aren't offered again", async () => {
  const rig = makeRig({ watchIntervalSeconds: 3600 });
  const update = await askedOakline(rig);
  await rig.app.stageRevision("ambiguous");
  await rig.app.settle();
  let view = await rig.app.view();
  let u = view.updates.find((x) => x.id === update.id)!;
  assert.equal(u.status, "needs_clarification");
  assert.equal(u.candidates.length, 2, "two possible revisions: Kiki asks, never guesses");

  rig.app.resolveOutcome(update.id, null);
  await rig.app.settle();
  view = await rig.app.view();
  u = view.updates.find((x) => x.id === update.id)!;
  assert.equal(u.status, "needs_clarification");
  assert.equal(u.candidates.length, 0);
  const organize = view.plans.find((p) => p.kind === "organize" && p.status === "proposed");
  assert.ok(organize, "the rejected quotes get filed as ordinary documents");
  assert.equal(organize.ops.filter((o) => o.kind === "move_rename").length, 2);

  // Checking again doesn't bring back what the user already said no to.
  rig.app.recheckOutcome(update.id);
  await rig.app.settle();
  u = (await rig.app.view()).updates.find((x) => x.id === update.id)!;
  assert.equal(u.candidates.length, 0);
  rig.app.close();
});
