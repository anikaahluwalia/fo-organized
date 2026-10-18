import { test } from "node:test";
import assert from "node:assert/strict";
import type { FoReply, FoTurn } from "../../server/fo/types.ts";
import { FakeFo, makeRig, organized, reply, sleep, tempDbPath } from "../helpers.ts";

// S3C-X9: if Kiki restarts while your answer is with Fo, the request becomes "uncertain"
// (engine.ts:231-236) and stays that way: there's no reconcile for a request to Fo about a
// proposal (only dispatches have one, outreach.ts:330), replyToTask then refuses any answer
// (engine.ts:112 needs needs_user_input), and both UIs say "Not sure the text went out."
// (App.tsx:602-603, extension/lib.js:135-137) although Fo texted you before you answered. If Fo's
// reply to your answer was a question, you can't answer it inside Kiki any more.

const CONV = "conv-kiki-proposal";

test("after a restart mid-answer, Fo's next question about the proposal can still be answered inside Kiki", async (t) => {
  const db = tempDbPath();
  const fo = new FakeFo();
  const rig = makeRig({ fo, db });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  fo.onAsk = async (args) => (args.conversationId ? new Promise<FoReply>(() => undefined) : reply(CONV, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" }));
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const taskId = (await rig.app.view()).notifications.find((n) => n.purpose === "find")!.taskId;
  await rig.app.reply(taskId, "What's in the invoice?");
  for (let i = 0; i < 200 && fo.asks.length < 2; i++) await sleep(2);
  rig.app.close(); // Kiki stops while Fo works on your answer

  // Fo answered your question and asked again, in the same conversation.
  const after = new FakeFo();
  const question: FoTurn = { role: "assistant", text: "Transition strips and levelling compound, $286.40. Should Kiki file it?", at: new Date(Date.now() + 1000).toISOString() };
  after.transcripts.set(CONV, [question]);
  after.onPoll = async () => reply(CONV, "complete", { response: question.text });
  after.onAsk = async (args) => reply(CONV, "complete", { response: "Noted.\nKIKI-STATUS: NEED-INPUT" });
  const restarted = makeRig({ db, drive: rig.drive, fo: after });
  restarted.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => restarted.app.close());
  restarted.app.recover();
  await restarted.app.settle();

  const n = (await restarted.app.view()).notifications.find((x) => x.taskId === taskId)!;
  let refused: unknown = null;
  try {
    restarted.app.reply(taskId, "Yes, go ahead.");
  } catch (err) {
    refused = err;
  }
  await restarted.app.settle();
  assert.equal(refused, null, `your answer is taken (request state after restart: ${n.state}; refused: ${(refused as Error | null)?.message})`);
  assert.equal(after.asks.filter((a) => a.conversationId === CONV).length, 1, "and goes to Fo's conversation");
});
