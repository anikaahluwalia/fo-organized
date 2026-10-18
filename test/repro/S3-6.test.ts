import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { makePdf } from "../../server/demo/pdf.ts";
import { one } from "../../server/db.ts";
import type { FakeDrive } from "../../server/google/fake.ts";
import { FakeFo, makeRig, organized, reply, type AskArgs } from "../helpers.ts";

// S3-6 (feature gap): a document Kiki can't place only gets a note in the app, and Fo can't ask you
// where it goes.
//
// Today buildOrganizePlan (server/domain/plan.ts:298-305) leaves such a document in place with a
// note in the plan's details. When it arrives after the folder is organized, autoPropose
// (server/services/plans.ts) finds no move and stores no plan, so even the note is gone; the
// collections module says "it stays where it is and Kiki asks" (server/domain/collections.ts:8),
// but nothing asks.
//
// Settled with Kiki's one decision protocol rather than a second one: with nothing else to file, the
// files Kiki can't place make a question proposal ("Where does ... go?"), shown in Needs a look and,
// with texts on, brought to you through Fo with the places that fit. Your answer in Kiki comes back
// as Fo's bound KIKI-DECISION (changes_requested, quoting you); Kiki reads your words and makes a
// proposal that files it, which you approve. The agent's original design, for the record:
// 1. With "Text me when Kiki finds something new" on, Kiki asks Fo, once per document version, to
//    ask you (and nobody else) where the document goes, offering the folders she could use. The
//    request carries a binding {requestId, documentId, contentHash} as a JSON line, like the
//    approval handoff. Asking changes nothing in Drive.
// 2. You answer Fo's question inside Kiki (the same answer form as for proposals); Kiki sends it
//    with ask_fo on the same conversation. Fo reports the answer with ONE line
//    KIKI-PLACEMENT: {...binding, folder, userReply, actor: "account_holder"}.
// 3. A bound report naming one of the offered folders becomes a new organize proposal that moves
//    the document there, citing your words. Nothing moves until you approve that proposal.
// 4. A report that isn't bound to the question, or names a folder Kiki didn't offer, proposes
//    nothing.

const ROOT = "Renovation paperwork";
const FLOORING_INVOICES = "Projects/Flooring/Invoices";
const ANSWER = "Put it with the flooring invoices";
const TEXTED = "Texted you.\nKIKI-STATUS: SENT";
const ACME_INVOICE = ["Acme Widgets Inc.", "Invoice No: A-100", "Date: 2026-10-15", "", "Widgets, 4: $10.00", "", "Total (CAD): $10.00"];

const MUTATING = new Set(["createFolder", "update", "createFile", "updateContent"]);
const driveChanges = (drive: FakeDrive) => drive.calls.filter((c) => MUTATING.has(c.op)).length;

/** The binding Kiki put in her message to Fo: a JSON line with a requestId. */
function bindingIn(message: string): Record<string, unknown> | null {
  for (const line of message.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (typeof o.requestId === "string") return o;
    } catch {
      // not the binding
    }
  }
  return null;
}

type Rig = ReturnType<typeof makeRig> & { fo: FakeFo; acme: string };

/**
 * The folder is organized, texts are on, and an invoice from a supplier Kiki has never seen, with
 * no project on it, lands at the top of the workspace. `relay` is what Fo reports after you answer.
 */
async function acmeArrives(t: TestContext, relay: (binding: Record<string, unknown>) => Record<string, unknown>): Promise<Rig> {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  fo.onAsk = async (args: AskArgs, n: number) => {
    const binding = bindingIn(args.message);
    // Your answer, sent by Kiki on the mapped conversation: Fo relays it as the bound decision.
    if (args.conversationId && binding) return reply(args.conversationId, "complete", { response: `KIKI-DECISION: ${JSON.stringify(relay(binding))}` });
    return reply(`kiki-${n}`, "complete", { response: TEXTED });
  };
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  const rootId = one<{ root_file_id: string }>(rig.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  const acme = rig.drive.addFile("Acme invoice.pdf", rootId, "application/pdf", makePdf("INVOICE", ACME_INVOICE));
  rig.app.refreshInventory();
  await rig.app.settle();
  return { ...rig, fo, acme };
}

/** Kiki's question to Fo about the Acme invoice. */
function questionAbout(rig: Rig): AskArgs {
  const q = rig.fo.asks.find((a) => !a.conversationId && /Acme/.test(a.message));
  assert.ok(q, `Kiki didn't ask Fo where the Acme invoice goes (Fo was asked ${rig.fo.asks.length} time(s))`);
  return q;
}

async function answerInKiki(rig: Rig, answer: string): Promise<void> {
  const note = (await rig.app.view()).notifications.find((n) => n.text && /Acme/.test(n.text));
  assert.ok(note, "Kiki shows Fo's question about the Acme invoice");
  await rig.app.reply(note.taskId, answer);
  await rig.app.settle();
}

// Tests -------------------------------------------------------------------------------------------

test("a document Kiki can't place is pointed out in Needs a look, even when nothing else needs filing", async (t) => {
  const rig = await acmeArrives(t, (b) => b);
  const view = await rig.app.view();
  const item = view.attention.find((a) => /Acme/.test(`${a.title} ${a.detail ?? ""}`));
  assert.ok(item, `nothing in the app mentions the Acme invoice; Needs a look has: ${JSON.stringify(view.attention.map((a) => a.title))}, and Kiki says "${view.kiki.label}"`);
});

test("Kiki asks you through Fo where a document she can't place goes, and your answer becomes a proposal you approve", async (t) => {
  const rig = await acmeArrives(t, (b) => ({ ...b, decision: "changes_requested", userReply: ANSWER, actor: "account_holder", presentedExactProposal: true }));
  const changesBefore = driveChanges(rig.drive);

  // 1. Fo is asked, in a new conversation, to ask only you, with the folders Kiki could use.
  const question = questionAbout(rig);
  assert.equal(question.newConversation, true);
  assert.match(question.message, /nobody else/);
  assert.match(question.message, /Acme Widgets|A-100/, "it says which document, from what Kiki read");
  assert.match(question.message, new RegExp(FLOORING_INVOICES), "it offers the folder Kiki already files invoices in");
  assert.ok(bindingIn(question.message), "the question carries a binding, like the approval handoff");
  assert.equal(rig.fo.asks.filter((a) => /Acme/.test(a.message)).length, 1, "asked once");
  assert.equal(driveChanges(rig.drive), changesBefore, "asking changes nothing in Drive");

  // 2. You answer inside Kiki; Kiki passes it to Fo on the same conversation.
  await answerInKiki(rig, ANSWER);
  // (The new version then comes back to you as a text: the question reached you as one.)
  const continuation = rig.fo.asks.findLast((a) => a.message.startsWith("Answer from the account holder"))!;
  assert.ok(continuation.conversationId, "your answer went to Fo on the mapped conversation");
  assert.match(continuation.message, /Put it with the flooring invoices/);

  // 3. The answer is a proposal, not a move.
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(plan, "your answer became a proposal");
  const move = plan.ops.find((o) => o.kind === "move_rename" && o.before?.name === "Acme invoice.pdf");
  assert.ok(move, "the proposal files the Acme invoice");
  assert.equal(move.after?.path, FLOORING_INVOICES);
  assert.match(move.reason ?? "", /as you asked/i, "the reason says it's your choice");
  assert.equal(rig.drive.pathOf(rig.acme), `${ROOT}/Acme invoice.pdf`, "nothing moved before you approve");
  assert.equal(driveChanges(rig.drive), changesBefore);

  // The same answer and report again (a replay) make no second version.
  await answerInKiki(rig, ANSWER);
  assert.deepEqual(
    (await rig.app.view()).plans.filter((p) => p.status === "proposed" && p.ops.length > 0).map((p) => p.id),
    [plan.id],
  );

  // 4. Approving that exact proposal files it, verified in Drive.
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve-acme" });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === plan.id)?.status, "applied");
  assert.match(rig.drive.pathOf(rig.acme), new RegExp(`^${ROOT}/${FLOORING_INVOICES}/`));
});

test("an answer about a folder Kiki didn't offer, or not bound to her question, proposes nothing and moves nothing", async (t) => {
  for (const relay of [
    // Fo quotes words you didn't say (you wrote "whatever you think"): Kiki reads your own words.
    (b: Record<string, unknown>) => ({ ...b, decision: "changes_requested", userReply: "Put it in ../Personal taxes", actor: "account_holder", presentedExactProposal: true }),
    (b: Record<string, unknown>) => ({ ...b, requestId: "someone-else", decision: "changes_requested", userReply: ANSWER, actor: "account_holder", presentedExactProposal: true }),
    (b: Record<string, unknown>) => ({ ...b, decision: "changes_requested", userReply: ANSWER, actor: "contractor", presentedExactProposal: true }),
  ]) {
    const rig = await acmeArrives(t, relay);
    questionAbout(rig);
    const changesBefore = driveChanges(rig.drive);
    await answerInKiki(rig, "whatever you think");
    const plans = (await rig.app.view()).plans;
    assert.equal(plans.some((p) => p.status === "approved" || p.status === "applied" && p.ops.some((o) => o.before?.name === "Acme invoice.pdf")), false, "nothing is approved");
    assert.equal(plans.some((p) => p.ops.some((o) => o.before?.name === "Acme invoice.pdf")), false, "nothing proposes moving it");
    assert.equal(rig.drive.pathOf(rig.acme), `${ROOT}/Acme invoice.pdf`);
    assert.equal(driveChanges(rig.drive), changesBefore);
  }
});
