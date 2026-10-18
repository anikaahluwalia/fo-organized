import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { all, kvGet, kvSet } from "../../server/db.ts";
import type { FoReply } from "../../server/fo/types.ts";
import { checkTextReply } from "../../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply, sleep } from "../helpers.ts";

// S3C-X6: the 30-minute window on a request to Fo. (1) After it, your answer typed in Kiki is
// refused with "That approval request expired. Refresh the proposal first." (outreach.ts:299), but
// nothing brings the same proposal to Fo again: autoNotifyProposal runs only for a newly created
// plan and is deduped by plan id and content hash (app.ts:73, notify.ts:313), and no route or
// button re-asks Fo. (2) An answer you gave inside the window whose report Fo posts after it is
// dropped as "expired" (notify.ts:139-142 measures from the request, not from your answer).

const CONV = "conv-kiki-proposal";
const WINDOW_MS = 30 * 60_000;

async function asked(t: TestContext) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  let onAnswer: (b: Record<string, string>) => FoReply = () => reply(CONV, "complete", { response: "Noted.\nKIKI-STATUS: NEED-INPUT" });
  fo.onAsk = async (args, n) => {
    const b = /^\{"requestId".*\}$/m.exec(args.message)?.[0];
    if (args.conversationId && b) return onAnswer(JSON.parse(b) as Record<string, string>);
    if (b) return reply(n === 1 ? CONV : `${CONV}-${n}`, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" });
    return reply(`conv-done-${n}`, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" });
  };
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const view = await rig.app.view();
  const plan = view.plans.find((p) => p.status === "proposed")!;
  const taskId = view.notifications.find((n) => n.purpose === "find")!.taskId;
  /** As if the request to Fo was made `ms` ago. */
  const requestedAgo = (ms: number) => {
    const state = JSON.parse(kvGet(rig.db, `notify.reply.${taskId}`)!) as Record<string, unknown>;
    kvSet(rig.db, `notify.reply.${taskId}`, JSON.stringify({ ...state, requestedAt: new Date(Date.now() - ms).toISOString() }));
  };
  return {
    ...rig,
    fo,
    plan,
    taskId,
    requestedAgo,
    onAnswer(fn: (b: Record<string, string>) => FoReply) {
      onAnswer = fn;
    },
  };
}

const handoffsFor = (fo: FakeFo, planId: string) => fo.asks.filter((a) => a.message.includes(`"planId":"${planId}"`) && !a.conversationId).length;

test("after the request expires, refreshing brings the same proposal to Fo again, so an answer inside Kiki can count", async (t) => {
  const s = await asked(t);
  s.requestedAgo(WINDOW_MS + 60_000);
  assert.throws(() => s.app.reply(s.taskId, "Yes, go ahead."), { status: 409, message: /expired\. Refresh the proposal first/ });

  // What you can do in the app: "Have Fo ask me" on the proposal, which brings it to Fo again.
  await checkTextReply(s.app.ctx, s.taskId);
  s.app.askThroughFo(s.plan.id);
  await s.app.settle();
  const open = (await s.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(open, "the proposal is still open");
  assert.ok(handoffsFor(s.fo, open.id) >= (open.id === s.plan.id ? 2 : 1), `Fo was asked again, with a fresh binding (requests for it: ${handoffsFor(s.fo, open.id)})`);
});

test("an answer you gave inside the window still counts when Fo's report lands after it", async (t) => {
  const s = await asked(t);
  s.requestedAgo(WINDOW_MS - 60_000); // you answer with a minute to spare
  s.onAnswer(() => reply(CONV, "working", { progress: "Passing your answer to Kiki…" }));
  let finish!: (r: FoReply) => void;
  const report = new Promise<FoReply>((resolve) => {
    finish = resolve;
  });
  s.fo.onPoll = () => report;
  s.app.reply(s.taskId, "Yes, go ahead.");
  for (let i = 0; i < 500 && s.fo.polls.length === 0; i++) await sleep(2);
  assert.ok(s.fo.polls.length > 0, "Fo is working on your answer");
  // Fo takes two minutes; its report arrives after the window.
  s.requestedAgo(WINDOW_MS + 60_000);
  const b = /^\{"requestId".*\}$/m.exec(s.fo.asks.at(-1)!.message)![0];
  finish(reply(CONV, "complete", { response: `Done.\nKIKI-DECISION: ${JSON.stringify({ ...JSON.parse(b), decision: "approved", userReply: "Yes, go ahead.", actor: "account_holder", presentedExactProposal: true })}` }));
  await s.app.settle();
  await checkTextReply(s.app.ctx, s.taskId);
  await s.app.settle();
  const n = (await s.app.view()).notifications.find((x) => x.taskId === s.taskId);
  assert.deepEqual(
    all<{ plan_id: string }>(s.db, "SELECT plan_id FROM plan_approvals WHERE client_request_id NOT LIKE 'setup-%'").map((r) => r.plan_id),
    [s.plan.id],
    `your in-time answer approved the plan (Kiki recorded: ${JSON.stringify(n?.reply)})`,
  );
});
