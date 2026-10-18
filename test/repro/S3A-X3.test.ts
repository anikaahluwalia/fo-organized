import { test } from "node:test";
import assert from "node:assert/strict";
import { replyState } from "../../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3A-X3: when you ask Fo a question about the texted proposal inside Kiki, Fo's answer and its
// question back to you are replaced by your own words ("Fo needs clarification: <what you wrote>").
// Step 3's check: your answer (approve, decline, adjust, question) comes back linked to it.

test("asking Fo about the proposal inside Kiki shows Fo's answer, not your own words back", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const note = (await rig.app.view()).notifications.find((n) => n.purpose === "find");
  assert.ok(note, "Fo was asked to text you");
  const state = replyState(rig.app.ctx, note.taskId)!;

  const question = "what is N-5602?";
  const foAnswer = "N-5602 is Northside Building Supply's invoice for transition strips and levelling compound ($286.40). Should Kiki file it under Projects/Flooring/Invoices?";
  const clarification = "KIKI-DECISION: " + JSON.stringify({ requestId: state.requestId, planId: state.planId, contentHash: state.contentHash, decision: "clarification", userReply: question, actor: "account_holder", presentedExactProposal: true });
  fo.onAsk = async (args) => reply(args.conversationId!, "complete", { response: `${foAnswer}\n${clarification}` });
  await rig.app.reply(note.taskId, question);
  await rig.app.settle();

  const after = (await rig.app.view()).notifications.find((n) => n.taskId === note.taskId)!;
  assert.equal(after.state, "needs_user_input", "Fo is waiting for your answer");
  assert.match(after.question ?? "", /N-5602 is Northside Building Supply's invoice/, "Fo's answer to your question is shown");
  assert.doesNotMatch(after.question ?? "", /KIKI-DECISION/, "the protocol line isn't shown to you");
});
