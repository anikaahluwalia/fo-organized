// Answering Fo by text: the reply lands in a separate Fo conversation, Kiki notices it, has Fo read
// it in her own conversation, and the decision is bound to the exact proposal as usual.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one, run } from "../server/db.ts";
import { replyState } from "../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply } from "./helpers.ts";

const TEXTED = "Texted you.\nKIKI-STATUS: SENT";

async function texted(t: TestContext) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: TEXTED });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const view = await rig.app.view();
  const note = view.notifications.find((n) => n.purpose === "find")!;
  const plan = view.plans.find((p) => p.status === "proposed")!;
  return { rig, fo, note, plan, state: replyState(rig.app.ctx, note.taskId)! };
}

/** You text Fo: a new text conversation appears. Fo, asked by Kiki, reports `words` with `decision`. */
async function youText(s: Awaited<ReturnType<typeof texted>>, words: string, decision = "approved", startedAt = new Date(Date.now() + 1000).toISOString()) {
  s.fo.conversations = [{ conversationId: "sms-1", title: words, channel: "sms", startedAt }];
  s.fo.onAsk = async (args) =>
    args.conversationId === "kiki-1" && args.message.includes("answered this by text")
      ? reply("kiki-1", "complete", { response: "KIKI-DECISION: " + JSON.stringify({ requestId: s.state.requestId, planId: s.state.planId, contentHash: s.state.contentHash, decision, userReply: words, actor: "account_holder", presentedExactProposal: true }) })
      : reply("kiki-other", "complete", { response: TEXTED });
  // The watcher looks every 20 s; make it due now.
  for (let i = 0; i < 3; i++) {
    run(s.rig.db, "UPDATE jobs SET run_after = ? WHERE state = 'queued'", new Date(0).toISOString());
    await s.rig.app.settle();
  }
}

const status = (s: Awaited<ReturnType<typeof texted>>, id: string) => one<{ status: string }>(s.rig.db, "SELECT status FROM plans WHERE id = ?", id)?.status;

test("a plain yes you text Fo approves exactly the proposal Fo texted you", async (t) => {
  const s = await texted(t);
  await youText(s, "go ahead");
  assert.ok(s.fo.asks.some((a) => a.conversationId === "kiki-1" && a.message.includes("answered this by text")), "Kiki asked Fo, in her conversation, to read your text");
  assert.equal(replyState(s.rig.app.ctx, s.note.taskId)?.status, "approved");
  assert.equal(status(s, s.plan.id), "applied");
});

test("a text that isn't a plain yes approves nothing, even if Fo calls it approved", async (t) => {
  const s = await texted(t);
  await youText(s, "maybe later");
  assert.equal(status(s, s.plan.id), "proposed");
});

test("a change you text Fo makes a new version, which needs its own decision", async (t) => {
  const s = await texted(t);
  await youText(s, "Put the Northside invoice under Kitchen instead", "changes_requested");
  assert.equal(status(s, s.plan.id), "superseded");
  const next = (await s.rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(next?.ops.some((o) => o.after?.path.startsWith("Projects/Kitchen/")), "the new version files it under Kitchen");
  const texts = s.fo.asks.filter((a) => a.message.startsWith("Please text me"));
  assert.match(texts.at(-1)!.message, new RegExp(`here's version ${next!.version}`), "and it comes back to you as a text");
});

test("a text from before Kiki's question isn't taken as an answer", async (t) => {
  const s = await texted(t);
  await youText(s, "go ahead", "approved", new Date(Date.now() - 3600_000).toISOString());
  assert.equal(s.fo.asks.some((a) => a.message.includes("answered this by text")), false);
  assert.equal(status(s, s.plan.id), "proposed");
});
