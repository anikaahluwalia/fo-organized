import { test } from "node:test";
import assert from "node:assert/strict";
import type { FoTurn } from "../../server/fo/types.ts";
import { checkWatch } from "../../server/services/watch.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3C-X1: with "Text me when Kiki finds something new" on, a proposal Kiki prepares from a Fo
// conversation she follows (the contractor's answer: "use the revised quote") is never brought to
// you through Fo. Only organizing proposals from the read job are (app.ts:72-73). ROADMAP.md's
// flowchart routes "an update in a Fo conversation Kiki is following" to the same proposal -> Fo path.

const CONV = "conv-dana";
const SENT = "I emailed Dana the approved message exactly as written.\nKIKI-STATUS: SENT";
const TEXTED = "Texted you.\nKIKI-STATUS: SENT";
const DANA = { contractorName: "Dana", contractorEmail: "dana@oakline.example", consent: true };

let tick = 0;
const fromFo = (text: string): FoTurn => ({ role: "assistant", text, at: new Date(Date.now() + 1000 + tick++).toISOString() });
const fromUser = (text: string): FoTurn => ({ role: "user", text, at: new Date(Date.now() + 1000 + tick++).toISOString() });

test("a version update Kiki prepares from the contractor's answer is brought to you through Fo, bound to that version", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ userName: "Anika", autoText: true });

  // Dana is asked about Q-1042 and Fo reports the email sent; Kiki follows that conversation.
  const quote = (await rig.app.view()).index.flatMap((p) => p.rows).find((r) => r.reference === "Q-1042")!;
  const { versionId } = rig.app.createOutreachDraft(quote.docId, DANA);
  const draft = (await rig.app.view()).outreach.find((o) => o.documentId === quote.docId)!.draft!;
  fo.onAsk = async (args, n) => (args.message.startsWith("Please text me") ? reply(`kiki-${n}`, "complete", { response: TEXTED }) : reply(CONV, "complete", { response: SENT }));
  rig.app.approveAndSend(versionId, { contentHash: draft.contentHash, clientRequestId: "send-1" });
  await rig.app.settle();
  const watchId = (await rig.app.view()).outreach[0]!.dispatches[0]!.watch!.id;
  fo.transcripts.set(CONV, [fromUser(fo.asks[0]!.message), fromFo(SENT)]);

  // The revised quote lands, then Dana's answer comes back through Fo.
  await rig.app.stageRevision("single");
  await rig.app.settle();
  fo.transcripts.set(CONV, [...fo.transcripts.get(CONV)!, fromFo('Dana replied: "No, use the revised quote I emailed today."')]);
  await checkWatch(rig.app.ctx, watchId);
  await rig.app.settle();

  const plan = (await rig.app.view()).plans.find((p) => p.kind === "version_update" && p.status === "proposed");
  assert.ok(plan, "Kiki proposed the version update");
  const handoffs = fo.asks.filter((a) => !a.conversationId && a.message.includes("Kiki approval handoff")).map((a) => JSON.parse(/^\{"requestId".*\}$/m.exec(a.message)![0]) as { planId: string; contentHash: string });
  const about = handoffs.map((b) => rig.db.prepare("SELECT kind, title, status FROM plans WHERE id = ?").get(b.planId));
  assert.ok(
    handoffs.some((b) => b.planId === plan.id && b.contentHash === plan.contentHash),
    `Fo was asked to bring the version update to you; it was only asked about ${JSON.stringify(about)}`,
  );
});
