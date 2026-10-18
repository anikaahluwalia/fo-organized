import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3C-X8: when Fo's reply carries a KIKI-DECISION line Kiki can't accept (unbound, malformed, or
// with a field the schema doesn't allow), the whole reply, protocol line and all, becomes "Fo's
// question" (notify.ts:219-227: no report, no status line -> question = response), so the screen
// shows the raw JSON with the request id, plan id and content hash. It approves nothing.

const CONV = "conv-kiki-proposal";

test("a decision line Kiki can't accept isn't shown to you as Fo's question", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  fo.onAsk = async (args) => {
    const b = /^\{"requestId".*\}$/m.exec(args.message)?.[0];
    if (!args.conversationId) return reply(CONV, "working", { progress: "Waiting for your answer: should Kiki file the new Northside invoice?" });
    const report = JSON.stringify({ ...JSON.parse(b!), decision: "approved", userReply: "Yes", actor: "account_holder", presentedExactProposal: true, note: "all good" });
    return reply(CONV, "complete", { response: `Passing it on.\nKIKI-DECISION: ${report}` });
  };
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const taskId = (await rig.app.view()).notifications.find((n) => n.purpose === "find")!.taskId;
  await rig.app.reply(taskId, "Yes");
  await rig.app.settle();

  const n = (await rig.app.view()).notifications.find((x) => x.taskId === taskId)!;
  assert.equal(n.reply?.status, "waiting", "nothing was approved");
  assert.doesNotMatch(n.question ?? "", /KIKI-DECISION|requestId|contentHash/, `the protocol line isn't shown as Fo's question (shown: ${JSON.stringify(n.question)})`);
});
