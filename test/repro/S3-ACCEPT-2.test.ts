import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { all } from "../../server/db.ts";
import type { FoReply } from "../../server/fo/types.ts";
import { checkTextReply } from "../../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3-ACCEPT, the gaps. "Your answer inside Kiki (approve, decline, adjust, question) comes back
// linked to it": an adjustment never becomes a new version (ROADMAP.md flowchart: "adjust or stale
// -> P", Kiki prepares a proposal), and when you ask Fo a question, what Fo answers isn't what
// Kiki shows you. Each test asserts the correct behavior and fails today.

const CONV = "conv-kiki-proposal";
const INVOICE_NAME = "Northside invoice Oct 17.pdf";
const INVOICE_FILED = "2026-10-17 Invoice - Northside Building Supply - N-5602.pdf";
const FO_ASKS = "Waiting for your answer: Kiki would file the new Northside invoice in Projects/Flooring/Invoices and update the Flooring index. Should she go ahead?";
const TEXTED = "Texted you Kiki's message.\nKIKI-STATUS: SENT";

type Binding = { requestId: string; planId: string; contentHash: string };
type FoAnswer = (answer: string, b: Binding, n: number) => FoReply;

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

const decisionLine = (b: Binding, decision: "approved" | "declined" | "clarification", userReply: string) =>
  "KIKI-DECISION: " + JSON.stringify({ ...b, decision, userReply, actor: "account_holder", presentedExactProposal: true });

/** A Fo that does what Kiki's request asks: a changed scope or a question is reported as "clarification". */
const clarifies =
  (says: string): FoAnswer =>
  (answer, b) =>
    reply(CONV, "complete", { response: `${says}\n${decisionLine(b, "clarification", answer)}` });

/**
 * Texts are on and Fo is asked to bring a proposal to you: by default the new Northside invoice
 * after the first organizing pass; with `first: true`, the first organizing proposal itself.
 * Fo puts it to you and waits; your answers typed in Kiki reach Fo on its conversation.
 */
async function broughtToYou(t: TestContext, opts: { first?: boolean } = {}) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  let onAnswer: FoAnswer = () => reply(CONV, "complete", { response: "Noted.\nKIKI-STATUS: NEED-INPUT" });
  let answers = 0;
  let others = 0;
  fo.onAsk = async (args) => {
    if (args.conversationId) return onAnswer(answerIn(args.message), bindingIn(args.message), ++answers);
    if (args.message.includes("Kiki approval handoff")) return reply(CONV, "working", { progress: FO_ASKS });
    return reply(`conv-done-${++others}`, "complete", { response: TEXTED });
  };
  if (opts.first) {
    rig.app.updateSettings({ autoText: true });
    await rig.app.createDemoWorkspace();
    await rig.app.settle();
  } else {
    await organized(rig);
    rig.app.updateSettings({ autoText: true });
    await rig.app.stageRevision("invoice");
    await rig.app.settle();
  }
  const view = await rig.app.view();
  const plan = view.plans.find((p) => p.status === "proposed");
  assert.ok(plan, "Kiki proposed a plan");
  const note = view.notifications.find((n) => n.purpose === "find" && n.planId === plan.id);
  assert.ok(note, "and asked Fo to bring it to you");
  assert.equal(note.state, "needs_user_input");
  const invoiceId = [...rig.drive.files.values()].find((f) => f.name === INVOICE_NAME)?.id ?? null;
  return {
    ...rig,
    fo,
    plan,
    invoiceId,
    taskId: note.taskId,
    onAnswer(fn: FoAnswer) {
      onAnswer = fn;
    },
    /** You type an answer in Kiki's "Answer Fo about this proposal" box. */
    async answer(text: string) {
      await rig.app.reply(note.taskId, text);
      await rig.app.settle();
      await checkTextReply(rig.app.ctx, note.taskId);
      await rig.app.settle();
    },
  };
}
type Brought = Awaited<ReturnType<typeof broughtToYou>>;

const approvedPlans = (s: Brought) => all<{ plan_id: string }>(s.db, "SELECT plan_id FROM plan_approvals WHERE client_request_id NOT LIKE 'setup-%'").map((r) => r.plan_id);

async function note(s: Brought) {
  const n = (await s.app.view()).notifications.find((x) => x.taskId === s.taskId);
  assert.ok(n);
  return n;
}

// Adjust -------------------------------------------------------------------------------------

describe("adjust: your change comes back as a new version, and only that version can be approved", () => {
  test("'go ahead, but call it …' makes a new version with your name; the version Fo explained can no longer be approved", async (t) => {
    const s = await broughtToYou(t);
    s.onAnswer(clarifies("Got it: you'd like a different name. I'll pass that to Kiki."));
    await s.answer('Go ahead, but call it "Northside levelling compound".');

    const open = (await s.app.view()).plans.find((p) => p.status === "proposed");
    assert.ok(open, "a proposal is open");
    assert.equal(open.ops.find((o) => o.kind === "move_rename")?.after?.name, "Northside levelling compound.pdf", "the open proposal carries the name you asked for");
    assert.notEqual(open.contentHash, s.plan.contentHash, "as a new version with its own hash");
    assert.throws(() => s.app.approvePlan(s.plan.id, { contentHash: s.plan.contentHash, clientRequestId: "old-version" }), { status: 409 }, "the version you asked to change can't be approved");
    assert.deepEqual(approvedPlans(s), [], "and your change approved nothing by itself");
  });

  test("after you ask for a change, Fo relaying your 'yes' doesn't apply the version without it", async (t) => {
    const s = await broughtToYou(t);
    s.onAnswer((answer, b, n) =>
      n === 1
        ? reply(CONV, "complete", { response: `Kiki's proposal names it "${INVOICE_FILED}". Should Kiki go ahead with your name instead?\n${decisionLine(b, "clarification", answer)}` })
        : reply(CONV, "complete", { response: `Thanks.\n${decisionLine(b, "approved", answer)}` }),
    );
    await s.answer('Go ahead, but call it "Northside levelling compound".');
    // Your change made a new version, so a yes on the old request is refused rather than applied.
    await assert.rejects(async () => s.answer("Yes."), { status: 409 });

    assert.equal(approvedPlans(s).includes(s.plan.id), false, "the version you asked to change wasn't approved");
    assert.notEqual(s.drive.files.get(s.invoiceId!)?.name, INVOICE_FILED, "and the invoice wasn't filed under the name you turned down");
  });

  test("'go ahead, but leave IMG_2041.pdf where it is' makes a new version without that step", async (t) => {
    const s = await broughtToYou(t, { first: true });
    const skipped = s.plan.ops.find((o) => o.kind === "move_rename" && o.before?.name === "IMG_2041.pdf");
    assert.ok(skipped, "the first proposal files IMG_2041.pdf");
    s.onAnswer(clarifies("Understood: everything except IMG_2041.pdf. I'll pass that to Kiki."));
    await s.answer("Go ahead, but leave IMG_2041.pdf where it is.");

    const open = (await s.app.view()).plans.find((p) => p.status === "proposed");
    assert.ok(open);
    assert.equal(open.ops.find((o) => o.kind === "move_rename" && o.before?.name === "IMG_2041.pdf")?.state, "excluded", "that step is left out of the open proposal");
    assert.ok(open.ops.some((o) => o.kind === "move_rename" && o.before?.name === "scan_0012.pdf" && o.state === "pending"), "the rest is still proposed");
    assert.notEqual(open.contentHash, s.plan.contentHash);
    assert.deepEqual(approvedPlans(s), []);
  });
});

// Question -------------------------------------------------------------------------------------

describe("question: Kiki shows what Fo answered and keeps waiting", () => {
  test("when Fo answers your question and reports 'clarification' as asked, Kiki shows Fo's answer, not your own words as Fo's question", async (t) => {
    const s = await broughtToYou(t);
    s.onAnswer(clarifies(`It would go in Projects/Flooring/Invoices as "${INVOICE_FILED}". Should Kiki go ahead?`));
    await s.answer("Which folder would it go in?");

    const n = await note(s);
    assert.equal(n.state, "needs_user_input");
    assert.equal(n.reply?.status, "waiting");
    assert.deepEqual(approvedPlans(s), []);
    // The web app (App.tsx:613) and the side panel (extension/lib.js:152) show `question`.
    assert.match(n.question ?? "", /Projects\/Flooring\/Invoices/, `Kiki shows Fo's answer (shown: ${JSON.stringify(n.question)})`);
  });

  test("when Fo answers your question and ends with a status line, Kiki still shows Fo's answer", async (t) => {
    const s = await broughtToYou(t);
    s.onAnswer(() => reply(CONV, "complete", { response: `It would go in Projects/Flooring/Invoices as "${INVOICE_FILED}". Tell me if Kiki should go ahead.\nKIKI-STATUS: SENT` }));
    await s.answer("Which folder would it go in?");

    const n = await note(s);
    assert.equal(n.reply?.status, "waiting");
    assert.deepEqual(approvedPlans(s), []);
    assert.match(n.question ?? "", /Projects\/Flooring\/Invoices/, `Kiki shows Fo's answer (shown: ${JSON.stringify(n.question)}; the answer is only in finalResponse, which neither UI renders)`);
  });
});
