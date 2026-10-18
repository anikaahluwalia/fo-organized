import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AppView } from "../shared/api.ts";
import { loadConfig } from "../server/config.ts";
import { all, kvSet } from "../server/db.ts";
import { createHttpServer } from "../server/http.ts";
import { makeRig, organized, type TestRig } from "./helpers.ts";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_EXTENSION = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

type StateBody = AppView & { extension: { paired: boolean; pairedAt: string | null; codePending: boolean } };

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown> | null;
}

interface Call {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

function send(port: number, call: Call): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: call.method ?? "GET", path: call.path, agent: false, headers: { host: `localhost:${port}`, connection: "close", ...call.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(call.body);
  });
}

interface Running {
  rig: TestRig;
  /** The browser origin of the Kiki web app on this server. */
  origin: string;
  request(call: Call): Promise<Reply>;
  /** A JSON POST from the Kiki web app itself. */
  fromApp(path: string, body?: unknown): Promise<Reply>;
  /** A request from a Chrome extension's side panel (with its token, if it has one). */
  fromExtension(call: Call & { origin?: string; token?: string }): Promise<Reply>;
}

/** The real HTTP server on a random high port, in mock mode, with no web build to serve. */
async function startServer(t: TestContext, options: { rig?: TestRig; staticDir?: string } = {}): Promise<Running> {
  const rig = options.rig ?? makeRig();
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    const config = loadConfig({ PORT: String(port), KIKI_MODE: "mock" });
    const server = createHttpServer(rig.app, config, { google: null, fo: null }, options.staticDir ?? "/nonexistent");
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!listening) continue;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rig.app.close();
    });
    const request = (call: Call) => send(port, call);
    return {
      rig,
      origin: config.appOrigin,
      request,
      fromApp: (p, body = {}) => request({ method: "POST", path: p, headers: { origin: config.appOrigin, "content-type": "application/json" }, body: JSON.stringify(body) }),
      fromExtension: ({ origin = EXTENSION, token, ...call }) =>
        request({
          ...call,
          headers: {
            origin,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
            ...call.headers,
          },
        }),
    };
  }
  throw new Error("Couldn't find a free port.");
}

async function pairingCode(s: Running): Promise<string> {
  const res = await s.fromApp("/api/extension/pairing-code");
  assert.equal(res.status, 200);
  return String(res.json?.code);
}

const pair = (s: Running, code: string, origin = EXTENSION) => s.fromExtension({ method: "POST", path: "/api/extension/pair", origin, body: JSON.stringify({ code }) });

async function pairedToken(s: Running, origin = EXTENSION): Promise<string> {
  const res = await pair(s, await pairingCode(s), origin);
  assert.equal(res.status, 200);
  return String(res.json?.token);
}

async function userName(s: Running): Promise<string | null> {
  return (await s.rig.app.view()).settings.userName;
}

// The web app's own guards ------------------------------------------------------------------

test("a POST from another website is refused and changes nothing", async (t) => {
  const s = await startServer(t);
  const res = await s.request({ method: "POST", path: "/api/settings", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ userName: "Mallory" }) });
  assert.equal(res.status, 403);
  assert.equal(await userName(s), null);

  const ok = await s.fromApp("/api/settings", { userName: "Anika" });
  assert.equal(ok.status, 200, "the same request from the app itself goes through");
  assert.equal(await userName(s), "Anika");
});

test("a POST the browser marks as cross-site or same-site is refused", async (t) => {
  const s = await startServer(t);
  for (const site of ["cross-site", "same-site"]) {
    const res = await s.request({ method: "POST", path: "/api/settings", headers: { "sec-fetch-site": site, "content-type": "application/json" }, body: JSON.stringify({ userName: "Mallory" }) });
    assert.equal(res.status, 403, site);
  }
  assert.equal(await userName(s), null);

  const ok = await s.request({ method: "POST", path: "/api/settings", headers: { "sec-fetch-site": "same-origin", origin: s.origin, "content-type": "application/json" }, body: JSON.stringify({ userName: "Anika" }) });
  assert.equal(ok.status, 200);
});

test("a POST that isn't JSON is refused, so a plain HTML form can't call the API", async (t) => {
  const s = await startServer(t);
  for (const [type, body] of [
    ["text/plain", JSON.stringify({ userName: "Mallory" })],
    ["application/x-www-form-urlencoded", "userName=Mallory"],
  ] as const) {
    const res = await s.request({ method: "POST", path: "/api/settings", headers: { origin: s.origin, "content-type": type }, body });
    assert.equal(res.status, 415, type);
  }
  const untyped = await s.request({ method: "POST", path: "/api/settings", headers: { origin: s.origin }, body: JSON.stringify({ userName: "Mallory" }) });
  assert.equal(untyped.status, 415, "no content type");
  assert.equal(await userName(s), null);
});

test("a request for an unexpected Host is refused (DNS rebinding)", async (t) => {
  const s = await startServer(t);
  const port = new URL(s.origin).port;
  for (const host of ["evil.example", `attacker.example:${port}`]) {
    const res = await s.request({ path: "/api/state", headers: { host } });
    assert.equal(res.status, 421, host);
    assert.ok(!("plans" in (res.json ?? {})), "no state is returned");
  }
  const write = await s.request({ method: "POST", path: "/api/settings", headers: { host: "evil.example", origin: s.origin, "content-type": "application/json" }, body: JSON.stringify({ userName: "Mallory" }) });
  assert.equal(write.status, 421);
  assert.equal(await userName(s), null);
  assert.equal((await s.request({ path: "/api/state" })).status, 200, "the app's own host is answered");
});

test("files outside the web build folder are never served", async (t) => {
  const s = await startServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-http-"));
  const secretFile = path.join(dir, "secret.txt");
  const SECRET = "kiki-test-secret-7f3a9c";
  fs.writeFileSync(secretFile, SECRET);
  const segments = path.relative("/nonexistent", secretFile).split(path.sep);
  assert.equal(segments[0], "..", "the secret really is outside the build folder");

  const encodedSlashes = `/${segments.map(encodeURIComponent).join("%2f")}`;
  const traversal = await s.request({ path: encodedSlashes });
  assert.equal(traversal.status, 404);
  assert.ok(!traversal.text.includes(SECRET));

  for (const attempt of [`/${segments.join("/")}`, `/${segments.map((p) => (p === ".." ? "%2e%2e" : encodeURIComponent(p))).join("/")}`, encodedSlashes.replaceAll("%2f", "%2F")]) {
    const res = await s.request({ path: attempt });
    assert.notEqual(res.status, 200, attempt);
    assert.ok(!res.text.includes(SECRET), attempt);
  }
});

test("a sibling folder that shares the build folder's name isn't reachable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-http-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.mkdirSync(path.join(dir, "dist-private"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<h1>Kiki web app</h1>");
  fs.writeFileSync(path.join(dir, "dist-private", "secret.txt"), "private-sibling-secret");
  const s = await startServer(t, { staticDir: path.join(dir, "dist") });

  const page = await s.request({ path: "/index.html" });
  assert.equal(page.status, 200);
  assert.match(page.text, /Kiki web app/);

  const sibling = await s.request({ path: "/..%2fdist-private%2fsecret.txt" });
  assert.equal(sibling.status, 404);
  assert.ok(!sibling.text.includes("private-sibling-secret"));
});

test(
  "a malformed percent-encoded path is a client error, not a server error",
  async (t) => {
    t.mock.method(console, "error", () => undefined);
    const s = await startServer(t);
    const res = await s.request({ path: "/%E0%A4%A" });
    assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
  },
);

// What /api/state shows --------------------------------------------------------------------

test("/api/state never contains Fo conversation ids", async (t) => {
  const rig = makeRig();
  const s = await startServer(t, { rig });
  await organized(rig);
  rig.app.updateSettings({ userName: "Anika", autoText: true });

  // Fo texts the account holder about a new invoice...
  await rig.app.stageRevision("invoice");
  await rig.app.settle();

  // ...and sends the approved question to the contractor.
  let view = await rig.app.view();
  const quote = view.index.flatMap((p) => p.rows).find((r) => r.reference === "Q-1042")!;
  const { versionId } = rig.app.createOutreachDraft(quote.docId, { contractorName: "Sam", contractorEmail: "sam@oakline.example", consent: true });
  view = await rig.app.view();
  const draft = view.outreach.find((o) => o.documentId === quote.docId)!.draft!;
  rig.app.approveAndSend(versionId, { contentHash: draft.contentHash, clientRequestId: "send-1" });
  // Only Fo's own work is awaited: the conversation watch it opens isn't run here.
  await rig.app.engine.whenIdle();

  const taskConversations = all<{ c: string }>(rig.db, "SELECT conversation_id AS c FROM fo_tasks WHERE conversation_id IS NOT NULL").map((r) => r.c);
  const watchedConversations = all<{ c: string }>(rig.db, "SELECT conversation_id AS c FROM watches").map((r) => r.c);
  assert.ok(taskConversations.length >= 2, "the text and the email each have a Fo conversation");
  assert.equal(watchedConversations.length, 1, "Kiki follows the email's conversation");
  const ids = [...taskConversations, ...watchedConversations];
  assert.ok(
    ids.every((id) => id.startsWith("mock-")),
    "mock conversation ids",
  );

  const res = await s.request({ path: "/api/state" });
  assert.equal(res.status, 200);
  const state = res.json as unknown as StateBody;
  assert.equal(state.outreach[0]?.dispatches[0]?.state, "reported_sent", "the dispatch is in the state");
  assert.ok(state.notifications.length > 0, "Fo's text is in the state");
  assert.ok(state.activity.turns.length > 0, "Fo exchanges are in the state");
  for (const id of new Set(ids)) assert.ok(!res.text.includes(id), `the state leaks ${id}`);
  assert.doesNotMatch(res.text, /mock-(sms-)?[0-9a-f]{8}-[0-9a-f]{4}-/);
});

test("/api/state never contains OAuth tokens or the side panel's token", async (t) => {
  const rig = makeRig();
  const s = await startServer(t, { rig });
  await organized(rig);
  const secrets = ["ya29.google-access-token-for-test", "1//google-refresh-token-for-test", "fo-access-token-for-test", "fo-refresh-token-for-test"];
  kvSet(rig.db, "google.oauth.tokens", JSON.stringify({ access_token: secrets[0], expires_at: Date.now() + 3_600_000, refresh_token: secrets[1], scope: "https://www.googleapis.com/auth/drive" }));
  kvSet(rig.db, "fo.oauth.tokens", JSON.stringify({ access_token: secrets[2], token_type: "Bearer", refresh_token: secrets[3] }));
  const token = await pairedToken(s);

  for (const res of [await s.request({ path: "/api/state" }), await s.fromExtension({ path: "/api/state", token })]) {
    assert.equal(res.status, 200);
    for (const secret of [...secrets, token]) assert.ok(!res.text.includes(secret), `the state leaks ${secret.slice(0, 12)}…`);
    assert.equal((res.json as unknown as StateBody).extension.paired, true);
  }
});

// The Chrome side panel ----------------------------------------------------------------------

test("an unpaired side panel is told to pair first", async (t) => {
  const s = await startServer(t);
  const read = await s.fromExtension({ path: "/api/state" });
  assert.equal(read.status, 401);
  assert.equal(read.json?.code, "not_paired");
  assert.equal(read.headers["access-control-allow-origin"], EXTENSION, "the panel can read why");

  const write = await s.fromExtension({ method: "POST", path: "/api/settings", body: JSON.stringify({ userName: "Mallory" }) });
  assert.equal(write.status, 401);
  const madeUp = await s.fromExtension({ path: "/api/state", token: "not-a-real-token" });
  assert.equal(madeUp.status, 401);
  assert.equal(await userName(s), null);
});

test("the web app gets a fresh 6-digit pairing code", async (t) => {
  const s = await startServer(t);
  const res = await s.fromApp("/api/extension/pairing-code");
  assert.equal(res.status, 200);
  assert.match(String(res.json?.code), /^\d{6}$/);
  const minutesLeft = (Date.parse(String(res.json?.expiresAt)) - Date.now()) / 60_000;
  assert.ok(minutesLeft > 9 && minutesLeft <= 10, `expires in ${minutesLeft.toFixed(1)} minutes`);
});

test("five wrong pairing codes use the code up; four don't", async (t) => {
  const s = await startServer(t);
  const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

  const survivor = await pairingCode(s);
  for (let i = 1; i <= 4; i++) assert.equal((await pair(s, wrongFor(survivor))).status, 403, `wrong try ${i}`);
  assert.equal((await pair(s, survivor)).status, 200, "the right code still works after four wrong tries");

  const burned = await pairingCode(s);
  for (let i = 1; i <= 5; i++) assert.equal((await pair(s, wrongFor(burned))).status, 403, `wrong try ${i}`);
  const late = await pair(s, burned);
  assert.equal(late.status, 403, "the right code no longer works");
  assert.equal(late.json?.token, undefined);
});

test("the right code pairs once, and its token works only from the extension it was issued to", async (t) => {
  const s = await startServer(t);
  const code = await pairingCode(s);
  const paired = await pair(s, code);
  assert.equal(paired.status, 200);
  const token = String(paired.json?.token);
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);

  const state = await s.fromExtension({ path: "/api/state", token });
  assert.equal(state.status, 200);
  assert.equal(state.headers["access-control-allow-origin"], EXTENSION);
  assert.ok(state.json && "kiki" in state.json);

  const elsewhere = await s.fromExtension({ path: "/api/state", token, origin: OTHER_EXTENSION });
  assert.equal(elsewhere.status, 401);
  assert.equal(elsewhere.json?.code, "not_paired");

  assert.equal((await pair(s, code, OTHER_EXTENSION)).status, 403, "the code can't be used twice");
});

test("only a well-formed extension origin can pair, and a refused origin doesn't use up the code", async (t) => {
  const s = await startServer(t);
  const code = await pairingCode(s);
  const bogus = await pair(s, code, "chrome-extension://not-a-real-extension-id");
  assert.equal(bogus.status, 400);
  assert.equal(bogus.json?.token, undefined);
  assert.equal((await pair(s, code)).status, 200, "the real extension can still use the code");
});

test("a paired side panel can't manage pairing or connect accounts", async (t) => {
  const s = await startServer(t);
  const token = await pairedToken(s);
  for (const route of ["/api/extension/pairing-code", "/api/extension/unpair", "/api/google/connect", "/api/fo/connect", "/api/google/disconnect", "/api/fo/disconnect"]) {
    const res = await s.fromExtension({ method: "POST", path: route, token, body: "{}" });
    assert.equal(res.status, 403, route);
  }
  assert.equal((await s.fromExtension({ path: "/api/state", token })).status, 200, "the refused unpair changed nothing");
});

test("side panel preflight requests are answered without a token", async (t) => {
  const s = await startServer(t);
  const res = await s.fromExtension({ method: "OPTIONS", path: "/api/settings", headers: { "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], EXTENSION);
  assert.match(String(res.headers["access-control-allow-methods"]), /\bPOST\b/);
  assert.match(String(res.headers["access-control-allow-methods"]), /\bGET\b/);
  assert.match(String(res.headers["access-control-allow-headers"]), /\bauthorization\b/i);
  assert.match(String(res.headers["access-control-allow-headers"]), /\bcontent-type\b/i);
});

test("unpairing in the web app revokes the side panel's token", async (t) => {
  const s = await startServer(t);
  const token = await pairedToken(s);
  assert.equal((await s.fromApp("/api/extension/unpair")).status, 200);
  const res = await s.fromExtension({ path: "/api/state", token });
  assert.equal(res.status, 401);
  assert.equal(res.json?.code, "not_paired");
  assert.deepEqual(((await s.request({ path: "/api/state" })).json as unknown as StateBody).extension, { paired: false, pairedAt: null, codePending: false });
});
