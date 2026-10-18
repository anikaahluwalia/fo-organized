// Filing a kind of document on her own: Kiki offers once she's filed it twice with your yes; only
// your plain yes (through Fo, bound to that offer) or your switch in the app turns it on; then a new
// one of that kind, alone in its proposal, is filed without asking and you're texted after.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { all, one } from "../server/db.ts";
import { replyState } from "../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply, type TestRig } from "./helpers.ts";

const TEXTED = "Texted you.\nKIKI-STATUS: SENT";
const timesheet = (title: string) => `NOTES\nTitle: ${title}\nHours: 12`;

async function setup(t: TestContext) {
  const fo = new FakeFo();
  const r = makeRig({ fo });
  r.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => r.app.close());
  // Fo texts what it's asked to; your answer in Kiki gets the decision this test sets.
  let decide: ((taskId: string) => string) | null = null;
  fo.onAsk = async (args, n) => {
    if (args.conversationId && args.message.startsWith("Answer from the account holder") && decide) {
      const task = all<{ id: string }>(r.db, "SELECT id FROM fo_tasks WHERE conversation_id = ?", args.conversationId)[0]!;
      return reply(args.conversationId, "complete", { response: decide(task.id) });
    }
    return reply(args.conversationId ?? `kiki-${n}`, "complete", { response: TEXTED });
  };
  await organized(r);
  r.app.updateSettings({ autoText: true });
  const root = one<{ root_file_id: string }>(r.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  const drop = async (name: string) => {
    const id = r.drive.addFile(name, root, "text/plain", timesheet(name.replace(/\.txt$/, "")));
    r.app.refreshInventory();
    await r.app.settle();
    return id;
  };
  const approveOpen = async () => {
    const plan = (await r.app.view()).plans.find((p) => p.status === "proposed")!;
    r.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `ok-${plan.id}` });
    await r.app.settle();
  };
  const answer = (decision: string, words: string) => {
    decide = (taskId) => {
      const s = replyState(r.app.ctx, taskId)!;
      return "KIKI-DECISION: " + JSON.stringify({ requestId: s.requestId, planId: s.planId, contentHash: s.contentHash, decision, userReply: words, actor: "account_holder", presentedExactProposal: true });
    };
  };
  return { r, fo, drop, approveOpen, answer };
}

/** You put the first timesheet in Work, then said yes to Kiki filing the second there: she offers. */
async function twice(s: Awaited<ReturnType<typeof setup>>) {
  const first = await s.drop("Timesheet Aug 23-29.txt");
  const question = (await s.r.app.view()).plans.find((p) => p.status === "proposed")!;
  s.r.app.placeFile(question.id, first, "Work");
  await s.r.app.settle();
  await s.approveOpen();
  await s.drop("Timesheet Aug 30-Sep 5.txt");
  await s.approveOpen();
  return (await s.r.app.view()).notifications.find((n) => n.purpose === "offer");
}

const lesson = async (r: TestRig) => (await r.app.view()).lessons.find((l) => l.kind === "place")!;

test("after two filings you said yes to, Kiki offers once to file them on her own", async (t) => {
  const s = await setup(t);
  const offer = await twice(s);
  assert.ok(offer, "an offer was texted");
  assert.match(offer.text ?? "", /^Kiki: you've filed 2 timesheet documents in Work › Notes\. Want me to file new ones there on my own from now on\?/);
  const sent = s.fo.asks.find((a) => a.message.includes("on my own from now on"))!.message;
  assert.match(sent, /a standing permission I can stop in the app\)\. Only a plain yes turns it on\./);
  assert.match(sent, /KIKI-DECISION/, "bound like a proposal");
  assert.equal((await lesson(s.r)).offered, true);
  assert.equal((await lesson(s.r)).auto, false, "nothing on until you say yes");
});

test("your plain yes turns it on: the next timesheet is filed without asking, and you're texted after", async (t) => {
  const s = await setup(t);
  const offer = (await twice(s))!;
  s.answer("approved", "Yes");
  await s.r.app.reply(offer.taskId, "Yes");
  await s.r.app.settle();
  assert.equal((await lesson(s.r)).auto, true);

  const asksBefore = s.fo.asks.length;
  const third = await s.drop("Timesheet Sep 6-12.txt");
  assert.match(s.r.drive.pathOf(third), /\/Projects\/Work\/Notes\//, "filed");
  const applied = (await s.r.app.view()).plans.find((p) => p.ops.some((o) => o.before?.name === "Timesheet Sep 6-12.txt"))!;
  assert.equal(applied.status, "applied");
  const after = s.fo.asks.slice(asksBefore);
  assert.equal(after.length, 1, "one text, after");
  assert.match(after[0]!.message, /Kiki: I filed "Timesheet Sep 6-12" in Work › Notes on my own, as you allowed\./);
  assert.ok(one(s.r.db, "SELECT id FROM plan_approvals WHERE client_request_id = ?", `standing-${applied.id}`), "approved on your standing OK, and recorded as such");
});

test("anything but a plain yes leaves it off", async (t) => {
  const s = await setup(t);
  const offer = (await twice(s))!;
  s.answer("approved", "maybe later");
  await s.r.app.reply(offer.taskId, "maybe later");
  await s.r.app.settle();
  assert.equal((await lesson(s.r)).auto, false);
  const third = await s.drop("Timesheet Sep 6-12.txt");
  assert.doesNotMatch(s.r.drive.pathOf(third), /Projects/, "asked, not filed");
});

test("with it on, a proposal with anything else in it still waits for you", async (t) => {
  const s = await setup(t);
  await twice(s);
  s.r.app.setFilesAlone((await lesson(s.r)).id, true);
  const root = one<{ root_file_id: string }>(s.r.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  s.r.drive.addFile("garden.txt", root, "text/plain", "NOTES\nTitle: Garden ideas\nPlant tomatoes.");
  const third = await s.drop("Timesheet Sep 6-12.txt");
  assert.doesNotMatch(s.r.drive.pathOf(third), /Projects/, "the timesheet waits with the question about the other file");
});

test("\"Ask me first\" in the app turns it off again", async (t) => {
  const s = await setup(t);
  await twice(s);
  const id = (await lesson(s.r)).id;
  s.r.app.setFilesAlone(id, true);
  s.r.app.setFilesAlone(id, false);
  const third = await s.drop("Timesheet Sep 6-12.txt");
  assert.doesNotMatch(s.r.drive.pathOf(third), /Projects/);
  assert.ok((await s.r.app.view()).plans.some((p) => p.status === "proposed" && p.ops.some((o) => o.before?.name === "Timesheet Sep 6-12.txt")), "proposed instead");
});
