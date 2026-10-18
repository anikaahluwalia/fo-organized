// Answering from Fo's text: the text carries a link to a page for that one proposal; the answer goes
// to Fo on the request's own conversation, so it stays linked. The public address serves nothing else.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig } from "../server/config.ts";
import { one, run } from "../server/db.ts";
import { createHttpServer } from "../server/http.ts";
import { replyState } from "../server/services/notify.ts";
import { FakeFo, makeRig, organized, reply } from "./helpers.ts";

const PUBLIC = "https://kiki-test.example";
const TEXTED = "Texted you.\nKIKI-STATUS: SENT";

function request(port: number, opts: { method?: string; path: string; host: string; body?: string; origin?: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host };
    if (opts.body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (opts.origin) headers.origin = opts.origin;
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

async function setup(t: TestContext) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  rig.app.ctx.publicUrl = PUBLIC;
  t.after(() => rig.app.close());
  fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: TEXTED });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const note = (await rig.app.view()).notifications.find((n) => n.purpose === "find")!;
  const link = /Answer here: (\S+)/.exec(note.text ?? "")?.[1];
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const server = createHttpServer(rig.app, { ...loadConfig({ PORT: String(port), KIKI_MODE: "mock" }), publicUrl: PUBLIC }, { google: null, fo: null }, "/nonexistent");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return { rig, fo, note, link, port };
}

test("the text Fo sends you ends with a link to answer that proposal", async (t) => {
  const s = await setup(t);
  assert.ok(s.link?.startsWith(`${PUBLIC}/a/`), `the text: ${s.note.text}`);
  const sent = s.fo.asks.find((a) => a.message.startsWith("Please text me"))!.message;
  assert.ok(sent.includes(s.link!), "the link is in the exact message Fo is asked to text");
});

test("the link opens the proposal, and your yes there goes to Fo on the request's conversation and approves it", async (t) => {
  const s = await setup(t);
  const path = new URL(s.link!).pathname;
  const host = new URL(PUBLIC).host;
  const page = await request(s.port, { path, host });
  assert.equal(page.status, 200);
  assert.match(page.text, /Yes, go ahead/);
  assert.match(page.text, /N-5602/, "it shows the proposal Fo texted");
  const state = replyState(s.rig.app.ctx, s.note.taskId)!;
  s.fo.onAsk = async (args) =>
    reply(args.conversationId!, "complete", {
      response: "KIKI-DECISION: " + JSON.stringify({ requestId: state.requestId, planId: state.planId, contentHash: state.contentHash, decision: "approved", userReply: "Yes, go ahead", actor: "account_holder", presentedExactProposal: true }),
    });
  const sent = await request(s.port, { method: "POST", path, host, body: "answer=Yes%2C+go+ahead", origin: PUBLIC });
  assert.equal(sent.status, 200);
  assert.match(sent.text, /Sent to Fo/);
  assert.equal(s.fo.asks.at(-1)?.conversationId, "kiki-1", "your answer went to Fo on the request's own conversation");
  await s.rig.app.settle();
  assert.equal(one<{ status: string }>(s.rig.db, "SELECT status FROM plans WHERE id = ?", state.planId)?.status, "applied");
  const after = await request(s.port, { path, host });
  assert.match(after.text, /You said yes/, "the page then says where things stand, with no form");
  assert.doesNotMatch(after.text, /<form/);
});

test("a change typed on the page goes to Fo the same way", async (t) => {
  const s = await setup(t);
  const path = new URL(s.link!).pathname;
  await request(s.port, { method: "POST", path, host: new URL(PUBLIC).host, body: "answer=other&other=Put+the+Northside+invoice+under+Kitchen", origin: PUBLIC });
  assert.match(s.fo.asks.at(-1)!.message, /Answer from the account holder \(data\): "Put the Northside invoice under Kitchen"/);
});

test("the public address serves only answer pages: not the app, not its API, not a made-up link", async (t) => {
  const s = await setup(t);
  const host = new URL(PUBLIC).host;
  assert.equal((await request(s.port, { path: "/api/state", host })).status, 404);
  assert.equal((await request(s.port, { path: "/", host })).status, 404);
  assert.equal((await request(s.port, { method: "POST", path: "/api/plans/organize", host })).status, 404);
  assert.equal((await request(s.port, { path: "/a/" + "x".repeat(32), host })).status, 404);
  assert.equal((await request(s.port, { path: "/api/state", host: "evil.example" })).status, 421);
});

test("a browser posting the page with \"Origin: null\" (strict referrer policy) gets its answer through", async (t) => {
  const s = await setup(t);
  const path = new URL(s.link!).pathname;
  const page = await request(s.port, { path, host: new URL(PUBLIC).host });
  const res = await request(s.port, { method: "POST", path, host: new URL(PUBLIC).host, body: "answer=Yes%2C+go+ahead", origin: "null" });
  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /Sent to Fo/);
  void page;
});

test("another site can't post an answer through your link", async (t) => {
  const s = await setup(t);
  const path = new URL(s.link!).pathname;
  const res = await request(s.port, { method: "POST", path, host: new URL(PUBLIC).host, body: "answer=Yes%2C+go+ahead", origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(s.fo.asks.some((a) => a.conversationId), false, "nothing was sent to Fo");
});

test("a text with a link says to answer there, and asks Fo not to invite a text reply", async (t) => {
  const s = await setup(t);
  assert.match(s.note.text ?? "", /Please tap the link to approve or ask for changes: text replies can't be processed\./);
  assert.doesNotMatch(s.note.text ?? "", /Reply to this text|answer Fo naturally/);
  const sent = s.fo.asks.find((a) => a.message.startsWith("Please text me"))!.message;
  assert.match(sent, /Don't invite me to reply by text/);
  const page = await request(s.port, { path: new URL(s.link!).pathname, host: new URL(PUBLIC).host });
  assert.doesNotMatch(page.text, /text replies can't be processed/, "the page itself doesn't repeat it");
});

test("a text reply to a linked proposal isn't taken as an answer", async (t) => {
  const s = await setup(t);
  s.fo.conversations = [{ conversationId: "sms-1", title: "go ahead", channel: "sms", startedAt: new Date(Date.now() + 1000).toISOString() }];
  for (let i = 0; i < 3; i++) {
    run(s.rig.db, "UPDATE jobs SET run_after = ? WHERE state = 'queued'", new Date(0).toISOString());
    await s.rig.app.settle();
  }
  assert.equal(s.fo.asks.some((a) => a.message.includes("answered this by text")), false, "Kiki didn't have Fo read it");
  assert.equal(replyState(s.rig.app.ctx, s.note.taskId)?.status, "waiting");
});

test("a second tap while Fo reads your answer says so: no error, nothing sent twice", async (t) => {
  const s = await setup(t);
  const path = new URL(s.link!).pathname;
  const host = new URL(PUBLIC).host;
  let release!: () => void;
  const state = replyState(s.rig.app.ctx, s.note.taskId)!;
  // Fo takes its time reading your answer; anything after that (the done text) goes through at once.
  s.fo.onAsk = (args) =>
    args.message.startsWith("Answer from the account holder")
      ? new Promise((resolve) => {
          release = () => resolve(reply(args.conversationId!, "complete", { response: "KIKI-DECISION: " + JSON.stringify({ requestId: state.requestId, planId: state.planId, contentHash: state.contentHash, decision: "approved", userReply: "Yes, go ahead", actor: "account_holder", presentedExactProposal: true }) }));
        })
      : Promise.resolve(reply(args.conversationId ?? "kiki-done", "complete", { response: TEXTED }));
  const first = await request(s.port, { method: "POST", path, host, body: "answer=Yes%2C+go+ahead", origin: PUBLIC });
  assert.match(first.text, /Sent to Fo/);
  const second = await request(s.port, { method: "POST", path, host, body: "answer=Yes%2C+go+ahead", origin: PUBLIC });
  assert.equal(second.status, 200);
  assert.match(second.text, /Fo is reading your answer now/);
  assert.doesNotMatch(second.text, /<form/);
  assert.equal(s.fo.asks.filter((a) => a.message.startsWith("Answer from the account holder")).length, 1, "sent once");
  release();
  await s.rig.app.settle();
  assert.equal(one<{ status: string }>(s.rig.db, "SELECT status FROM plans WHERE id = ?", state.planId)?.status, "applied");
  const done = s.fo.asks.find((a) => /Kiki: done/.test(a.message))!;
  assert.equal(done.conversationId, "kiki-1", "the done text goes to Fo in the conversation where you said yes");
  assert.match(done.message, /^Please text me[\s\S]*the proposal you brought me in this conversation/);
});
