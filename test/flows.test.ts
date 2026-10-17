import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../server/errors.ts";
import { insertTask } from "../server/fo/engine.ts";
import { FoCallError } from "../server/fo/types.ts";
import { one } from "../server/db.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { MockExtractor } from "../server/extractor.ts";
import { FakeFo, deferred, makeApp, outreach, readyDraft, readyRequest, reply, tempDbPath } from "./helpers.ts";

const SENT = "Done, I sent it.\nPAPER-CHASE-STATUS: SENT";

function rejectsWith(fn: () => unknown, status: number, code?: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.status, status);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

test("duplicate approve-and-send requests create one dispatch and one ask_fo", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => reply("c1", "complete", { response: SENT });
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);

  // A burst of clicks: different idempotency keys, plus a retried request with the same key.
  const results = ["k1", "k2", "k3", "k1", "k4"].map((k) => app.approveAndSend(versionId, { contentHash, clientRequestId: k }));
  await app.whenIdle();

  assert.equal(new Set(results.map((r) => r.dispatchId)).size, 1);
  assert.deepEqual(results.map((r) => r.created), [true, false, false, false, false]);
  assert.equal(fo.asks.length, 1);
  assert.equal(fo.asks[0]!.newConversation, true);
  const o = await outreach(app, requestId);
  assert.equal(o.dispatches.length, 1);
  assert.equal(o.dispatches[0]!.state, "reported_sent");

  // Once sent, a fresh click needs explicit confirmation, so a stale tab can't resend by accident.
  rejectsWith(() => app.approveAndSend(versionId, { contentHash, clientRequestId: "k5" }), 409, "already_sent");
  assert.equal(fo.asks.length, 1);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k6", confirmResend: true });
  await app.whenIdle();
  assert.equal(fo.asks.length, 2);
  assert.equal((await outreach(app, requestId)).dispatches.length, 2);
});

test("editing the draft invalidates the earlier approval", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => reply("c1", "complete", { response: SENT });
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);

  const { versionId: v2 } = app.reviseDraft(versionId, { recipientEmail: "mom.new@example.com" });
  assert.notEqual(v2, versionId);
  rejectsWith(() => app.approveAndSend(versionId, { contentHash, clientRequestId: "a" }), 409, "stale_draft");
  rejectsWith(() => app.approveAndSend(v2, { contentHash, clientRequestId: "b" }), 409, "hash_mismatch");
  rejectsWith(() => app.reviseDraft(versionId, { body: "edit from a stale tab" }), 409, "stale_draft");
  assert.equal(fo.asks.length, 0);

  const o = await outreach(app, requestId);
  assert.equal(o.draft!.version, 2);
  assert.equal(o.draft!.recipientEmail, "mom.new@example.com");
  app.approveAndSend(v2, { contentHash: o.draft!.contentHash, clientRequestId: "c" });
  await app.whenIdle();
  assert.equal(fo.asks.length, 1);
  assert.match(fo.asks[0]!.message, /To: Mom <mom\.new@example\.com>/);
});

test("working, then a question from Fo, then the user's continuation", async () => {
  const fo = new FakeFo();
  const question = deferred<void>();
  fo.onAsk = async (args, n) => {
    if (n === 1) return reply("c1", "working", { progress: "Drafting the email", elapsedSeconds: 3 });
    assert.equal(args.conversationId, "c1");
    assert.equal(args.newConversation, undefined);
    return reply("c1", "complete", { response: SENT });
  };
  fo.onPoll = async (_args, n) => {
    if (n === 1) {
      await question.promise;
      return reply("c1", "working", { progress: "Waiting for your answer: send from your school or personal account?" });
    }
    throw new Error("should not poll again");
  };
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k" });

  // While Fo is working, nothing may be sent into that turn.
  await new Promise((r) => setTimeout(r, 10));
  let d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "working");
  rejectsWith(() => app.reply(d.task.taskId, "too early"), 409);

  question.resolve();
  await app.whenIdle();
  d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "needs_user_input");
  assert.match(d.task.question!, /school or personal/);
  assert.equal((await app.view(requestId)).kiki.state, "needs_you");

  app.reply(d.task.taskId, "Personal, please.");
  rejectsWith(() => app.reply(d.task.taskId, "double submit"), 409);
  await app.whenIdle();

  assert.equal(fo.asks.length, 2);
  assert.match(fo.asks[1]!.message, /Personal, please\./);
  assert.match(fo.asks[1]!.message, /approval covers only sending the exact email/);
  d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "reported_sent");
});

test("malformed Fo output never becomes found, missing or sent", async (t) => {
  await t.test("inventory reply that isn't JSON: every item needs review", async () => {
    const fo = new FakeFo();
    fo.onAsk = async () => reply("c1", "complete", { response: "Found lots of stuff!! {items: [oops" });
    const app = makeApp(fo);
    const { requestId } = await readyRequest(app);
    app.startInventory(requestId, "inv");
    await app.whenIdle();
    const view = (await app.view(requestId)).current!;
    assert.equal(view.inventory!.parseStatus, "malformed");
    assert.equal(view.inventory!.task.finalResponse, "Found lots of stuff!! {items: [oops");
    for (const item of view.items) {
      // The guarantor letter was marked missing by the user before the search; the reply can't confirm anything.
      assert.ok(["needs_review"].includes(item.status), `${item.label} is ${item.status}`);
    }
  });

  await t.test("partial inventory reply: unmentioned items need review, non-Drive links are dropped", async () => {
    const fo = new FakeFo();
    fo.onAsk = async (args) => {
      const refs = [...args.message.matchAll(/^(C\d+)\. (.+)$/gm)].map((m) => ({ id: m[1]!, label: m[2]! }));
      const id = refs.find((r) => /photo id/i.test(r.label))!.id;
      const items = [
        { id, status: "found", files: [{ name: "passport.pdf", link: "https://evil.example/drive/passport" }] },
        { id: "C99", status: "found", files: [{ name: "x.pdf" }] },
      ];
      return reply("c1", "complete", { response: "```json\n" + JSON.stringify({ items }) + "\n```" });
    };
    const app = makeApp(fo);
    const { requestId } = await readyRequest(app);
    app.startInventory(requestId, "inv");
    await app.whenIdle();
    const view = (await app.view(requestId)).current!;
    assert.equal(view.inventory!.parseStatus, "partial");
    const photo = view.items.find((i) => /photo id/i.test(i.label))!;
    assert.equal(photo.status, "candidate");
    assert.equal(photo.candidates[0]!.link, null);
    assert.match(photo.candidates[0]!.linkNote!, /isn't Google Drive/);
    for (const item of view.items.filter((i) => i.id !== photo.id)) assert.equal(item.status, "needs_review", item.label);
  });

  await t.test("dispatch reply with no status line is treated as a question, not a send", async () => {
    const fo = new FakeFo();
    fo.onAsk = async () => reply("c1", "complete", { response: "All taken care of." });
    const app = makeApp(fo);
    const { requestId, versionId, contentHash } = await readyDraft(app);
    app.approveAndSend(versionId, { contentHash, clientRequestId: "k" });
    await app.whenIdle();
    const d = (await outreach(app, requestId)).dispatches[0]!;
    assert.equal(d.state, "needs_user_input");
    assert.equal(d.open, true);
    assert.match(d.task.question!, /without saying whether the email went out/);
  });

  await t.test("a response that doesn't match Fo's schema leaves the outcome uncertain", async () => {
    const fo = new FakeFo();
    fo.onAsk = async () => {
      throw new FoCallError("Fo's response wasn't in the documented format.", "unknown", "malformed");
    };
    const app = makeApp(fo);
    const { requestId, versionId, contentHash } = await readyDraft(app);
    app.approveAndSend(versionId, { contentHash, clientRequestId: "k" });
    await app.whenIdle();
    assert.equal((await outreach(app, requestId)).dispatches[0]!.state, "uncertain");
  });
});

test("an ambiguous timeout is uncertain, blocks a new send, and is reconciled read-only", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => {
    throw new FoCallError("Timed out waiting for Fo's response.", "unknown", "timeout");
  };
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await app.whenIdle();

  let d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "uncertain");
  assert.equal(d.task.failureKind, "lost_response");
  assert.equal((await app.view(requestId)).kiki.state, "alert");

  // Never resent automatically, and a new click returns the same unresolved attempt.
  const again = app.approveAndSend(versionId, { contentHash, clientRequestId: "k2" });
  assert.equal(again.created, false);
  assert.equal(again.dispatchId, d.id);
  rejectsWith(() => app.retireDispatch(d.id, true), 409);
  assert.equal(fo.asks.length, 1);

  // Reconciliation finds the conversation by the reference code and reads its status.
  fo.conversations = [{ conversationId: "c7", title: "Paper Chase", channel: "chat", startedAt: new Date().toISOString() }];
  fo.transcripts.set("c7", [{ role: "user", text: fo.asks[0]!.message }]);
  fo.onPoll = async (args) => {
    assert.equal(args.conversationId, "c7");
    assert.equal(args.waitSeconds, 0);
    return reply("c7", "complete", { response: SENT });
  };
  const result = await app.reconcileDispatch(d.id);
  assert.equal(result.found, true);
  d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "reported_sent");
  assert.equal(fo.asks.length, 1);
});

test("an uncertain attempt that can't be found may be closed only with acknowledgement", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => {
    throw new FoCallError("Lost contact with Fo during the request.", "unknown", "other");
  };
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await app.whenIdle();
  const d = (await outreach(app, requestId)).dispatches[0]!;

  const result = await app.reconcileDispatch(d.id);
  assert.equal(result.found, false);
  assert.match(result.note, /may have reached Fo|still may have reached Fo/);
  rejectsWith(() => app.retireDispatch(d.id, false), 400);
  app.retireDispatch(d.id, true);
  assert.equal((await outreach(app, requestId)).dispatches[0]!.state, "retired");

  // A new attempt now needs explicit confirmation that a second email may go out.
  fo.onAsk = async () => reply("c2", "complete", { response: SENT });
  rejectsWith(() => app.approveAndSend(versionId, { contentHash, clientRequestId: "k2" }), 409, "already_sent");
  const retry = app.approveAndSend(versionId, { contentHash, clientRequestId: "k3", confirmResend: true });
  assert.equal(retry.created, true);
  await app.whenIdle();
  const all = (await outreach(app, requestId)).dispatches;
  assert.deepEqual(all.map((x) => [x.attempt, x.state]), [[1, "retired"], [2, "reported_sent"]]);
});

test("a request that provably never reached Fo fails cleanly and can be retried", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => {
    throw new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
  };
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await app.whenIdle();
  let d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "failed");
  assert.equal(d.open, false);
  assert.equal(d.task.failureKind, "not_sent");

  fo.onAsk = async () => reply("c1", "complete", { response: SENT });
  const retry = app.approveAndSend(versionId, { contentHash, clientRequestId: "k2" });
  assert.equal(retry.created, true);
  await app.whenIdle();
  d = (await outreach(app, requestId)).dispatches[1]!;
  assert.equal(d.state, "reported_sent");
});

test("restart: interrupted asks become uncertain, working tasks resume, nothing is resent", async () => {
  const file = tempDbPath();
  const fo1 = new FakeFo();
  fo1.onAsk = (args) =>
    /read-only document check/.test(args.message) ? Promise.resolve(reply("c-inv", "working", { progress: "Searching" })) : new Promise(() => {});
  fo1.onPoll = () => new Promise(() => {});
  const app1 = makeApp(fo1, file);
  const { requestId, versionId, contentHash } = await readyDraft(app1);
  app1.startInventory(requestId, "inv");
  app1.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await new Promise((r) => setTimeout(r, 20));
  const before = (await app1.view(requestId)).current!;
  assert.equal(before.outreach[0]!.dispatches[0]!.state, "dispatching");
  assert.equal(before.inventory!.task.state, "working");
  const orphan = insertTask(app1.db, "dispatch", "live");
  // The process dies here.
  app1.close();
  app1.db.close();

  const fo2 = new FakeFo();
  fo2.onAsk = async () => {
    throw new Error("must not resend");
  };
  fo2.onPoll = async (args) => {
    assert.equal(args.conversationId, "c-inv");
    return reply("c-inv", "complete", { response: '```json\n{"items":[]}\n```' });
  };
  const app2 = makeApp(fo2, file);
  app2.recover();
  await app2.whenIdle();

  const after = (await app2.view(requestId)).current!;
  const d = after.outreach[0]!.dispatches[0]!;
  assert.equal(d.state, "uncertain");
  assert.equal(d.task.failureKind, "interrupted");
  assert.equal(fo2.asks.length, 0);
  assert.equal(fo2.polls.length, 1);
  assert.equal(after.inventory!.task.state, "complete");
  assert.equal(one<{ state: string }>(app2.db, "SELECT state FROM fo_tasks WHERE id = ?", orphan)!.state, "failed");
  assert.equal((await app2.view(requestId)).kiki.state, "alert");
  app2.close();
});

test("a suspicious request holds sending until reviewed, and review keeps the signals", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => reply("c1", "complete", { response: SENT });
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app, "suspicious");

  let view = (await app.view(requestId)).current!;
  assert.equal(view.risk!.hasWarnings, true);
  assert.equal(view.risk!.summary, "Needs review: sharing on hold.");
  rejectsWith(() => app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" }), 423, "risk_hold");
  rejectsWith(() => app.reviewRisk(requestId, { acknowledge: false }), 400);
  assert.equal(fo.asks.length, 0);

  const signalsBefore = view.risk!.signals.map((s) => s.id);
  app.reviewRisk(requestId, { acknowledge: true, note: "Called the office." });
  view = (await app.view(requestId)).current!;
  assert.equal(view.risk!.hasWarnings, true);
  assert.deepEqual(view.risk!.signals.map((s) => s.id), signalsBefore);
  assert.ok(view.risk!.reviewedAt);

  app.approveAndSend(versionId, { contentHash, clientRequestId: "k2" });
  await app.whenIdle();
  assert.equal(fo.asks.length, 1);
  assert.equal(one<{ n: number }>(app.db, "SELECT risk_review_acknowledged AS n FROM approvals")!.n, 1);

  // A different baseline produces different signals, so the earlier review no longer applies.
  app.setTrustedDomain(requestId, "someotherlandlord.example");
  view = (await app.view(requestId)).current!;
  assert.equal(view.risk!.reviewedAt, null);
});

test("Fo's question can be answered by calling the email off", async () => {
  const fo = new FakeFo();
  fo.onAsk = async (args, n) =>
    n === 1
      ? reply("c1", "complete", { response: "Should I CC your dad too?\nPAPER-CHASE-STATUS: NEED-INPUT" })
      : reply("c1", "complete", { response: /don't send the email/.test(args.message) ? "Okay, not sending.\nPAPER-CHASE-STATUS: NOT-SENT" : SENT });
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await app.whenIdle();
  let d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "needs_user_input");
  assert.equal(d.task.question, "Should I CC your dad too?");
  app.stopDispatch(d.id);
  await app.whenIdle();
  d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "not_sent");
  assert.equal(d.stopRequested, true);
  assert.equal(d.open, false);
});

test("polling errors never change the outcome; a lost sign-in pauses until the user resumes", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => reply("c1", "working", { progress: "Sending" });
  fo.onPoll = async (_a, n) => {
    if (n === 1) throw new Error("socket hang up");
    if (n === 2) throw new FoCallError("Fo isn't connected.", "not_sent", "not_connected");
    return reply("c1", "complete", { response: SENT });
  };
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await app.whenIdle();
  let d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "working");
  assert.equal(d.task.pollPaused, true);
  assert.match(d.task.pollError!, /isn't connected/);

  app.keepWaiting(d.task.taskId);
  await app.whenIdle();
  d = (await outreach(app, requestId)).dispatches[0]!;
  assert.equal(d.state, "reported_sent");
  assert.equal(fo.asks.length, 1);
});

test("a long-running turn pauses polling and tells the user Fo keeps working", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => reply("c1", "working", { progress: "Still drafting" });
  fo.onPoll = async () => reply("c1", "working", { progress: "Still drafting" });
  const db = openDb(":memory:");
  const app = createApp({
    db,
    fo,
    extractor: new MockExtractor(),
    anthropicModel: "test-model",
    claudeCredentialsDetected: false,
    engineOptions: { pollWaitSeconds: 0, backoffBaseMs: 1, maxWorkingMs: 0 },
  });
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await app.whenIdle();
  const view = await app.view(requestId);
  const d = view.current!.outreach[0]!.dispatches[0]!;
  assert.equal(d.state, "working");
  assert.equal(d.task.pollPaused, true);
  assert.match(view.kiki.label, /keeps working even if you leave/);
});

test("Fo's own failure status closes the attempt without claiming anything was sent", async () => {
  const fo = new FakeFo();
  fo.onAsk = async () => reply("c1", "failed", { response: "Your email account isn't connected to Fo." });
  const app = makeApp(fo);
  const { requestId, versionId, contentHash } = await readyDraft(app);
  app.approveAndSend(versionId, { contentHash, clientRequestId: "k1" });
  await app.whenIdle();
  const view = await app.view(requestId);
  const d = view.current!.outreach[0]!.dispatches[0]!;
  assert.equal(d.state, "failed");
  assert.equal(d.task.failureKind, "fo_failed");
  assert.equal(view.kiki.state, "error");
});
