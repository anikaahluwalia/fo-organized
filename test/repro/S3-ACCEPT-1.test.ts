import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AppView } from "../../shared/api.ts";
import { loadConfig } from "../../server/config.ts";
import { all } from "../../server/db.ts";
import { makePdf } from "../../server/demo/pdf.ts";
import type { FoReply, FoTurn } from "../../server/fo/types.ts";
import { createHttpServer } from "../../server/http.ts";
import { checkTextReply } from "../../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply, sleep, tempDbPath } from "../helpers.ts";

// S3-ACCEPT, the parts that hold today. Step 3 is accepted when "Fo explains the exact proposal;
// your answer inside Kiki (approve, decline, adjust, question) comes back linked to it; anything
// unbound, stale or ambiguous approves nothing." Fo is scripted (FakeFo) the way Kiki's request
// asks a live Fo to behave; Drive is FakeDrive. The gaps are in S3-ACCEPT-2.test.ts.

const CONV = "conv-kiki-proposal";
const ROOT = "Renovation paperwork";
const INVOICE_NAME = "Northside invoice Oct 17.pdf";
const INVOICE_FILED = "2026-10-17 Invoice - Northside Building Supply - N-5602.pdf";
const INVOICES = "Projects/Flooring/Invoices";
const FO_ASKS = "Waiting for your answer: Kiki would file the new Northside invoice in Projects/Flooring/Invoices and update the Flooring index. Should she go ahead?";
const TEXTED = "Texted you Kiki's message.\nKIKI-STATUS: SENT";

type Binding = { requestId: string; planId: string; contentHash: string };
type Decision = "approved" | "declined" | "clarification";
type FoAnswer = (answer: string, b: Binding, n: number) => FoReply | Promise<FoReply>;

let tick = 0;
const stamp = () => new Date(Date.now() + 1000 + tick++).toISOString();
const fromFo = (text: string, at = stamp()): FoTurn => ({ role: "assistant", text, at });

function bindingIn(message: string): Binding {
  const m = /^Kiki approval handoff[^\n]*\n(\{[^\n]*\})$/m.exec(message);
  assert.ok(m, "the request to Fo carries the approval binding");
  return JSON.parse(m[1]!) as Binding;
}

function answerIn(message: string): string {
  const m = /^Answer from the account holder \(data\): (".*")$/m.exec(message);
  assert.ok(m, "Kiki relays your answer to Fo as data");
  return JSON.parse(m[1]!) as string;
}

/** The report Kiki's request asks Fo to post once you have answered. */
const decisionLine = (b: Binding, decision: Decision, userReply: string, extra: Record<string, unknown> = {}) =>
  "KIKI-DECISION: " + JSON.stringify({ ...b, decision, userReply, actor: "account_holder", presentedExactProposal: true, ...extra });

/**
 * The paperwork is organized and texts are on. A new invoice lands: Kiki proposes filing it and
 * asks Fo to bring the proposal to you. Fo's first reply is `first` (by default Fo puts it to you
 * and waits for your answer). Your answers typed in Kiki reach Fo on its conversation; `onAnswer`
 * scripts what Fo says back.
 */
async function broughtToYou(t: TestContext, opts: { first?: (n: number) => FoReply; db?: string } = {}) {
  const fo = new FakeFo();
  const rig = makeRig({ fo, db: opts.db });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  const answers: string[] = [];
  let onAnswer: FoAnswer = () => reply(CONV, "complete", { response: "Noted.\nKIKI-STATUS: NEED-INPUT" });
  let handoffs = 0;
  let others = 0;
  fo.onAsk = async (args) => {
    if (args.conversationId) {
      const answer = answerIn(args.message);
      answers.push(answer);
      return onAnswer(answer, bindingIn(args.message), answers.length);
    }
    if (args.message.includes("Kiki approval handoff")) {
      handoffs++;
      return opts.first?.(handoffs) ?? reply(handoffs === 1 ? CONV : `${CONV}-${handoffs}`, "working", { progress: FO_ASKS });
    }
    others++;
    return reply(`conv-done-${others}`, "complete", { response: TEXTED });
  };
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const view = await rig.app.view();
  const plan = view.plans.find((p) => p.status === "proposed");
  assert.ok(plan, "Kiki proposed filing the new invoice");
  const note = view.notifications.find((n) => n.purpose === "find");
  assert.ok(note, "and asked Fo to bring it to you");
  const request = fo.asks.find((a) => a.message.includes("Kiki approval handoff"))!.message;
  const invoiceId = [...rig.drive.files.values()].find((f) => f.name === INVOICE_NAME)!.id;
  return {
    ...rig,
    fo,
    plan,
    invoiceId,
    taskId: note.taskId,
    request,
    binding: bindingIn(request),
    answers,
    onAnswer(fn: FoAnswer) {
      onAnswer = fn;
    },
    /** You type an answer in Kiki's "Answer Fo about this proposal" box. */
    async answer(text: string) {
      await rig.app.reply(note.taskId, text);
      await rig.app.settle();
    },
  };
}
type Brought = Awaited<ReturnType<typeof broughtToYou>>;

const approvalsSinceSetup = (s: Brought) =>
  all<{ plan_id: string; content_hash: string }>(s.db, "SELECT plan_id, content_hash FROM plan_approvals WHERE client_request_id NOT LIKE 'setup-%' ORDER BY approved_at");

async function note(s: Brought, taskId = s.taskId) {
  const n = (await s.app.view()).notifications.find((x) => x.taskId === taskId);
  assert.ok(n, "Kiki shows the request to Fo");
  return n;
}

async function planStatus(s: Brought, planId: string) {
  return (await s.app.view()).plans.find((p) => p.id === planId)?.status;
}

const MUTATING = new Set(["createFolder", "update", "createFile", "updateContent"]);
const driveChanges = (s: Brought) => s.drive.calls.filter((c) => MUTATING.has(c.op)).length;

/** Nothing was approved or changed: the proposal is still open and the invoice is where it landed. */
async function approvedNothing(s: Brought, changesBefore: number, planId = s.plan.id) {
  assert.deepEqual(approvalsSinceSetup(s), [], "no approval was recorded");
  assert.equal(await planStatus(s, planId), "proposed");
  assert.equal(s.drive.pathOf(s.invoiceId), `${ROOT}/${INVOICE_NAME}`);
  assert.equal(driveChanges(s), changesBefore, "and nothing changed in Drive");
}

/** Fo takes your "yes" and reports it, bound to the request it was asked about. */
const approves: FoAnswer = (answer, b) => reply(CONV, "complete", { response: `Thanks, I'll let Kiki know.\n${decisionLine(b, "approved", answer)}` });

// 1. Fo is handed the exact proposal --------------------------------------------------------

describe("Fo explains the exact proposal", () => {
  test("Kiki hands Fo every step of the proposal, its version, and a binding to that exact version", async (t) => {
    const s = await broughtToYou(t);
    assert.deepEqual({ planId: s.binding.planId, contentHash: s.binding.contentHash }, { planId: s.plan.id, contentHash: s.plan.contentHash });
    assert.match(s.binding.requestId, /^[0-9a-f-]{36}$/);
    assert.ok(s.request.includes(`The exact proposal this text is about (version ${s.plan.version})`));
    const steps = s.plan.ops.filter((o) => o.state !== "excluded");
    assert.deepEqual(
      steps.map((o) => o.kind),
      ["move_rename", "write_index"],
    );
    for (const op of steps) {
      const line =
        op.kind === "move_rename"
          ? `${op.seq}. Move "${op.before!.name}" from "${op.before!.path || "workspace folder"}" to "${op.after!.path}/${op.after!.name}".`
          : `- Update index "${op.after!.path}/${op.after!.name}".`;
      assert.ok(s.request.includes(line), `the request lists "${line}"`);
    }
    assert.match(s.request, /^Explain the exact proposed changes above to the account holder before asking for a decision\.$/m);
    assert.match(s.request, /^Only an unconditional decision about this entire proposal counts as approval\./m);
    assert.match(s.request, /that is changes_requested, even when they also say yes/);
    assert.equal(s.drive.pathOf(s.invoiceId), `${ROOT}/${INVOICE_NAME}`, "nothing changed in Drive");
  });

  test("the first organizing proposal (folders, five files, the index) reaches Fo step by step", async (t) => {
    const fo = new FakeFo();
    const rig = makeRig({ fo });
    rig.app.ctx.watchIntervalSeconds = 3600;
    t.after(() => rig.app.close());
    fo.onAsk = async () => reply(CONV, "complete", { response: TEXTED });
    rig.app.updateSettings({ autoText: true });
    await rig.app.createDemoWorkspace();
    await rig.app.settle();
    const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
    assert.ok(plan);
    assert.equal(fo.asks.length, 1);
    const request = fo.asks[0]!.message;
    assert.deepEqual(bindingIn(request).planId, plan.id);
    for (const op of plan.ops) {
      const line =
        op.kind === "create_folder"
          ? `- Create folder "${op.after!.path ? `${op.after!.path}/` : ""}${op.after!.name}".`
          : op.kind === "move_rename"
            ? `${op.seq}. Move "${op.before!.name}" from "${op.before!.path || "workspace folder"}" to "${op.after!.path}/${op.after!.name}".`
            : `- Update index "${op.after!.path}/${op.after!.name}".`;
      assert.ok(request.includes(line), `the request lists "${line}"`);
    }
  });
});

// 2. Answering Fo inside Kiki ---------------------------------------------------------------

describe("your answer inside Kiki goes to Fo's conversation", () => {
  test("while Fo waits for you, Kiki shows Fo's question, and your answer goes back with ask_fo on the same conversation, as data, with the same binding", async (t) => {
    const s = await broughtToYou(t);
    const n = await note(s);
    assert.equal(n.planId, s.plan.id);
    assert.equal(n.state, "needs_user_input");
    assert.equal(n.question, FO_ASKS);
    assert.equal(n.reply?.status, "waiting");
    assert.equal(s.fo.polls.length, 0, "Kiki didn't poll a turn that's waiting for you");

    await s.answer("Yes, go ahead.");
    assert.equal(s.fo.asks.length, 2);
    const relayed = s.fo.asks[1]!;
    assert.equal(relayed.conversationId, CONV);
    assert.equal(relayed.newConversation, undefined);
    assert.equal(answerIn(relayed.message), "Yes, go ahead.");
    assert.deepEqual(bindingIn(relayed.message), s.binding);
  });

  test("after Fo reports it texted you, you can still answer inside Kiki, on the same conversation", async (t) => {
    const s = await broughtToYou(t, { first: () => reply(CONV, "complete", { response: TEXTED }) });
    const n = await note(s);
    assert.deepEqual([n.state, n.outcome, n.reply?.status], ["complete", "reported_sent", "waiting"], "the web app offers the answer box for this state (App.tsx:615)");
    s.onAnswer(approves);
    await s.answer("Go ahead.");
    assert.equal(s.fo.asks[1]?.conversationId, CONV);
    assert.equal(await planStatus(s, s.plan.id), "applied");
  });

  test("a double-submitted answer reaches Fo once", async (t) => {
    const s = await broughtToYou(t);
    let finish!: (r: FoReply) => void;
    s.onAnswer(() => new Promise<FoReply>((resolve) => (finish = resolve)));
    s.app.reply(s.taskId, "Yes, go ahead.");
    assert.throws(() => s.app.reply(s.taskId, "Yes, go ahead."), { status: 409 });
    for (let i = 0; i < 200 && !finish; i++) await sleep(2);
    finish(approves("Yes, go ahead.", s.binding, 1) as FoReply);
    await s.app.settle();
    assert.equal(s.answers.length, 1);
    assert.equal(approvalsSinceSetup(s).length, 1);
  });

  test("through the web API: GET /api/state shows Fo's question; POST /api/tasks/:id/reply sends the answer", async (t) => {
    const s = await broughtToYou(t);
    s.onAnswer(approves);
    const { port, appOrigin } = await listen(t, s);
    const state = await call(port, { path: "/api/state" });
    assert.equal(state.status, 200);
    const shown = (state.json as unknown as AppView).notifications.find((x) => x.taskId === s.taskId);
    assert.equal(shown?.question, FO_ASKS);
    const posted = await call(port, { method: "POST", path: `/api/tasks/${s.taskId}/reply`, headers: { origin: appOrigin, "content-type": "application/json" }, body: JSON.stringify({ answer: "Yes, go ahead." }) });
    assert.equal(posted.status, 200);
    await s.app.settle();
    assert.equal(s.fo.asks.at(-2)?.conversationId, CONV, "the answer went to Fo's conversation");
    assert.equal(await planStatus(s, s.plan.id), "applied");
  });
});

// 3. Approve, decline, question, ambiguous --------------------------------------------------

describe("each kind of answer", () => {
  test("approve: Fo relays your yes as a bound decision; exactly that version is applied and verified in Drive, once", async (t) => {
    const s = await broughtToYou(t);
    s.onAnswer(approves);
    await s.answer("Yes, go ahead.");

    const view = await s.app.view();
    const plan = view.plans.find((p) => p.id === s.plan.id)!;
    assert.equal(plan.status, "applied");
    assert.ok(plan.ops.every((o) => o.state === "verified"));
    assert.equal(s.drive.pathOf(s.invoiceId), `${ROOT}/${INVOICES}/${INVOICE_FILED}`);
    assert.deepEqual(
      approvalsSinceSetup(s).map((a) => [a.plan_id, a.content_hash]),
      [[s.plan.id, s.plan.contentHash]],
    );
    assert.deepEqual((await note(s)).reply, { status: "approved", text: "Yes, go ahead.", source: "relayed_by_fo" });

    // Replays: Fo repeats the report in the conversation, and Kiki looks again. Still one run.
    const moves = s.drive.calls.filter((c) => c.op === "update" && c.id === s.invoiceId).length;
    s.fo.transcripts.set(CONV, [fromFo(decisionLine(s.binding, "approved", "Yes, go ahead."))]);
    await checkTextReply(s.app.ctx, s.taskId);
    await s.app.settle();
    assert.equal(approvalsSinceSetup(s).length, 1);
    assert.equal(s.drive.calls.filter((c) => c.op === "update" && c.id === s.invoiceId).length, moves);
  });

  test("approve, when Fo works on it first: Kiki polls the same conversation and acts on the report", async (t) => {
    const s = await broughtToYou(t);
    s.onAnswer(() => reply(CONV, "working", { progress: "Passing your answer to Kiki…" }));
    s.fo.onPoll = async (args) => reply(args.conversationId, "complete", { response: `Done.\n${decisionLine(s.binding, "approved", "Yes, go ahead.")}` });
    await s.answer("Yes, go ahead.");
    assert.ok(s.fo.polls.length >= 1 && s.fo.polls.every((p) => p.conversationId === CONV));
    assert.equal(await planStatus(s, s.plan.id), "applied");
  });

  test("decline: nothing is approved or changed, and a later report for the same request changes nothing", async (t) => {
    const s = await broughtToYou(t);
    const before = driveChanges(s);
    s.onAnswer((answer, b) => reply(CONV, "complete", { response: `Okay, I'll tell Kiki to leave it.\n${decisionLine(b, "declined", answer)}` }));
    await s.answer("No, leave it where it is.");
    assert.deepEqual((await note(s)).reply, { status: "declined", text: "No, leave it where it is.", source: "relayed_by_fo" });
    // By design the proposal stays open in the app (fo-loop.test.ts:961, "once declined, approving happens in the app").
    await approvedNothing(s, before);

    s.fo.transcripts.set(CONV, [fromFo(decisionLine(s.binding, "approved", "Actually, go ahead."))]);
    await checkTextReply(s.app.ctx, s.taskId);
    await s.app.settle();
    await approvedNothing(s, before);
    assert.throws(() => s.app.reply(s.taskId, "Actually, go ahead."), { status: 409 }, "and Kiki takes no further answer for it");
    s.app.refreshInventory();
    await s.app.settle();
    assert.equal(s.fo.asks.filter((a) => !a.conversationId && a.message.includes("Kiki approval handoff")).length, 1, "nor asks Fo about it again");
  });

  test("question: Fo answers and asks again; Kiki shows it and keeps waiting; your yes then approves", async (t) => {
    const s = await broughtToYou(t);
    const before = driveChanges(s);
    s.onAnswer((answer, b, n) =>
      n === 1
        ? reply(CONV, "complete", { response: `It would go in ${INVOICES} as "${INVOICE_FILED}", and the Flooring index would list it. Should Kiki go ahead?` })
        : approves(answer, b, n),
    );
    await s.answer("Which folder would it go in?");
    const n = await note(s);
    assert.equal(n.state, "needs_user_input");
    assert.match(n.question ?? "", /Projects\/Flooring\/Invoices/);
    assert.equal(n.reply?.status, "waiting");
    await checkTextReply(s.app.ctx, s.taskId);
    await approvedNothing(s, before);

    await s.answer("OK, go ahead.");
    assert.equal(await planStatus(s, s.plan.id), "applied");
    assert.equal((await note(s)).reply?.text, "OK, go ahead.");
  });

  for (const ambiguous of ["Hmm, not sure yet.", "Yes, if it's under $300.", "Maybe later?"]) {
    test(`ambiguous ("${ambiguous}"): Fo asks for clarification, nothing is approved, Kiki keeps waiting`, async (t) => {
      const s = await broughtToYou(t);
      const before = driveChanges(s);
      s.onAnswer((answer, b) => reply(CONV, "complete", { response: `Would you like Kiki to file it now, or leave it for later?\n${decisionLine(b, "clarification", answer)}` }));
      await s.answer(ambiguous);
      await checkTextReply(s.app.ctx, s.taskId);
      await s.app.settle();
      const n = await note(s);
      assert.equal(n.reply?.status, "waiting");
      assert.equal(n.state, "needs_user_input", "Fo is waiting for your answer again");
      await approvedNothing(s, before);
    });
  }
});

// 4. Unbound reports approve nothing --------------------------------------------------------

describe("anything unbound approves nothing", () => {
  const UNBOUND: [string, (b: Binding, answer: string) => string][] = [
    ["Fo says you approved, with no decision report", () => "Anika said go ahead, so Kiki can file it."],
    ["a report for another request", (b, a) => decisionLine({ ...b, requestId: randomUUID() }, "approved", a)],
    ["a report for another plan", (b, a) => decisionLine({ ...b, planId: randomUUID() }, "approved", a)],
    ["a report for different content", (b, a) => decisionLine({ ...b, contentHash: "0".repeat(64) }, "approved", a)],
    ["a report from someone other than you", (b, a) => decisionLine(b, "approved", a, { actor: "contractor" })],
    ["a report that says Fo didn't present the exact proposal", (b, a) => decisionLine(b, "approved", a, { presentedExactProposal: false })],
    ["two reports in one message", (b, a) => `${decisionLine(b, "approved", a)}\n${decisionLine(b, "declined", a)}`],
    ["a report that isn't on a line of its own", (b, a) => `For the record: ${decisionLine(b, "approved", a)}`],
    ["a report with a field Kiki didn't ask for", (b, a) => decisionLine(b, "approved", a, { scope: "everything" })],
  ];
  for (const [name, text] of UNBOUND) {
    test(name, async (t) => {
      const s = await broughtToYou(t);
      const before = driveChanges(s);
      s.onAnswer((answer, b) => reply(CONV, "complete", { response: text(b, answer) }));
      await s.answer("Yes, go ahead.");
      s.fo.transcripts.set(CONV, [fromFo(text(s.binding, "Yes, go ahead."))]);
      await checkTextReply(s.app.ctx, s.taskId);
      await s.app.settle();
      assert.equal((await note(s)).reply?.status, "waiting");
      await approvedNothing(s, before);
    });
  }

  test("a bound report in a different Fo conversation (say, your text thread) isn't read", async (t) => {
    const s = await broughtToYou(t, { first: () => reply(CONV, "complete", { response: TEXTED }) });
    const before = driveChanges(s);
    s.fo.conversations = [{ conversationId: "sms-thread", title: "Texts", channel: "sms", startedAt: new Date().toISOString() }];
    s.fo.transcripts.set("sms-thread", [fromFo(decisionLine(s.binding, "approved", "go ahead"))]);
    await checkTextReply(s.app.ctx, s.taskId);
    await s.app.settle();
    assert.equal((await note(s)).reply?.status, "waiting");
    await approvedNothing(s, before);
  });

  test("a bound report dated before Kiki's request isn't an answer to it", async (t) => {
    const s = await broughtToYou(t, { first: () => reply(CONV, "complete", { response: TEXTED }) });
    const before = driveChanges(s);
    s.fo.transcripts.set(CONV, [fromFo(decisionLine(s.binding, "approved", "go ahead"), new Date(Date.now() - 3600_000).toISOString())]);
    await checkTextReply(s.app.ctx, s.taskId);
    await s.app.settle();
    assert.equal((await note(s)).reply?.status, "waiting");
    await approvedNothing(s, before);
  });
});

// 5. Stale: the proposal changed after Fo was asked -----------------------------------------

describe("anything stale approves nothing", () => {
  test("you edit the proposal in Kiki: your answer to the old version is refused, and Fo's report for it approves nothing", async (t) => {
    const s = await broughtToYou(t, { first: () => reply(CONV, "complete", { response: TEXTED }) });
    const before = driveChanges(s);
    const move = s.plan.ops.find((o) => o.kind === "move_rename")!;
    const { planId: edited } = s.app.revisePlan(s.plan.id, [{ seq: move.seq, newName: "Northside levelling compound" }]);
    assert.throws(() => s.app.reply(s.taskId, "Yes, go ahead."), { status: 409 });
    assert.equal(s.fo.asks.length, 1, "nothing went to Fo");

    s.fo.transcripts.set(CONV, [fromFo(decisionLine(s.binding, "approved", "go ahead"))]);
    await checkTextReply(s.app.ctx, s.taskId);
    await s.app.settle();
    assert.equal((await note(s)).reply?.status, "stale");
    await approvedNothing(s, before, edited);
  });

  test("another file lands: Kiki re-proposes, brings the new version to Fo with a new binding; the old report approves nothing, the new one approves exactly the new version", async (t) => {
    const s = await broughtToYou(t);
    const rootId = s.drive.files.get(s.invoiceId)!.parent!;
    const secondId = s.drive.addFile(
      "Northside invoice Oct 20.pdf",
      rootId,
      "application/pdf",
      makePdf("INVOICE", ["Northside Building Supply", "Invoice No: N-5610", "Date: 2026-10-20", "Bill to: 12 Cedar Lane", "", "Transition strips, 2 pieces: $48.20", "", "Total (CAD): $48.20"]),
    );
    s.app.refreshInventory();
    await s.app.settle();
    const view = await s.app.view();
    const next = view.plans.find((p) => p.status === "proposed");
    assert.ok(next && next.id !== s.plan.id, "a new version");
    assert.equal(view.plans.find((p) => p.id === s.plan.id)?.status, undefined, "the old version is no longer shown as a plan");
    const handoffs = s.fo.asks.filter((a) => !a.conversationId && a.message.includes("Kiki approval handoff"));
    assert.equal(handoffs.length, 2);
    const nextBinding = bindingIn(handoffs[1]!.message);
    assert.deepEqual([nextBinding.planId, nextBinding.contentHash], [next.id, next.contentHash]);

    // Fo relays a yes to the first request: stale.
    s.fo.transcripts.set(CONV, [fromFo(decisionLine(s.binding, "approved", "go ahead"))]);
    await checkTextReply(s.app.ctx, s.taskId);
    await s.app.settle();
    assert.equal((await note(s)).reply?.status, "stale");
    assert.deepEqual(approvalsSinceSetup(s), []);

    // Your yes to the new request, inside Kiki: exactly the new version.
    const nextTask = view.notifications.find((n) => n.planId === next.id)!.taskId;
    s.onAnswer((answer, b) => reply(`${CONV}-2`, "complete", { response: decisionLine(b, "approved", answer) }));
    s.app.reply(nextTask, "Yes, file both.");
    await s.app.settle();
    assert.deepEqual(
      approvalsSinceSetup(s).map((a) => [a.plan_id, a.content_hash]),
      [[next.id, next.contentHash]],
    );
    assert.equal(await planStatus(s, next.id), "applied");
    assert.match(s.drive.pathOf(secondId), /^Renovation paperwork\/Projects\/Flooring\/Invoices\//);
  });

  test("someone renames the file in Drive: Kiki's next look makes a new version, and the old report approves nothing", async (t) => {
    const s = await broughtToYou(t, { first: () => reply(CONV, "complete", { response: TEXTED }) });
    s.drive.touch(s.invoiceId, { name: "Northside Oct 17 (from Dana).pdf" });
    s.app.refreshInventory();
    await s.app.settle();
    const next = (await s.app.view()).plans.find((p) => p.status === "proposed");
    assert.ok(next && next.id !== s.plan.id);
    s.fo.transcripts.set(CONV, [fromFo(decisionLine(s.binding, "approved", "go ahead"))]);
    await checkTextReply(s.app.ctx, s.taskId);
    await s.app.settle();
    assert.equal((await note(s)).reply?.status, "stale");
    assert.deepEqual(approvalsSinceSetup(s), []);
    assert.equal(await planStatus(s, next.id), "proposed");
  });
});

// 6. Restart while your answer is with Fo ---------------------------------------------------

test("Kiki restarts while your answer is with Fo: nothing is re-sent, and Fo's report in the conversation still approves once", async (t) => {
  const db = tempDbPath();
  const s = await broughtToYou(t, { db });
  s.onAnswer(() => new Promise<FoReply>(() => undefined)); // the process stops before Fo answers
  s.app.reply(s.taskId, "Yes, go ahead.");
  for (let i = 0; i < 200 && s.fo.asks.length < 2; i++) await sleep(2);
  assert.equal(s.fo.asks.length, 2);
  s.app.close();

  const fo = new FakeFo();
  fo.onAsk = async (_args, n) => reply(`conv-after-${n}`, "complete", { response: TEXTED });
  fo.transcripts.set(CONV, [fromFo(`Thanks.\n${decisionLine(s.binding, "approved", "Yes, go ahead.")}`)]);
  const restarted = makeRig({ db, drive: s.drive, fo });
  restarted.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => restarted.app.close());
  restarted.app.recover();
  await restarted.app.settle();
  await checkTextReply(restarted.app.ctx, s.taskId);
  await restarted.app.settle();
  assert.equal((await restarted.app.view()).plans.find((p) => p.id === s.plan.id)?.status, "applied");
  assert.equal(all(restarted.db, "SELECT * FROM plan_approvals WHERE client_request_id NOT LIKE 'setup-%'").length, 1);
  assert.equal(
    fo.asks.filter((a) => a.conversationId === CONV && !a.message.startsWith("Please text me")).length,
    0,
    "your answer wasn't sent again",
  );
});

// HTTP helpers -------------------------------------------------------------------------------

async function listen(t: TestContext, s: Brought): Promise<{ port: number; appOrigin: string }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const config = loadConfig({ PORT: String(port), KIKI_MODE: "mock", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "kiki-s3c-")) });
    const server = createHttpServer(s.app, config, { google: null, fo: null }, "/nonexistent");
    const ok = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!ok) continue;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port, appOrigin: config.appOrigin };
  }
  throw new Error("Couldn't find a free port.");
}

function call(port: number, c: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: c.method ?? "GET", path: c.path, agent: false, headers: { host: `localhost:${port}`, connection: "close", ...c.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(c.body);
  });
}

