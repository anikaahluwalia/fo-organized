import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTextReply } from "../../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3C-X7: once the proposal changes (you edit it in Kiki), Fo's pending question about the old
// version still reads as awaiting your answer. The view keeps reply.status "waiting" until the
// next text_reply job (up to 6 s later, notify.ts:134-137), and the web app shows any notification
// that isn't complete (App.tsx:363-367) with an answer box whenever the task is needs_user_input
// (App.tsx:615), with no label for "stale". Answering it gets a 409. It approves nothing; it's
// what the screen says that's wrong.

const CONV = "conv-kiki-proposal";

test("after you edit the proposal, Fo's question about the old version no longer asks for your answer", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  fo.onAsk = async () => reply(CONV, "working", { progress: "Waiting for your answer: should Kiki file the new Northside invoice in Projects/Flooring/Invoices?" });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const view = await rig.app.view();
  const plan = view.plans.find((p) => p.status === "proposed")!;
  const taskId = view.notifications.find((n) => n.purpose === "find")!.taskId;

  const move = plan.ops.find((o) => o.kind === "move_rename")!;
  rig.app.revisePlan(plan.id, [{ seq: move.seq, newName: "Northside levelling compound" }]);
  const right = (await rig.app.view()).notifications.find((n) => n.taskId === taskId)!;
  assert.equal(right.reply?.status, "stale", `right after the edit, the old request isn't shown as waiting for you (shown: ${right.reply?.status}, state ${right.state})`);

  // The next text_reply job does mark it stale; the web app still offers the answer box then,
  // because App.tsx:615 keys on the task state (needs_user_input), not on reply.status.
  await checkTextReply(rig.app.ctx, taskId);
  const later = (await rig.app.view()).notifications.find((n) => n.taskId === taskId)!;
  assert.deepEqual([later.reply?.status, later.state], ["stale", "needs_user_input"]);
  assert.throws(() => rig.app.reply(taskId, "Yes, go ahead."), { status: 409 });
});
