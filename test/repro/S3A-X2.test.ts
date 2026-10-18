import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalInstructions } from "../../server/domain/approval.ts";
import { checkTextReply, replyState } from "../../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3A-X2: the text tells you to approve by replying "go ahead", but a text reply starts a separate
// Fo conversation that Kiki doesn't read (by design until replies can be tied to their request:
// docs/ROADMAP.md, "for now the user answers Fo inside Kiki"). Doing what the text says files
// nothing, and the request just waits until it expires.

test("the text doesn't tell you to approve by replying to it, since a text reply can't approve anything yet", async (t) => {
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
  assert.ok(note?.text, "Fo was asked to text you");

  // You do what the text says: reply "go ahead" to it. The reply lands in your SMS thread with Fo.
  fo.conversations = [{ conversationId: "sms-thread", title: "Texts", channel: "sms", startedAt: new Date().toISOString() }];
  fo.transcripts.set("sms-thread", [
    { role: "assistant", text: note.text, at: new Date(Date.now() + 1).toISOString() },
    { role: "user", text: "go ahead", at: new Date(Date.now() + 2).toISOString() },
  ]);
  await checkTextReply(rig.app.ctx, note.taskId);
  assert.equal(replyState(rig.app.ctx, note.taskId)?.status, "waiting", "(by design) a text reply approves nothing");

  // So the text must not promise that it does, and neither may the setting or Kiki's request to Fo.
  assert.doesNotMatch(note.text, /Reply "go ahead"/, "the text says where to answer (in Kiki), not 'Reply \"go ahead\"'");
  const events = (await rig.app.view()).activity.events.map((e) => e.message);
  assert.equal(events.some((m) => /Reply "go ahead" to approve/.test(m)), false, "the setting doesn't promise text approvals");
  assert.doesNotMatch(approvalInstructions({ requestId: "r", planId: "p", contentHash: "h" }), /If a text reply arrives in a different conversation, relay it/, "Fo isn't invited to relay text replies yet");
});
