import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { App } from "../server/app.ts";
import { all } from "../server/db.ts";
import { sourceLabel, verifyOutcome, type Outcome } from "../server/domain/outcome.ts";
import { FoCallError, type FoReply, type FoTurn } from "../server/fo/types.ts";
import type { FakeDrive } from "../server/google/fake.ts";
import { DriveError } from "../server/google/types.ts";
import { checkTextReply, newFindText, replyState, sendDoneText } from "../server/services/notify.ts";
import { checkWatch } from "../server/services/watch.ts";
import { FakeFo, makeRig, organized, reply, sleep, tempDbPath, type TestRig } from "./helpers.ts";

// The Fo loop: approved outreach to the contractor, following the mapped Fo conversation, turning
// its outcome into a reviewed organizing proposal, and texts to the account holder. Fo is scripted
// (FakeFo); Drive is the in-memory FakeDrive; documents and replies are read by the mock reader.

const CONV = "conv-dana";
const SENT = "I emailed Dana the approved message exactly as written.\nKIKI-STATUS: SENT";
const DANA_NO = 'Dana replied: "No, use the revised quote I emailed today."';
const DANA = { contractorName: "Dana", contractorEmail: "dana@oakline.example", consent: true };
const ROOT = "Renovation paperwork";
const QUOTES = "Projects/Flooring/Quotes";
const SUPERSEDED = "Projects/Flooring/Quotes/Superseded";
const OLD_NAME = "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf";
const R1_NAME = "Oakline Flooring - revised quote.pdf";
const R1_FILED = "2026-10-17 Revised quote - Oakline Flooring Co. - Q-1042-R1.pdf";
const INVOICE_NAME = "Northside invoice Oct 17.pdf";
const INVOICE_FILED = "2026-10-17 Invoice - Northside Building Supply - N-5602.pdf";
const TEXTED = "Texted you.\nKIKI-STATUS: SENT";

// Helpers ----------------------------------------------------------------------------------

let tick = 0;
/** Just after now and unique per call, so every scripted turn has its own key. */
const stamp = () => new Date(Date.now() + tick++).toISOString();
const fromFo = (text: string, at = stamp()): FoTurn => ({ role: "assistant", text, at });
const fromUser = (text: string, at = stamp()): FoTurn => ({ role: "user", text, at });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await sleep(2);
  }
  assert.fail(`timed out waiting until ${what}`);
}

type Rig = TestRig & { fo: FakeFo };

function foRig(t: TestContext, opts: { db?: string } = {}): Rig {
  const fo = new FakeFo();
  const rig = makeRig({ fo, db: opts.db });
  // makeRig sets watchIntervalSeconds to 0, so a due "watch" job reschedules itself at 0 s and
  // app.settle() never returns once Kiki's first look at a watched conversation (queued 1 s after
  // Fo reports SENT) comes due. These tests look at the conversation themselves with checkWatch.
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  return { ...rig, fo };
}

async function indexRows(app: App) {
  return (await app.view()).index.flatMap((p) => p.rows);
}

async function row(app: App, reference: string) {
  const r = (await indexRows(app)).find((x) => x.reference === reference);
  assert.ok(r, `${reference} is in the index`);
  return r;
}

async function quoteStatuses(app: App): Promise<Record<string, string | null>> {
  const quotes = (await indexRows(app)).filter((r) => r.docType === "quote");
  return Object.fromEntries(quotes.map((r) => [r.reference ?? r.fileName, r.status]));
}

async function currentQuotes(app: App): Promise<string[]> {
  return Object.entries(await quoteStatuses(app))
    .filter(([, status]) => status === "current")
    .map(([reference]) => reference);
}

function fileNamed(drive: FakeDrive, name: string) {
  const f = [...drive.files.values()].find((x) => x.name === name);
  assert.ok(f, `"${name}" is in Drive`);
  return f;
}

const MUTATING = new Set(["createFolder", "update", "createFile", "updateContent"]);
const driveChanges = (drive: FakeDrive) => drive.calls.filter((c) => MUTATING.has(c.op));

function indexCsvLine(drive: FakeDrive, needle: string): string {
  const csv = [...drive.files.values()].find((f) => f.name === "Flooring - document index (kept by Kiki).csv");
  assert.ok(csv?.content, "the index file is in Drive");
  const line = csv.content.toString("utf8").split("\r\n").find((l) => l.includes(needle));
  assert.ok(line, `the Drive index lists ${needle}`);
  return line;
}

const permissionDenied = () => new DriveError("Drive refused: you can't move this file.", "permission", { status: 403 });

async function approve(app: App, planId: string) {
  const plan = (await app.view()).plans.find((p) => p.id === planId);
  assert.ok(plan, "the plan is shown");
  app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
  await app.settle();
  const after = (await app.view()).plans.find((p) => p.id === planId);
  assert.ok(after);
  return after;
}

async function versionPlan(app: App) {
  const plan = (await app.view()).plans.find((p) => p.kind === "version_update");
  assert.ok(plan, "Kiki proposed a version update");
  return plan;
}

async function latestUpdate(app: App) {
  const [u] = (await app.view()).updates;
  assert.ok(u, "Kiki recorded an update from the conversation");
  return u;
}

// Outreach setup: the paperwork is organized, you've added your name, and Q-1042 is in the index.
async function readyToAsk(t: TestContext, opts: { db?: string } = {}) {
  const rig = foRig(t, opts);
  await organized(rig);
  rig.app.updateSettings({ userName: "Anika" });
  return { ...rig, quoteId: (await row(rig.app, "Q-1042")).docId };
}

async function currentDraft(app: App, documentId: string) {
  const d = (await app.view()).outreach.find((o) => o.documentId === documentId)?.draft;
  assert.ok(d, "there is a draft");
  return d;
}

async function dispatches(app: App) {
  return (await app.view()).outreach.flatMap((o) => o.dispatches);
}

/** Dana has been asked about Q-1042, Fo reported the email as sent, and Kiki follows CONV. */
async function askedDana(t: TestContext, opts: { db?: string } = {}) {
  const rig = await readyToAsk(t, opts);
  const { versionId } = rig.app.createOutreachDraft(rig.quoteId, DANA);
  const { contentHash } = await currentDraft(rig.app, rig.quoteId);
  rig.fo.onAsk = async () => reply(CONV, "complete", { response: SENT });
  const { dispatchId } = rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-1" });
  await rig.app.settle();
  const [d] = await dispatches(rig.app);
  assert.equal(d?.state, "reported_sent");
  assert.ok(d.watch, "Kiki follows the conversation");
  // What Fo's conversation shows so far: Kiki's request and Fo's answer.
  rig.fo.transcripts.set(CONV, [fromUser(rig.fo.asks[0]!.message), fromFo(SENT)]);
  return { ...rig, dispatchId, watchId: d.watch.id };
}
type Asked = Awaited<ReturnType<typeof askedDana>>;

function foPosts(rig: Asked, ...turns: FoTurn[]): void {
  rig.fo.transcripts.set(CONV, [...(rig.fo.transcripts.get(CONV) ?? []), ...turns]);
}

/** Fo posts a message in the mapped conversation; Kiki picks it up and works through it. */
async function foSays(rig: Asked, text: string): Promise<void> {
  foPosts(rig, fromFo(text));
  await checkWatch(rig.app.ctx, rig.watchId);
  await rig.app.settle();
}

/** Dana's answer came in after the revised quote landed in the folder. */
async function revisionProposed(t: TestContext) {
  const rig = await askedDana(t);
  await rig.app.stageRevision("single");
  await rig.app.settle();
  await foSays(rig, DANA_NO);
  return { ...rig, plan: await versionPlan(rig.app) };
}

// Texts setup: texts are on, a new supplier invoice landed, and Fo texted you about it.
async function textedAboutInvoice(t: TestContext, ack = TEXTED) {
  const rig = foRig(t);
  rig.fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: ack });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const view = await rig.app.view();
  const plan = view.plans.find((p) => p.status === "proposed");
  const note = view.notifications.find((n) => n.purpose === "find");
  assert.ok(plan, "Kiki proposed filing the invoice");
  assert.ok(note, "Fo was asked to text you");
  assert.ok(note.text);
  return { ...rig, plan, note, text: note.text };
}
type Texted = Awaited<ReturnType<typeof textedAboutInvoice>>;

/** The exact bodies Kiki asked Fo to text the account holder, in order. */
function texts(fo: FakeFo): string[] {
  return fo.asks
    .filter((a) => a.message.startsWith("Please text me"))
    .map((a) => /-----BEGIN APPROVED BODY-----\n([\s\S]*?)\n-----END APPROVED BODY-----/.exec(a.message)?.[1] ?? "");
}

/** Your text thread with Fo: Kiki's text, then your reply. */
function youTextBack(rig: Texted, answer: string): void {
  rig.fo.conversations = [{ conversationId: "sms-thread", title: "Texts", channel: "sms", startedAt: new Date().toISOString() }];
  rig.fo.transcripts.set("sms-thread", [fromFo(rig.text), fromUser(answer)]);
  const state = replyState(rig.app.ctx, rig.note.taskId)!;
  // Simulate Fo actually relaying the decision to the mapped conversation, not Kiki guessing an SMS match.
  rig.fo.transcripts.set("kiki-1", [fromFo("KIKI-DECISION: " + JSON.stringify({ requestId: state.requestId, planId: state.planId, contentHash: state.contentHash, decision: /no|wait/i.test(answer) ? "declined" : "approved", userReply: answer, actor: "account_holder", presentedExactProposal: true }))]);
}

/** You answer Fo's text inside Kiki (for now, the way to answer); Fo relays your decision, bound to the request. */
async function youAnswerInKiki(rig: Texted, answer: string): Promise<void> {
  const state = replyState(rig.app.ctx, rig.note.taskId)!;
  rig.fo.onAsk = async (args) =>
    reply(args.conversationId!, "complete", {
      response: "KIKI-DECISION: " + JSON.stringify({ requestId: state.requestId, planId: state.planId, contentHash: state.contentHash, decision: /no|wait/i.test(answer) ? "declined" : "approved", userReply: answer, actor: "account_holder", presentedExactProposal: true }),
    });
  await rig.app.reply(rig.note.taskId, answer);
  await rig.app.settle();
}

async function replyTo(rig: Texted) {
  return (await rig.app.view()).notifications.find((n) => n.taskId === rig.note.taskId)?.reply;
}

async function planStatus(app: App, planId: string) {
  return (await app.view()).plans.find((p) => p.id === planId)?.status;
}

// 1. Contractor outreach -------------------------------------------------------------------

describe("contractor outreach through Fo", () => {
  test("a draft needs your name and the contractor's consent, and nothing reaches Fo while drafting", async (t) => {
    const rig = foRig(t);
    await organized(rig);
    const { docId } = await row(rig.app, "Q-1042");
    assert.throws(() => rig.app.createOutreachDraft(docId, DANA), { status: 400, message: /your first name/ });
    rig.app.updateSettings({ userName: "Anika" });
    assert.throws(() => rig.app.createOutreachDraft(docId, { ...DANA, consent: false }), { status: 400, code: "consent_required" });
    assert.throws(() => rig.app.createOutreachDraft(docId, { contractorName: "Dana", contractorEmail: "dana@oakline.example" }), { code: "consent_required" });

    const { versionId } = rig.app.createOutreachDraft(docId, DANA);
    const draft = await currentDraft(rig.app, docId);
    assert.equal(draft.versionId, versionId);
    assert.equal(draft.version, 1);
    assert.equal(draft.consentConfirmed, true);
    assert.equal(draft.recipientEmail, "dana@oakline.example");
    assert.match(draft.body, /I'm Kiki, an AI assistant helping Anika/);
    assert.match(draft.body, /quote Q-1042 dated 2026-09-28 \(total \$8,450\.00\)/);
    assert.deepEqual(draft.problems, []);
    assert.equal(rig.fo.asks.length, 0);
  });

  test("editing the message makes a new version; the old version and the old text can't be approved", async (t) => {
    const rig = await readyToAsk(t);
    const { versionId: v1 } = rig.app.createOutreachDraft(rig.quoteId, DANA);
    const first = await currentDraft(rig.app, rig.quoteId);
    assert.equal(rig.app.reviseOutreach(v1, { body: first.body }).versionId, v1, "saving the same text keeps the version");

    const body = first.body.replace("A short reply", "A one-line reply");
    const { versionId: v2 } = rig.app.reviseOutreach(v1, { body });
    const second = await currentDraft(rig.app, rig.quoteId);
    assert.notEqual(v2, v1);
    assert.equal(second.version, 2);
    assert.notEqual(second.contentHash, first.contentHash);
    assert.throws(() => rig.app.approveAndSend(v1, { contentHash: first.contentHash, clientRequestId: "old-version" }), { status: 409, code: "stale_draft" });
    assert.throws(() => rig.app.approveAndSend(v2, { contentHash: first.contentHash, clientRequestId: "old-text" }), { status: 409, code: "hash_mismatch" });
    assert.throws(() => rig.app.reviseOutreach(v1, { body: "Hi Dana" }), { code: "stale_draft" });
    assert.throws(() => rig.app.reviseOutreach(v2, { recipientEmail: "someone.else@example.com" }), { status: 400, code: "consent_required" });
    assert.equal(rig.fo.asks.length, 0);

    rig.fo.onAsk = async () => reply(CONV, "complete", { response: SENT });
    assert.equal(rig.app.approveAndSend(v2, { contentHash: second.contentHash, clientRequestId: "current" }).created, true);
    await rig.app.settle();
    assert.equal(rig.fo.asks.length, 1);
    assert.equal(rig.fo.asks[0]!.newConversation, true);
    assert.ok(rig.fo.asks[0]!.message.includes(`-----BEGIN APPROVED BODY-----\n${body}\n-----END APPROVED BODY-----`), "Fo gets exactly the approved text");
    assert.match(rig.fo.asks[0]!.message, /^To: Dana <dana@oakline\.example>$/m);
  });

  test("double-clicked approve-and-send creates one dispatch and asks Fo once", async (t) => {
    const db = tempDbPath();
    const rig = await readyToAsk(t, { db });
    const { versionId } = rig.app.createOutreachDraft(rig.quoteId, DANA);
    const { contentHash } = await currentDraft(rig.app, rig.quoteId);
    const answer = deferred<FoReply>();
    rig.fo.onAsk = () => answer.promise; // Fo takes its time, so the other clicks land mid-request

    const clicks = await Promise.all(["click-1", "click-2", "click-1"].map(async (clientRequestId) => rig.app.approveAndSend(versionId, { contentHash, clientRequestId })));
    assert.deepEqual(
      clicks.map((c) => c.created),
      [true, false, false],
    );
    assert.equal(new Set(clicks.map((c) => c.dispatchId)).size, 1);
    // A second Kiki process on the same database resolves to the same dispatch as well.
    const otherFo = new FakeFo();
    const other = makeRig({ db, fo: otherFo });
    other.app.ctx.watchIntervalSeconds = 3600;
    t.after(() => other.app.close());
    assert.deepEqual(other.app.approveAndSend(versionId, { contentHash, clientRequestId: "click-elsewhere" }), { dispatchId: clicks[0]!.dispatchId, created: false });

    answer.resolve(reply(CONV, "complete", { response: SENT }));
    await rig.app.settle();
    assert.equal(rig.fo.asks.length, 1);
    assert.equal(otherFo.asks.length, 0);
    const ds = await dispatches(rig.app);
    assert.deepEqual(
      ds.map((d) => d.state),
      ["reported_sent"],
    );
    assert.throws(() => rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "click-3" }), { status: 409, code: "already_sent" });
    assert.equal(rig.fo.asks.length, 1);
  });

  test("when Fo asks a question mid-send, your answer continues the same conversation and the email goes out", async (t) => {
    const rig = await readyToAsk(t);
    const { versionId } = rig.app.createOutreachDraft(rig.quoteId, DANA);
    const { contentHash } = await currentDraft(rig.app, rig.quoteId);
    const question = "Waiting for your answer: should I send it from anika@example.com or from your work address?";
    rig.fo.onAsk = async (_args, n) => (n === 1 ? reply(CONV, "working", { progress: "Drafting the email to Dana…", elapsedSeconds: 4 }) : reply(CONV, "complete", { response: SENT }));
    rig.fo.onPoll = async () => reply(CONV, "working", { progress: question, elapsedSeconds: 21 });
    rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-1" });
    await rig.app.settle();

    let [d] = await dispatches(rig.app);
    assert.equal(d?.state, "needs_user_input");
    assert.equal(d.task.question, question);
    assert.equal(rig.fo.asks.length, 1, "nothing else was sent while Fo was working");
    assert.ok(rig.fo.polls.length >= 1 && rig.fo.polls.every((p) => p.conversationId === CONV));

    await rig.app.reply(d.task.taskId, "Use anika@example.com.");
    await rig.app.settle();
    assert.equal(rig.fo.asks.length, 2);
    const answer = rig.fo.asks[1]!;
    assert.equal(answer.conversationId, CONV);
    assert.equal(answer.newConversation, undefined);
    assert.match(answer.message, /Use anika@example\.com\./);
    assert.match(answer.message, /the approval covers only sending the exact email already given/);
    [d] = await dispatches(rig.app);
    assert.equal(d?.state, "reported_sent");
    assert.equal(d.watch?.state, "watching");
    assert.throws(() => rig.app.reply(d.task.taskId, "Also copy my partner."), { status: 409 }, "Fo isn't waiting for an answer any more");
    assert.equal(rig.fo.asks.length, 2);
  });

  test("an answer can't be pushed into a turn Fo is still working on", async (t) => {
    const rig = await readyToAsk(t);
    const { versionId } = rig.app.createOutreachDraft(rig.quoteId, DANA);
    const { contentHash } = await currentDraft(rig.app, rig.quoteId);
    const done = deferred<FoReply>();
    rig.fo.onAsk = async () => reply(CONV, "working", { progress: "Drafting the email to Dana…" });
    rig.fo.onPoll = () => done.promise;
    rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-1" });
    await until("Fo is working", async () => (await dispatches(rig.app))[0]?.state === "working");

    const [d] = await dispatches(rig.app);
    assert.throws(() => rig.app.reply(d!.task.taskId, "Send it now."), { status: 409 });
    assert.equal(rig.fo.asks.length, 1);
    done.resolve(reply(CONV, "complete", { response: SENT }));
    await rig.app.settle();
    assert.equal((await dispatches(rig.app))[0]?.state, "reported_sent");
    assert.equal(rig.fo.asks.length, 1);
  });

  test("a lost response leaves the send uncertain: no resend, and Kiki finds the conversation by its reference without asking Fo again", async (t) => {
    const rig = await readyToAsk(t);
    const { versionId } = rig.app.createOutreachDraft(rig.quoteId, DANA);
    const { contentHash, body } = await currentDraft(rig.app, rig.quoteId);
    rig.fo.onAsk = async () => {
      throw new FoCallError("Timed out waiting for Fo's response.", "unknown", "timeout");
    };
    const { dispatchId } = rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-1" });
    await rig.app.settle();
    let [d] = await dispatches(rig.app);
    assert.equal(d?.state, "uncertain");
    assert.equal(d.open, true);
    assert.equal(rig.fo.asks.length, 1, "no automatic resubmission");

    // Another click, even after editing the message, doesn't send a second email while this is open.
    assert.deepEqual(rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-2" }), { dispatchId, created: false });
    const { versionId: v2 } = rig.app.reviseOutreach(versionId, { body: body.replace("Thank you!", "Thanks!") });
    const edited = await currentDraft(rig.app, rig.quoteId);
    assert.deepEqual(rig.app.approveAndSend(v2, { contentHash: edited.contentHash, clientRequestId: "send-3" }), { dispatchId, created: false });
    assert.throws(() => rig.app.retireDispatch(dispatchId, true), { status: 409 }, "it can't be closed before checking with Fo");
    assert.equal(rig.fo.asks.length, 1);

    // Fo's recent conversations don't mention the reference yet.
    rig.fo.conversations = [{ conversationId: "conv-dinner", title: "Dinner booking", channel: "chat", startedAt: new Date().toISOString() }];
    rig.fo.transcripts.set("conv-dinner", [fromUser("Book a table for two at 7."), fromFo("Booked for 7pm.")]);
    const miss = await rig.app.reconcileDispatch(dispatchId);
    assert.equal(miss.found, false);
    assert.equal((await dispatches(rig.app))[0]?.state, "uncertain");

    // The request did reach Fo: one conversation holds Kiki's message with the reference.
    const reference = (await dispatches(rig.app))[0]!.reference;
    assert.ok(rig.fo.asks[0]!.message.includes(reference));
    rig.fo.conversations.unshift({ conversationId: "conv-found", title: "Email to Dana", channel: "chat", startedAt: new Date().toISOString() });
    rig.fo.transcripts.set("conv-found", [fromUser(rig.fo.asks[0]!.message), fromFo(SENT)]);
    rig.fo.onPoll = async (args) => reply(args.conversationId, "complete", { response: SENT });
    const hit = await rig.app.reconcileDispatch(dispatchId);
    assert.equal(hit.found, true);
    await rig.app.settle();
    assert.equal(rig.fo.asks.length, 1, "reconciling only read Fo's conversations");
    assert.deepEqual(
      rig.fo.polls.map((p) => [p.conversationId, p.waitSeconds]),
      [["conv-found", 0]],
    );
    [d] = await dispatches(rig.app);
    assert.equal(d?.state, "reported_sent");
    assert.ok(d.reconciledAt);
    assert.ok(d.watch, "Kiki now follows the conversation she found");
    rig.fo.transcripts.set("conv-found", [...rig.fo.transcripts.get("conv-found")!, fromFo(DANA_NO)]);
    assert.deepEqual(await checkWatch(rig.app.ctx, d.watch.id), { newTurns: 1 });
  });

  test("a request that never reached Fo fails cleanly and can be sent again", async (t) => {
    const rig = await readyToAsk(t);
    const { versionId } = rig.app.createOutreachDraft(rig.quoteId, DANA);
    const { contentHash } = await currentDraft(rig.app, rig.quoteId);
    rig.fo.onAsk = async (_args, n) => {
      if (n === 1) throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
      return reply(CONV, "complete", { response: SENT });
    };
    const first = rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-1" });
    await rig.app.settle();
    let ds = await dispatches(rig.app);
    assert.equal(ds[0]?.state, "failed");
    assert.equal(ds[0].open, false);
    assert.equal(ds[0].task.failureKind, "not_sent");

    // Replaying the same request changes nothing; a new click sends a second attempt, no resend warning needed.
    assert.deepEqual(rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-1" }), { dispatchId: first.dispatchId, created: false });
    assert.equal(rig.fo.asks.length, 1);
    assert.equal(rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-2" }).created, true);
    await rig.app.settle();
    ds = await dispatches(rig.app);
    assert.deepEqual(
      ds.map((d) => [d.attempt, d.state]),
      [
        [1, "failed"],
        [2, "reported_sent"],
      ],
    );
    assert.equal(rig.fo.asks.length, 2);
  });
});

// 2. Following the mapped conversation ------------------------------------------------------

describe("following the Fo conversation", () => {
  test("after Fo reports the email sent, Kiki follows exactly that conversation and no other", async (t) => {
    const rig = await askedDana(t);
    const read: string[] = [];
    const getConversation = rig.fo.getConversation.bind(rig.fo);
    rig.fo.getConversation = async (id) => {
      read.push(id);
      return getConversation(id);
    };
    rig.fo.conversations = [
      { conversationId: "conv-elsewhere", title: "Flooring chat", channel: "sms", startedAt: new Date().toISOString() },
      { conversationId: CONV, title: "Email to Dana", channel: "chat", startedAt: new Date().toISOString() },
    ];
    rig.fo.transcripts.set("conv-elsewhere", [fromFo('Dana replied: "Yes, that is the final quote."')]);
    foPosts(rig, fromFo(DANA_NO));

    assert.deepEqual(await checkWatch(rig.app.ctx, rig.watchId), { newTurns: 1 });
    assert.deepEqual(read, [CONV]);
    assert.deepEqual(
      (await rig.app.view()).updates.map((u) => u.message),
      [DANA_NO],
    );
  });

  test("re-reading the same turns creates one update, not one per poll", async (t) => {
    const rig = await askedDana(t);
    foPosts(rig, fromFo(DANA_NO));
    const found: number[] = [];
    for (let i = 0; i < 3; i++) found.push((await checkWatch(rig.app.ctx, rig.watchId)).newTurns);
    assert.deepEqual(found, [1, 0, 0]);
    assert.equal((await rig.app.view()).updates.length, 1);
  });

  test("your own turns and what Kiki already knows from the send aren't news", async (t) => {
    const rig = await askedDana(t);
    // The conversation already holds Kiki's request and Fo's "sent" answer, both known from the dispatch.
    foPosts(rig, fromUser("Thanks Fo, let me know when she answers."), fromFo(SENT.replace("\n", "\n\n")));
    assert.deepEqual(await checkWatch(rig.app.ctx, rig.watchId), { newTurns: 0 });
    assert.equal((await rig.app.view()).updates.length, 0);
  });

  test("each new message from Fo becomes exactly one update", async (t) => {
    const rig = await askedDana(t);
    const waiting = "Dana hasn't replied yet; I'll keep an eye out.";
    const added = 'Dana added: "The revised quote is attached to my email."';
    foPosts(rig, fromFo(waiting), fromFo(DANA_NO));
    assert.deepEqual(await checkWatch(rig.app.ctx, rig.watchId), { newTurns: 2 });
    foPosts(rig, fromUser("Great, thanks."), fromFo(added));
    assert.deepEqual(await checkWatch(rig.app.ctx, rig.watchId), { newTurns: 1 });
    assert.deepEqual(await checkWatch(rig.app.ctx, rig.watchId), { newTurns: 0 });
    assert.deepEqual((await rig.app.view()).updates.map((u) => u.message).sort(), [added, DANA_NO, waiting].sort());
  });

  test("after a restart Kiki keeps following the conversation without reading old turns as new", async (t) => {
    const db = tempDbPath();
    const rig = await askedDana(t, { db });
    foPosts(rig, fromFo(DANA_NO));
    assert.deepEqual(await checkWatch(rig.app.ctx, rig.watchId), { newTurns: 1 });
    rig.app.close();

    const restarted = makeRig({ db, drive: rig.drive, fo: rig.fo });
    restarted.app.ctx.watchIntervalSeconds = 3600;
    t.after(() => restarted.app.close());
    restarted.app.recover();
    await restarted.app.settle();
    const view = await restarted.app.view();
    const watch = view.outreach[0]?.dispatches[0]?.watch;
    assert.equal(watch?.state, "watching");
    assert.ok((watch?.checks ?? 0) >= 2, "the restarted app looked at the conversation again");
    assert.equal(view.updates.length, 1);
    assert.equal(rig.fo.asks.length, 1, "and sent Fo nothing");
  });
});

// 3. From the outcome to an organized workspace ---------------------------------------------

describe("from Fo's answer to an organized workspace", () => {
  test("the contractor's quoted answer becomes a proposal to file the revised quote and supersede the old one, with the price change", async (t) => {
    const rig = await askedDana(t);
    await rig.app.stageRevision("single");
    await rig.app.settle();
    const changesBefore = driveChanges(rig.drive).length;
    await foSays(rig, DANA_NO);

    const update = await latestUpdate(rig.app);
    assert.equal(update.status, "proposed");
    assert.equal(update.sourceLabel, "The contractor's reply, as quoted by Fo");
    assert.equal(update.quote, "No, use the revised quote I emailed today.");
    const plan = await versionPlan(rig.app);
    assert.equal(plan.id, update.planId);
    assert.equal(plan.status, "proposed");
    const moves = plan.ops.filter((o) => o.kind === "move_rename");
    assert.deepEqual(
      moves.map((o) => [o.before, o.after]),
      [
        [
          { name: R1_NAME, path: "" },
          { name: R1_FILED, path: QUOTES },
        ],
        [
          { name: OLD_NAME, path: QUOTES },
          { name: OLD_NAME, path: SUPERSEDED },
        ],
      ],
    );
    const statuses = plan.ops.filter((o) => o.kind === "set_status");
    assert.deepEqual(
      statuses.map((o) => o.title),
      ["Mark Oakline Flooring Co. Q-1042-R1 as current", "Mark Oakline Flooring Co. Q-1042 as superseded"],
    );
    assert.ok(statuses.every((s) => moves.every((m) => s.seq > m.seq)), "statuses come after the moves");
    assert.deepEqual(plan.diff?.total, { from: 8450, to: 7980, delta: -470 });
    assert.ok(plan.diff.lines.includes("Total: $8,450.00 to $7,980.00 (-$470.00)"));
    assert.ok(plan.diff.lines.some((l) => /7 inch planks.*5 inch planks/.test(l)), "the changed line item is shown");
    assert.ok(plan.diff.lines.includes("Removed: Underlay and trims ($400.00)"));
    assert.ok(plan.diff.lines.includes("Added: Remove and dispose of existing carpet ($350.00)"));
    assert.equal(plan.evidence?.source, "The contractor's reply, as quoted by Fo");
    assert.equal(plan.evidence.statement, "No, use the revised quote I emailed today.");

    // Nothing changes until you approve.
    assert.deepEqual(driveChanges(rig.drive).slice(changesBefore), []);
    assert.equal(rig.drive.pathOf(fileNamed(rig.drive, R1_NAME).id), `${ROOT}/${R1_NAME}`);
    assert.deepEqual(await quoteStatuses(rig.app), { "BF-77": "unresolved", "Q-1042": "unresolved", "Q-1042-R1": "unresolved" });
  });

  test("once approved, both quotes are moved and verified in Drive, and the index and the Drive index file follow", async (t) => {
    const rig = await revisionProposed(t);
    const plan = await approve(rig.app, rig.plan.id);
    assert.equal(plan.status, "applied");
    assert.ok(plan.ops.every((o) => o.state === "verified"));
    assert.equal(rig.drive.pathOf(fileNamed(rig.drive, R1_FILED).id), `${ROOT}/${QUOTES}/${R1_FILED}`);
    assert.equal(rig.drive.pathOf(fileNamed(rig.drive, OLD_NAME).id), `${ROOT}/${SUPERSEDED}/${OLD_NAME}`);
    const revised = await row(rig.app, "Q-1042-R1");
    const old = await row(rig.app, "Q-1042");
    assert.deepEqual([revised.status, revised.folder, revised.supersedes], ["current", QUOTES, "Oakline Flooring Co. Q-1042"]);
    assert.deepEqual([old.status, old.folder], ["superseded", SUPERSEDED]);
    assert.match(indexCsvLine(rig.drive, "Q-1042-R1"), /^quote,Current \(identified\),/);
    assert.match(indexCsvLine(rig.drive, ",Q-1042,"), /^quote,Superseded,.*,Projects\/Flooring\/Quotes\/Superseded,/);
    assert.equal((await latestUpdate(rig.app)).status, "resolved");
  });

  test("a quote is only marked superseded after its own move is verified", async (t) => {
    const rig = await revisionProposed(t);
    rig.drive.fail({ op: "update", fileId: fileNamed(rig.drive, OLD_NAME).id, mode: "error", error: permissionDenied() });
    const plan = await approve(rig.app, rig.plan.id);
    assert.equal(plan.status, "partial");
    assert.equal(plan.ops.find((o) => o.kind === "move_rename" && o.before?.name === OLD_NAME)?.state, "failed");
    assert.equal(plan.ops.find((o) => o.title === "Mark Oakline Flooring Co. Q-1042 as superseded")?.state, "skipped");
    const old = await row(rig.app, "Q-1042");
    assert.deepEqual([old.status, old.folder], ["unresolved", QUOTES]);
    assert.equal((await row(rig.app, "Q-1042-R1")).status, "current", "the revised quote's own move was verified");
  });

  test(
    "the old quote isn't marked superseded while the revised quote couldn't be filed",
    async (t) => {
      const rig = await revisionProposed(t);
      rig.drive.fail({ op: "update", fileId: fileNamed(rig.drive, R1_NAME).id, mode: "error", error: permissionDenied() });
      const plan = await approve(rig.app, rig.plan.id);
      assert.equal(plan.status, "partial");
      assert.equal((await row(rig.app, "Q-1042-R1")).status, "unresolved");
      assert.equal((await row(rig.app, "Q-1042")).status, "unresolved", "nothing is recorded as superseding it");
    },
  );

  test("with two possible revised quotes Kiki asks which one and doesn't guess; your choice becomes the proposal", async (t) => {
    const rig = await askedDana(t);
    await rig.app.stageRevision("ambiguous");
    await rig.app.settle();
    await foSays(rig, DANA_NO);

    const update = await latestUpdate(rig.app);
    assert.equal(update.status, "needs_clarification");
    assert.deepEqual(update.candidates.map((c) => c.reference).sort(), ["Q-1042-R1", "Q-1042-R2"]);
    assert.match(update.question ?? "", /2 documents could be the revised quote\. Which one did Dana mean\? Kiki won't guess\./);
    assert.equal(update.planId, null);
    assert.equal((await rig.app.view()).plans.some((p) => p.kind === "version_update"), false);
    assert.deepEqual(await quoteStatuses(rig.app), { "BF-77": "unresolved", "Q-1042": "unresolved", "Q-1042-R1": "unresolved", "Q-1042-R2": "unresolved" });

    const otherQuote = await row(rig.app, "BF-77");
    assert.throws(() => rig.app.resolveOutcome(update.id, otherQuote.docId), { status: 400 }, "only one of the listed candidates can be chosen");
    const second = update.candidates.find((c) => c.reference === "Q-1042-R2")!;
    rig.app.resolveOutcome(update.id, second.docId);
    const resolved = await latestUpdate(rig.app);
    assert.equal(resolved.status, "proposed");
    const plan = await versionPlan(rig.app);
    assert.equal(plan.id, resolved.planId);
    assert.deepEqual(
      plan.ops.filter((o) => o.kind === "move_rename").map((o) => [o.before?.name, o.after?.name, o.after?.path]),
      [
        ["Oakline quote rev 2.pdf", "2026-10-17 Revised quote - Oakline Flooring Co. - Q-1042-R2.pdf", QUOTES],
        [OLD_NAME, OLD_NAME, SUPERSEDED],
      ],
    );
    assert.deepEqual(plan.diff?.total, { from: 8450, to: 8120, delta: -330 });
  });

  test("when the revised quote isn't in the workspace, Kiki asks you to add it, then proposes once it's there", async (t) => {
    const rig = await askedDana(t);
    await foSays(rig, DANA_NO);
    let update = await latestUpdate(rig.app);
    assert.equal(update.status, "needs_clarification");
    assert.deepEqual(update.candidates, []);
    assert.match(update.question ?? "", /couldn't find the revised quote in the folder/);
    assert.match(update.question ?? "", /save the attachment from Dana's email into the folder/);
    assert.equal((await rig.app.view()).plans.some((p) => p.kind === "version_update"), false);

    // She notices it arriving by herself; no "Check again" needed.
    await rig.app.stageRevision("single");
    await rig.app.settle();
    update = await latestUpdate(rig.app);
    assert.equal(update.status, "proposed");
    assert.equal((await versionPlan(rig.app)).ops.find((o) => o.kind === "move_rename")?.after?.name, R1_FILED);
  });

  test("a reply you paste in is labelled as pasted, and pasting it twice records it once", async (t) => {
    const rig = await askedDana(t);
    await rig.app.stageRevision("single");
    await rig.app.settle();
    const { updateId } = rig.app.pasteReply(rig.watchId, "No, use the revised quote I emailed today.");
    assert.equal(rig.app.pasteReply(rig.watchId, "  No, use the revised quote I emailed today. ").updateId, updateId);
    await rig.app.settle();

    const view = await rig.app.view();
    assert.equal(view.updates.length, 1);
    const update = view.updates[0]!;
    assert.equal(update.source, "pasted_by_user");
    assert.equal(update.sourceLabel, "Reply you pasted in");
    const plan = await versionPlan(rig.app);
    assert.equal(plan.evidence?.source, "Reply you pasted in");
    assert.equal(plan.evidence.sourceKind, "pasted_by_user");
  });

  test("Fo's paraphrase without the contractor's own words is labelled as Fo's summary", async (t) => {
    const rig = await askedDana(t);
    await rig.app.stageRevision("single");
    await rig.app.settle();
    await foSays(rig, "Dana replied that it isn't the final quote and that you should use the revised quote she emailed today.");

    const update = await latestUpdate(rig.app);
    assert.equal(update.sourceLabel, "Fo's summary (the contractor's own words weren't included)");
    assert.equal(update.quote, null);
    const plan = await versionPlan(rig.app);
    assert.equal(plan.evidence?.source, update.sourceLabel);
    assert.equal(plan.evidence.sourceKind, "fo_summary");
    assert.ok(plan.ops.some((o) => o.reason.includes("Fo's summary (the contractor's own words weren't included)")));
  });

  test("a contractor quote the interpreter can't find in Fo's message is downgraded to Fo's summary", () => {
    const message = "Dana replied that the old quote is out of date.";
    const claimed: Outcome = {
      relevant: true,
      source_kind: "quoted_reply",
      speaker: "Dana",
      statement: "The contractor says to use a revised quote instead.",
      verbatim_quote: "Use the revised quote.",
      asked_document_is_final: "no",
      points_to_newer_version: true,
      newer_version_hint: null,
      question_for_user: null,
      requests_to_ignore: [],
    };
    const checked = verifyOutcome(message, claimed);
    assert.equal(checked.source_kind, "fo_summary");
    assert.equal(checked.verbatim_quote, null);
    assert.equal(sourceLabel(checked, "fo_conversation"), "Fo's summary (the contractor's own words weren't included)");
  });

  test(
    "the same answer relayed again or pasted in doesn't create a second identical proposal",
    async (t) => {
      const rig = await revisionProposed(t);
      await foSays(rig, 'To recap, Dana said: "No, use the revised quote I emailed today."');
      rig.app.pasteReply(rig.watchId, "No, use the revised quote I emailed today.");
      await rig.app.settle();
      const open = (await rig.app.view()).plans.filter((p) => p.kind === "version_update" && p.status === "proposed");
      assert.equal(open.length, 1);
    },
  );

  test(
    "after the version update files the revised quote, no other proposal still offers to file it",
    async (t) => {
      const rig = await revisionProposed(t);
      assert.equal((await approve(rig.app, rig.plan.id)).status, "applied");
      rig.app.refreshInventory();
      await rig.app.settle();
      const stillOffered = (await rig.app.view()).plans.filter((p) => p.status === "proposed" && p.ops.some((o) => o.kind === "move_rename" && o.before?.name === R1_NAME));
      assert.deepEqual(
        stillOffered.map((p) => p.title),
        [],
      );
    },
  );

  test(
    "the version update still rewrites the Drive index when another approved proposal filed the revised quote first",
    async (t) => {
      const rig = await revisionProposed(t);
      // The revised quote itself is held for the update; but a new invoice arriving meanwhile gets
      // its own proposal, which rewrites the same index, and is approved first.
      await rig.app.stageRevision("invoice");
      await rig.app.settle();
      const fileIt = (await rig.app.view()).plans.find((p) => p.kind === "organize" && p.status === "proposed");
      assert.ok(fileIt, "Kiki proposed filing the new invoice");
      assert.ok(fileIt.ops.some((o) => o.kind === "write_index"), "which rewrites the index");
      assert.equal(fileIt.ops.some((o) => o.before?.name === R1_NAME), false, "the revised quote stays with the update");
      assert.equal((await approve(rig.app, fileIt.id)).status, "applied");
      const plan = await approve(rig.app, rig.plan.id);
      assert.equal(plan.status, "applied");
      assert.match(indexCsvLine(rig.drive, "Q-1042-R1"), /^quote,Current \(identified\),/);
      assert.match(indexCsvLine(rig.drive, ",Q-1042,"), /^quote,Superseded,/);
    },
  );
});

// 4. What Fo reports versus what's verified in Drive ----------------------------------------

describe("Fo's report versus what's verified in Drive", () => {
  test("Fo reporting the email sent, even claiming it filed things, changes nothing in the index or in Drive", async (t) => {
    const rig = await readyToAsk(t);
    await rig.app.stageRevision("single");
    await rig.app.settle();
    const changesBefore = driveChanges(rig.drive).length;
    const { versionId } = rig.app.createOutreachDraft(rig.quoteId, DANA);
    const { contentHash } = await currentDraft(rig.app, rig.quoteId);
    rig.fo.onAsk = async () => reply(CONV, "complete", { response: "Done: I emailed Dana, filed the revised quote and marked it as the current one.\nKIKI-STATUS: SENT" });
    rig.app.approveAndSend(versionId, { contentHash, clientRequestId: "send-1" });
    await rig.app.settle();

    const view = await rig.app.view();
    assert.equal(view.outreach[0]?.dispatches[0]?.state, "reported_sent");
    assert.deepEqual(await quoteStatuses(rig.app), { "BF-77": "unresolved", "Q-1042": "unresolved", "Q-1042-R1": "unresolved" });
    assert.deepEqual(driveChanges(rig.drive).slice(changesBefore), []);
    assert.equal(rig.drive.pathOf(fileNamed(rig.drive, R1_NAME).id), `${ROOT}/${R1_NAME}`);
    assert.ok(view.activity.events.some((e) => /reports the email .* was sent\. Not independently verified\./.test(e.message)));
  });

  test("only the applied version update makes the revised quote current", async (t) => {
    const rig = await askedDana(t);
    await rig.app.stageRevision("single");
    await rig.app.settle();
    assert.deepEqual(await currentQuotes(rig.app), [], "Fo reporting the email sent marks nothing current");
    await foSays(rig, DANA_NO);
    assert.deepEqual(await currentQuotes(rig.app), [], "a proposal marks nothing current");
    assert.equal((await approve(rig.app, (await versionPlan(rig.app)).id)).status, "applied");
    assert.deepEqual(await currentQuotes(rig.app), ["Q-1042-R1"]);
    assert.ok((await indexRows(rig.app)).every((r) => r.acceptedAt === null), "and no price was accepted");
  });

  test("a contractor calling the quote final records it as current, never as accepted; accepting is your own step", async (t) => {
    const rig = await askedDana(t);
    await foSays(rig, `Dana replied: "Yes, that's the final quote."`);
    const plan = await versionPlan(rig.app);
    assert.match(plan.summary, /doesn't accept its price/);
    assert.deepEqual(
      plan.ops.map((o) => o.kind),
      ["set_status", "write_index"],
    );
    assert.equal((await approve(rig.app, plan.id)).status, "applied");

    let quote = await row(rig.app, "Q-1042");
    assert.equal(quote.status, "current");
    assert.equal(quote.acceptedAt, null);
    assert.match(indexCsvLine(rig.drive, ",Q-1042,"), /^quote,Current \(identified\),Oakline Flooring Co\.,Q-1042,2026-09-28,"\$8,450\.00",,/, "the Drive index doesn't say accepted either");

    rig.app.acceptQuote(quote.docId, true);
    quote = await row(rig.app, "Q-1042");
    assert.ok(quote.acceptedAt, "accepted only when you say so");
    assert.equal(quote.status, "current");
    rig.app.acceptQuote(quote.docId, false);
    assert.equal((await row(rig.app, "Q-1042")).acceptedAt, null);
    const invoice = await row(rig.app, "INV-3307");
    assert.throws(() => rig.app.acceptQuote(invoice.docId, true), { status: 404 }, "only a quote's price can be accepted");
  });
});

// 5. Texts to the account holder -------------------------------------------------------------

describe("texts to the account holder through Fo", () => {
  test("with texts on, a new proposal is texted to you once, and only to you", async (t) => {
    const rig = foRig(t);
    rig.fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: TEXTED });
    await organized(rig);
    assert.equal(rig.fo.asks.length, 0, "no texts until you turn them on");
    rig.app.updateSettings({ autoText: true });
    await rig.app.stageRevision("invoice");
    await rig.app.settle();

    assert.match(texts(rig.fo)[0]!, /Northside Building Supply/);
    assert.match(texts(rig.fo)[0]!, /N-5602/, "the new name is in the text");
    assert.match(rig.fo.asks[0]!.message, /The exact proposal this text is about/, "and every step is with Fo");
    const ask = rig.fo.asks[0]!;
    assert.equal(ask.newConversation, true);
    assert.match(ask.message, /^Please text me \(an SMS to my phone, nobody else\) this exact message:/);
    assert.match(ask.message, /Don't contact anyone else/);
    assert.match(ask.message, /Please don't move or change any files yourself/);
    const [note] = (await rig.app.view()).notifications;
    assert.equal(note?.purpose, "find");
    assert.deepEqual(note.reply, { status: "waiting", text: null, source: null });

    rig.app.refreshInventory();
    await rig.app.settle();
    assert.equal(texts(rig.fo).length, 1, "Kiki looking again with nothing new doesn't text again");
  });

  test("a proposal is texted once, even when Kiki re-saves it after your edit", async (t) => {
    const rig = await textedAboutInvoice(t);
    const move = rig.plan.ops.find((o) => o.kind === "move_rename")!;
    rig.app.revisePlan(rig.plan.id, [{ seq: move.seq, newName: "Northside levelling compound" }]);
    rig.app.refreshInventory();
    await rig.app.settle();
    assert.equal((await rig.app.view()).plans.filter((p) => p.status === "proposed").length, 1);
    assert.equal(texts(rig.fo).length, 1);
  });

  test(
    "Kiki's next look at the folder keeps the proposal you edited",
    async (t) => {
      const rig = await textedAboutInvoice(t);
      const move = rig.plan.ops.find((o) => o.kind === "move_rename")!;
      const { planId: edited } = rig.app.revisePlan(rig.plan.id, [{ seq: move.seq, newName: "Northside levelling compound" }]);
      rig.app.refreshInventory();
      await rig.app.settle();
      const open = (await rig.app.view()).plans.find((p) => p.status === "proposed");
      assert.equal(open?.id, edited);
      assert.equal(open.ops.find((o) => o.kind === "move_rename")?.after?.name, "Northside levelling compound.pdf");
    },
  );

  test("after the texted plan fails in Drive, Kiki doesn't re-propose or text about it again", async (t) => {
    const rig = await textedAboutInvoice(t);
    rig.drive.fail({ op: "update", fileId: fileNamed(rig.drive, INVOICE_NAME).id, mode: "error", error: permissionDenied() });
    assert.equal((await approve(rig.app, rig.plan.id)).status, "failed");
    rig.app.refreshInventory();
    await rig.app.settle();
    assert.equal((await rig.app.view()).plans.some((p) => p.status === "proposed"), false);
    assert.equal(texts(rig.fo).length, 1);
  });

  test("a text that couldn't be sent isn't re-sent behind your back", async (t) => {
    const rig = foRig(t);
    rig.fo.onAsk = async () => {
      throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
    };
    await organized(rig);
    rig.app.updateSettings({ autoText: true });
    await rig.app.stageRevision("invoice");
    await rig.app.settle();
    assert.equal((await rig.app.view()).notifications[0]?.state, "failed");
    rig.app.refreshInventory();
    await rig.app.settle();
    assert.equal(rig.fo.asks.length, 1);
    assert.equal((await rig.app.view()).notifications.length, 1);
  });

  test("answering 'go ahead' in Kiki after Fo's text approves exactly the plan that was texted", async (t) => {
    const rig = await textedAboutInvoice(t);
    await youAnswerInKiki(rig, "Go ahead");

    assert.deepEqual(await replyTo(rig), { status: "approved", text: "Go ahead", source: "relayed_by_fo" });
    assert.deepEqual(
      all<{ plan_id: string; content_hash: string }>(rig.db, "SELECT plan_id, content_hash FROM plan_approvals WHERE plan_id = ?", rig.plan.id).map((a) => [a.plan_id, a.content_hash]),
      [[rig.plan.id, rig.plan.contentHash]],
    );
    assert.equal(rig.fo.asks.length, 3, "the text, your answer relayed on the same conversation, then the 'done' text");
    assert.equal(rig.fo.asks[1]!.conversationId, "kiki-1");
    assert.match(rig.fo.asks[2]!.message, /Kiki: done/);
    assert.equal(await planStatus(rig.app, rig.plan.id), "applied");
    assert.equal(rig.drive.pathOf(fileNamed(rig.drive, INVOICE_FILED).id), `${ROOT}/Projects/Flooring/Invoices/${INVOICE_FILED}`);
  });

  test("a plan you approved by answering Fo's text gets one 'done' text once it's verified in Drive", async (t) => {
    const rig = await textedAboutInvoice(t);
    await youAnswerInKiki(rig, "go ahead");
    assert.deepEqual(texts(rig.fo).slice(1), [`Kiki: done ✓ "Northside invoice Oct 17" is in Flooring › Invoices.`]);

    sendDoneText(rig.app.ctx, rig.plan.id); // e.g. the execute job running again
    await checkTextReply(rig.app.ctx, rig.note.taskId);
    await rig.app.settle();
    assert.equal(texts(rig.fo).length, 2);
    assert.deepEqual((await rig.app.view()).notifications.map((n) => n.purpose).sort(), ["done", "find"]);
  });

  test("a plan you approve in the app gets no 'done' text, and a later 'go ahead' approves nothing", async (t) => {
    const rig = await textedAboutInvoice(t);
    assert.equal((await approve(rig.app, rig.plan.id)).status, "applied");
    assert.equal(texts(rig.fo).length, 1);
    youTextBack(rig, "go ahead");
    await checkTextReply(rig.app.ctx, rig.note.taskId);
    assert.equal((await replyTo(rig))?.status, "stale");
  });

  test("a reply after the plan changed is stale and approves nothing", async (t) => {
    const rig = await textedAboutInvoice(t);
    const move = rig.plan.ops.find((o) => o.kind === "move_rename")!;
    const { planId: edited } = rig.app.revisePlan(rig.plan.id, [{ seq: move.seq, newName: "Northside levelling compound" }]);
    youTextBack(rig, "go ahead");
    await checkTextReply(rig.app.ctx, rig.note.taskId);

    assert.equal((await replyTo(rig))?.status, "stale");
    const view = await rig.app.view();
    assert.equal(view.plans.find((p) => p.id === edited)?.status, "proposed");
    assert.equal(view.plans.some((p) => ["approved", "executing"].includes(p.status)), false);
    assert.equal(rig.drive.pathOf(fileNamed(rig.drive, INVOICE_NAME).id), `${ROOT}/${INVOICE_NAME}`);
  });

  test("answering 'no, wait' declines: nothing is approved or filed", async (t) => {
    const rig = await textedAboutInvoice(t);
    await youAnswerInKiki(rig, "No, wait");
    assert.deepEqual(await replyTo(rig), { status: "declined", text: "No, wait", source: "relayed_by_fo" });
    assert.equal(await planStatus(rig.app, rig.plan.id), "proposed");

    youTextBack(rig, "ok go ahead");
    await checkTextReply(rig.app.ctx, rig.note.taskId);
    assert.equal((await replyTo(rig))?.status, "declined", "once declined, approving happens in the app");
    assert.equal(await planStatus(rig.app, rig.plan.id), "proposed");
    assert.equal(rig.drive.pathOf(fileNamed(rig.drive, INVOICE_NAME).id), `${ROOT}/${INVOICE_NAME}`);
  });

  test(
    "Fo restating the 'go ahead' instruction isn't taken as your reply",
    async (t) => {
      const ack = `Texted you Kiki's message. You said you may text back "go ahead"; if you do, I'll leave the filing to Kiki.\nKIKI-STATUS: SENT`;
      const rig = await textedAboutInvoice(t, ack);
      // Kiki's own conversation with Fo holds her request and Fo's acknowledgement. You haven't replied.
      rig.fo.transcripts.set("kiki-1", [fromUser(rig.fo.asks[0]!.message), fromFo(ack)]);
      await checkTextReply(rig.app.ctx, rig.note.taskId);
      assert.equal((await replyTo(rig))?.status, "waiting");
      assert.equal(await planStatus(rig.app, rig.plan.id), "proposed");
    },
  );

});
