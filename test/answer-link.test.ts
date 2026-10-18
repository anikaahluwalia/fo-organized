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
  const link = /(https:\/\/\S+\/a\/\S+)$/.exec(note.text ?? "")?.[1];
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
  assert.equal(sent.status, 303, "sent, then back to the page (so a reload doesn't post it again)");
  assert.ok(s.fo.asks.some((a) => a.conversationId === "kiki-1" && a.message.startsWith("Answer from the account holder")), "your answer went to Fo on the request's own conversation");
  await s.rig.app.settle();
  assert.equal(one<{ status: string }>(s.rig.db, "SELECT status FROM plans WHERE id = ?", state.planId)?.status, "applied");
  const after = await request(s.port, { path, host });
  assert.match(after.text, /All done/, "the page then says where things stand, with no form");
  assert.match(after.text, /You can close this tab/);
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
  assert.equal(res.status, 303, res.text);
  assert.ok(s.fo.asks.some((a) => a.message.startsWith("Answer from the account holder")));
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
  assert.match(s.note.text ?? "", /Tap to answer:\nhttps:/);
  assert.doesNotMatch(s.note.text ?? "", /\breply\b/i, "without the webhook, a text reply isn't invited");
  const sent = s.fo.asks.find((a) => a.message.startsWith("Please text me"))!.message;
  assert.match(sent, /Don't invite me to reply by text/);
});

test("the text is short; Fo gets the exact proposal besides, and isn't to text it", async (t) => {
  const s = await setup(t);
  const body = (s.note.text ?? "").replace(/\nhttps:\S+$/, "");
  assert.ok(body.length <= 260, `short: ${body}`);
  assert.doesNotMatch(body, /Projects\/|version \d|index|Nothing is deleted/);
  const sent = s.fo.asks.find((a) => a.message.startsWith("Please text me"))!.message;
  assert.match(sent, /The exact proposal this text is about \(version \d+\), for you to answer my questions about it; don't text it to me:/);
  assert.match(sent, /Move "Northside invoice/, "every step is there for Fo");
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

test("after you answer, the page says you can close it; a second tap sends nothing twice", async (t) => {
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
  assert.equal((await request(s.port, { method: "POST", path, host, body: "answer=Yes%2C+go+ahead", origin: PUBLIC })).status, 303);
  const page = await request(s.port, { path, host });
  assert.match(page.text, /Got it!/);
  assert.match(page.text, /You said &quot;Yes, go ahead&quot;\./);
  assert.match(page.text, /You can close this tab\. Fo will let you know what happens\./);
  assert.doesNotMatch(page.text, /<form/);
  const second = await request(s.port, { method: "POST", path, host, body: "answer=Yes%2C+go+ahead", origin: PUBLIC });
  assert.equal(second.status, 303, "a second tap just shows the same page");
  assert.equal(s.fo.asks.filter((a) => a.message.startsWith("Answer from the account holder")).length, 1, "sent once");
  release();
  await s.rig.app.settle();
  assert.equal(one<{ status: string }>(s.rig.db, "SELECT status FROM plans WHERE id = ?", state.planId)?.status, "applied");
  const done = s.fo.asks.find((a) => /Kiki: done/.test(a.message))!;
  assert.equal(done.conversationId, "kiki-1", "the done text goes to Fo in the conversation where you said yes");
  assert.match(done.message, /^Please text me[\s\S]*the proposal you brought me in this conversation/);
});

/** A file Kiki can't place: Fo texts you "where does it go?" with a link. */
async function askedWhere(t: TestContext) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  rig.app.ctx.publicUrl = PUBLIC;
  t.after(() => rig.app.close());
  fo.onAsk = async (_args, n) => reply(`kiki-${n}`, "complete", { response: TEXTED });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  const root = one<{ root_file_id: string }>(rig.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  rig.drive.addFile("thoughts.txt", root, "text/plain", "NOTES\nTitle: Garden ideas\nPlant tomatoes in May.");
  rig.app.refreshInventory();
  await rig.app.settle();
  const note = (await rig.app.view()).notifications.find((n) => n.purpose === "find")!;
  const link = /(https:\/\/\S+\/a\/\S+)$/.exec(note.text ?? "")![1]!;
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const server = createHttpServer(rig.app, { ...loadConfig({ PORT: String(port), KIKI_MODE: "mock" }), publicUrl: PUBLIC }, { google: null, fo: null }, "/nonexistent");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return { rig, fo, note, port, path: new URL(link).pathname, host: new URL(PUBLIC).host, state: replyState(rig.app.ctx, note.taskId)! };
}

test("\"where does it go?\" asks for a place on the page, not a yes", async (t) => {
  const s = await askedWhere(t);
  assert.match(s.note.text ?? "", /where should "thoughts" go\? Tap to pick a folder:/);
  const page = await request(s.port, { path: s.path, host: s.host });
  assert.match(page.text, /Where should &quot;thoughts&quot; go\?[\s\S]*Leave it where it is/);
  assert.match(page.text, /Leave it where it is/);
  assert.doesNotMatch(page.text, /Yes, go ahead/);
});

test("a yes to \"where does it go?\" keeps the question open, and the page says what Kiki needs", async (t) => {
  const s = await askedWhere(t);
  const decision = { requestId: s.state.requestId, planId: s.state.planId, contentHash: s.state.contentHash, decision: "approved", userReply: "Yes, go ahead", actor: "account_holder", presentedExactProposal: true };
  s.fo.onAsk = async (args) => reply(args.conversationId!, "complete", { response: "KIKI-DECISION: " + JSON.stringify(decision) });
  await s.rig.app.reply(s.note.taskId, "Yes, go ahead");
  await s.rig.app.settle();
  assert.equal(replyState(s.rig.app.ctx, s.note.taskId)?.status, "waiting");
  const page = await request(s.port, { path: s.path, host: s.host });
  assert.match(page.text, /Kiki needs to know where it goes/);
  assert.match(page.text, /Where should &quot;thoughts&quot; go\?[\s\S]*Leave it where it is/, "and you can still answer");
});

test("a question a plain yes left stuck before this fix is reopened when Kiki starts", async (t) => {
  const s = await askedWhere(t);
  run(s.rig.db, "UPDATE kv SET value = ? WHERE key = ?", JSON.stringify({ ...s.state, status: "stale", text: "Yes, go ahead", source: "relayed_by_fo" }), `notify.reply.${s.note.taskId}`);
  assert.match((await request(s.port, { path: s.path, host: s.host })).text, /settled/);
  s.rig.app.recover();
  const page = await request(s.port, { path: s.path, host: s.host });
  assert.match(page.text, /Where should &quot;thoughts&quot; go\?[\s\S]*Leave it where it is/);
  assert.match(page.text, /Kiki needs to know where it goes/);
});

test("a change you ask for at the link comes back to you as a text, with its own link", async (t) => {
  const s = await setup(t);
  const path = new URL(s.link!).pathname;
  const state = replyState(s.rig.app.ctx, s.note.taskId)!;
  const words = "Put the Northside invoice under Kitchen instead";
  s.fo.onAsk = async (args, n) =>
    args.conversationId === "kiki-1" && args.message.startsWith("Answer from the account holder")
      ? reply("kiki-1", "complete", { response: "KIKI-DECISION: " + JSON.stringify({ requestId: state.requestId, planId: state.planId, contentHash: state.contentHash, decision: "changes_requested", userReply: words, actor: "account_holder", presentedExactProposal: true }) })
      : reply(`kiki-${n}`, "complete", { response: TEXTED });
  await request(s.port, { method: "POST", path, host: new URL(PUBLIC).host, body: `answer=other&other=${encodeURIComponent(words)}`, origin: PUBLIC });
  await s.rig.app.settle();
  const next = s.fo.asks.at(-1)!;
  assert.match(next.message, /^Please text me/, "Fo is asked to text it, not just tell you in Kiki");
  assert.match(next.message, /Kiki: updated as you asked\./);
  assert.match(next.message, /\nhttps:\/\/kiki-test\.example\/a\/\S+\n-----END APPROVED BODY-----/, "with its own link");
});

test("once a link has expired, its page no longer shows the proposal", async (t) => {
  const s = await setup(t);
  const state = replyState(s.rig.app.ctx, s.note.taskId)!;
  run(s.rig.db, "UPDATE kv SET value = ? WHERE key = ?", JSON.stringify({ ...state, requestedAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() }), `notify.reply.${s.note.taskId}`);
  const page = await request(s.port, { path: new URL(s.link!).pathname, host: new URL(PUBLIC).host });
  assert.match(page.text, /This link expired/);
  assert.doesNotMatch(page.text, /Every step|N-5602/);
});

test("an answered link that's gone quiet says where things stand, but not what was in the proposal", async (t) => {
  const s = await setup(t);
  const state = replyState(s.rig.app.ctx, s.note.taskId)!;
  const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  run(s.rig.db, "UPDATE kv SET value = ? WHERE key = ?", JSON.stringify({ ...state, status: "declined", text: "No", at: old, requestedAt: old, answers: [{ text: "No", at: old }] }), `notify.reply.${s.note.taskId}`);
  const page = await request(s.port, { path: new URL(s.link!).pathname, host: new URL(PUBLIC).host });
  assert.match(page.text, /Nothing changes/);
  assert.doesNotMatch(page.text, /The proposal|N-5602/);
});
