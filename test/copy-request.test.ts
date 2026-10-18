import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGmail } from "../server/google/gmail.ts";
import { MockFoClient } from "../server/fo/mock.ts";
import { attentionItems } from "../server/services/attention.ts";
import { makeRig, organized, type TestRig } from "./helpers.ts";

const QUOTE = "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf";
const OAKLINE = { contractorName: "Oakline Flooring", contractorEmail: "quotes@oakline.example", consent: true };

/** Organized demo folder, then the quote the deposit invoice is for goes missing. */
async function quoteMissing(rig: TestRig) {
  await organized(rig);
  rig.app.updateSettings({ userName: "Anika" });
  const quote = [...rig.drive.files.values()].find((f) => f.name === QUOTE)!;
  const content = quote.content as Buffer;
  quote.trashed = true;
  rig.app.refreshInventory();
  await rig.app.settle();
  const item = (await rig.app.view()).attention.find((a) => a.kind === "missing");
  assert.ok(item?.copy, "Kiki points out the missing quote and who could send it");
  return { item, content, root: (rig.app.ctx.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id };
}

async function send(rig: TestRig, versionId: string) {
  const view = await rig.app.view();
  const o = view.outreach.find((x) => x.draft?.versionId === versionId)!;
  rig.app.approveAndSend(versionId, { contentHash: o.draft!.contentHash, clientRequestId: `send-${versionId}` });
  await rig.app.settle();
  return (await rig.app.view()).outreach.find((x) => x.documentId === o.documentId)!;
}

test("a missing quote: Fo asks the contractor for a copy, Kiki finds it in Gmail, you save it, and the request closes", async () => {
  const gmail = new FakeGmail();
  const fo = new MockFoClient({ stepMs: 5, replyDelayMs: 0 });
  fo.contractorReply = "Sure, I just emailed you a copy of quote Q-1042.";
  const rig = makeRig({ gmail, fo, watchIntervalSeconds: 3600 });
  const { item, content } = await quoteMissing(rig);
  assert.equal(item.copy!.issuer, "Oakline Flooring Co.");
  gmail.attachments.push({ messageId: "m1", attachmentId: "a1", filename: "Q-1042 copy.pdf", mimeType: "application/pdf", size: content.length, from: OAKLINE.contractorEmail, subject: "Quote Q-1042", date: new Date().toISOString(), data: content });

  const { versionId } = rig.app.requestCopy(item.copy!.documentId, { reference: "Q-1042", ...OAKLINE });
  let view = await rig.app.view();
  const o = view.outreach.find((x) => x.kind === "request_copy")!;
  assert.equal(o.title, "Ask Oakline Flooring for a copy of quote Q-1042");
  assert.equal(o.draft?.subject, "Copy of quote Q-1042");
  assert.match(o.draft?.body ?? "", /Your invoice INV-3307 mentions quote Q-1042, but we don't have a copy on file\./);
  assert.match(o.draft?.body ?? "", /I'm Kiki, an AI assistant helping Anika/);
  assert.equal(view.attention.find((a) => a.kind === "missing")?.copy?.asked, true);
  assert.equal(rig.app.requestCopy(item.copy!.documentId, { reference: "Q-1042", ...OAKLINE }).versionId, versionId, "asking twice drafts once");

  const sent = await send(rig, versionId);
  const watch = sent.dispatches[0]!.watch!;
  rig.app.checkNow(watch.id);
  await rig.app.settle();
  view = await rig.app.view();
  const update = view.updates[0]!;
  assert.equal(update.status, "needs_clarification");
  assert.match(update.question ?? "", /Oakline Flooring answered, and Kiki found "Q-1042 copy\.pdf" in their email since Fo asked/);
  assert.deepEqual(gmail.searches.map((s) => s.from), [OAKLINE.contractorEmail]);

  await rig.app.saveGmailAttachment(update.id, 0);
  await rig.app.settle();
  view = await rig.app.view();
  assert.equal(view.updates.find((u) => u.id === update.id)?.status, "resolved");
  assert.equal(view.outreach.find((x) => x.kind === "request_copy")?.dispatches[0]?.watch?.state, "closed", "Kiki stops following the conversation");
  assert.ok(!view.attention.some((a) => a.kind === "missing"), "nothing is missing any more");
  const filing = view.plans.find((p) => p.status === "proposed");
  assert.ok(filing?.ops.some((o) => o.before?.name === "Q-1042 copy.pdf" && o.after?.path === "Renovations/Flooring/Quotes"), "the copy is filed like any new document");
  rig.app.close();
});

test("the copy lands in the folder before any answer comes through Fo: the request closes by itself", async () => {
  const rig = makeRig({ watchIntervalSeconds: 3600 });
  const { item, content, root } = await quoteMissing(rig);
  const { versionId } = rig.app.requestCopy(item.copy!.documentId, { reference: "Q-1042", ...OAKLINE });
  const sent = await send(rig, versionId);
  assert.equal(sent.dispatches[0]?.watch?.state, "watching");

  rig.drive.addFile("Oakline Q-1042.pdf", root, "application/pdf", content);
  rig.app.refreshInventory();
  await rig.app.settle();
  const view = await rig.app.view();
  assert.equal(view.outreach.find((x) => x.kind === "request_copy")?.dispatches[0]?.watch?.state, "closed");
  assert.ok(view.activity.events.some((e) => e.kind === "copy_arrived"));
  const ws = (rig.app.ctx.db.prepare("SELECT id FROM workspaces WHERE active = 1").get() as { id: string }).id;
  assert.ok(!attentionItems(rig.app.ctx, ws, "2026-10-17").some((i) => i.kind === "missing"));
  rig.app.close();
});

test("a copy is only asked for what the document really mentions, and only while it's missing", async () => {
  const rig = makeRig({ watchIntervalSeconds: 3600 });
  await organized(rig);
  rig.app.updateSettings({ userName: "Anika" });
  const deposit = (await rig.app.view()).index.flatMap((p) => p.rows).find((r) => r.reference === "INV-3307")!;
  assert.throws(() => rig.app.requestCopy(deposit.docId, { reference: "Q-9999", ...OAKLINE }), { status: 400 });
  assert.throws(() => rig.app.requestCopy(deposit.docId, { reference: "Q-1042", ...OAKLINE }), { status: 409 }, "Q-1042 is in the folder");
  rig.app.close();
});
