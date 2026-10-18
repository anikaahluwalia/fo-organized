// Fo's webhook: Wajo posts a signed event when Fo answers a text of yours, in whatever conversation
// it landed. Kiki then has Fo read it for the proposal waiting on you. Unsigned posts do nothing.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import { loadConfig } from "../server/config.ts";
import { one, run } from "../server/db.ts";
import { createHttpServer } from "../server/http.ts";
import { verifyFoWebhook } from "../server/services/fowebhook.ts";
import { replyState } from "../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply } from "./helpers.ts";

const PUBLIC = "https://kiki-test.example";
const SECRET = "whsec_" + randomBytes(24).toString("base64");
const TEXTED = "Texted you.\nKIKI-STATUS: SENT";

function sign(id: string, timestamp: number, body: string, secret = SECRET): string {
  return "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
}

function post(port: number, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/hooks/fo", headers: { host: new URL(PUBLIC).host, "content-type": "application/json", ...headers }, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function setup(t: TestContext, secret: string | null = SECRET) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  rig.app.ctx.publicUrl = PUBLIC;
  rig.app.ctx.foWebhook = secret !== null;
  t.after(() => rig.app.close());
  fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: TEXTED });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const note = (await rig.app.view()).notifications.find((n) => n.purpose === "find")!;
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const server = createHttpServer(rig.app, { ...loadConfig({ PORT: String(port), KIKI_MODE: "mock" }), publicUrl: PUBLIC, foWebhookSecret: secret }, { google: null, fo: null }, "/nonexistent");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  const state = replyState(rig.app.ctx, note.taskId)!;
  return { rig, fo, note, port, state };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** You text Fo `words` in an old iMessage thread; Fo, asked by Kiki, reports `decision` quoting them. */
function foReads(s: Setup, words: string, decision = "approved") {
  s.fo.onAsk = async (args) =>
    args.conversationId === "kiki-1" && args.message.includes("answered this by text")
      ? reply("kiki-1", "complete", { response: "KIKI-DECISION: " + JSON.stringify({ requestId: s.state.requestId, planId: s.state.planId, contentHash: s.state.contentHash, decision, userReply: words, actor: "account_holder", presentedExactProposal: true }) })
      : reply("kiki-other", "complete", { response: TEXTED });
}

function textEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_" + randomBytes(6).toString("hex"),
    type: "conversation.reply",
    occurredAt: new Date(Date.now() + 1000).toISOString(),
    webhookId: "wh_1",
    reply: { conversationId: "imessage-thread-from-june", runId: "run_" + randomBytes(4).toString("hex"), channel: "imessage", status: "completed", trigger: "inbound_text", agentId: "fo", text: "Got it, I'll pass that on.", textTruncated: false, awaitingUser: false, closure: "message", ...overrides },
  });
}

async function deliver(s: Setup, body: string, id = "msg_" + randomBytes(6).toString("hex"), secret = SECRET): Promise<number> {
  const ts = Math.floor(Date.now() / 1000);
  const status = await post(s.port, body, { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sign(id, ts, body, secret) });
  run(s.rig.db, "UPDATE jobs SET run_after = ? WHERE state = 'queued'", new Date(0).toISOString());
  await s.rig.app.settle();
  return status;
}

const asked = (s: Setup) => s.fo.asks.filter((a) => a.message.includes("answered this by text")).length;
const status = (s: Setup) => one<{ status: string }>(s.rig.db, "SELECT status FROM plans WHERE id = ?", s.state.planId)?.status;

test("signatures: Standard Webhooks, within five minutes, nothing else", () => {
  const body = Buffer.from('{"type":"webhook.test"}');
  const now = 1_800_000_000;
  const good = { id: "msg_1", timestamp: String(now), signature: sign("msg_1", now, body.toString()) };
  assert.equal(verifyFoWebhook(SECRET, good, body, now), true);
  assert.equal(verifyFoWebhook(SECRET, { ...good, signature: `v1,${"A".repeat(44)} ${good.signature}` }, body, now), true, "any listed signature can match");
  assert.equal(verifyFoWebhook(SECRET, good, Buffer.from('{"type":"other"}'), now), false, "a changed body");
  assert.equal(verifyFoWebhook(SECRET, good, body, now + 301), false, "too old");
  assert.equal(verifyFoWebhook("whsec_" + randomBytes(24).toString("base64"), good, body, now), false, "another secret");
  assert.equal(verifyFoWebhook(SECRET, { ...good, signature: undefined }, body, now), false, "unsigned");
});

test("a yes you text Fo, even in an old iMessage thread, approves the proposal Fo texted you", async (t) => {
  const s = await setup(t);
  assert.match(s.note.text ?? "", /or just reply to this text/, "with the webhook, the text invites a reply");
  foReads(s, "yes go ahead");
  assert.equal(await deliver(s, textEvent()), 204);
  assert.equal(asked(s), 1, "Kiki asked Fo, in her conversation, to read your text");
  assert.equal(s.fo.asks.find((a) => a.message.includes("answered this by text"))?.conversationId, "kiki-1");
  assert.equal(status(s), "applied");
});

test("a text that isn't a plain yes approves nothing", async (t) => {
  const s = await setup(t);
  foReads(s, "maybe later");
  await deliver(s, textEvent());
  assert.equal(status(s), "proposed");
});

test("an unsigned or wrongly signed post does nothing", async (t) => {
  const s = await setup(t);
  foReads(s, "yes go ahead");
  const body = textEvent();
  assert.equal(await post(s.port, body, { "webhook-id": "msg_x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)) }), 401);
  assert.equal(await deliver(s, body, "msg_y", "whsec_" + randomBytes(24).toString("base64")), 401);
  assert.equal(asked(s), 0);
  assert.equal(status(s), "proposed");
});

test("a retried delivery is handled once", async (t) => {
  const s = await setup(t);
  foReads(s, "maybe later");
  const body = textEvent();
  await deliver(s, body, "msg_same");
  await deliver(s, body, "msg_same");
  assert.equal(asked(s), 1);
});

test("only texts you send count: not Fo's chats, not Kiki's own conversation", async (t) => {
  const s = await setup(t);
  foReads(s, "yes go ahead");
  await deliver(s, textEvent({ trigger: "user", channel: "chat" }));
  await deliver(s, textEvent({ conversationId: "kiki-1" }));
  await deliver(s, textEvent({ channel: "email", trigger: "inbound_email" }));
  assert.equal(asked(s), 0);
  assert.equal(status(s), "proposed");
});

test("a text from before Kiki's question isn't taken as an answer", async (t) => {
  const s = await setup(t);
  foReads(s, "yes go ahead");
  await deliver(s, textEvent().replace(/"occurredAt":"[^"]+"/, `"occurredAt":"${new Date(Date.now() - 3600_000).toISOString()}"`));
  assert.equal(asked(s), 0);
});

test("without a webhook secret, the address isn't there and the text says to use the link", async (t) => {
  const s = await setup(t, null);
  assert.match(s.note.text ?? "", /text replies can't be processed/);
  assert.equal(await post(s.port, textEvent(), {}), 404);
});
