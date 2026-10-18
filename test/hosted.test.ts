// Kiki online: one public address serves the app (behind a password), the answer links (their own
// token) and Fo's webhook (Wajo's signature). Nothing else answers without signing in.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { configProblems, loadConfig } from "../server/config.ts";
import { createHttpServer } from "../server/http.ts";
import { LoginLimiter, safeNext } from "../server/auth.ts";
import { makeRig } from "./helpers.ts";

const ORIGIN = "https://kiki.example";
const HOST = "kiki.example";
const PASSWORD = "correct horse battery";

function request(port: number, opts: { method?: string; path: string; body?: string; cookie?: string; origin?: string; type?: string; forwardedFor?: string }): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST };
    if (opts.body !== undefined) headers["content-type"] = opts.type ?? "application/x-www-form-urlencoded";
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor;
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

async function online(t: TestContext) {
  const rig = makeRig();
  t.after(() => rig.app.close());
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const config = loadConfig({ PORT: String(port), KIKI_MODE: "mock", APP_ORIGIN: ORIGIN, KIKI_PASSWORD: PASSWORD });
  const server = createHttpServer(rig.app, config, { google: null, fo: null }, "/nonexistent");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  const signIn = async (password = PASSWORD, from?: string) => {
    const res = await request(port, { method: "POST", path: "/login", body: `password=${encodeURIComponent(password)}&next=%2F`, origin: ORIGIN, forwardedFor: from });
    const cookie = String(res.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    return { res, cookie };
  };
  return { rig, port, config, signIn };
}

test("an https address that isn't this machine is online: every interface, links on the same address, a password required", () => {
  const c = loadConfig({ APP_ORIGIN: ORIGIN, KIKI_PASSWORD: PASSWORD });
  assert.equal(c.hosted, true);
  assert.equal(c.listenHost, "0.0.0.0");
  assert.equal(c.publicUrl, ORIGIN);
  assert.deepEqual(configProblems(c), []);
  assert.match(configProblems(loadConfig({ APP_ORIGIN: ORIGIN })).join(" "), /set KIKI_PASSWORD/);
  assert.match(configProblems(loadConfig({ APP_ORIGIN: ORIGIN, KIKI_PASSWORD: "short" })).join(" "), /12 characters/);
  const local = loadConfig({});
  assert.equal(local.hosted, false);
  assert.equal(local.listenHost, "127.0.0.1");
  assert.deepEqual(configProblems(local), [], "on this machine, no password is needed");
});

test("without signing in: the app sends you to sign in, the API says so, and nothing else answers", async (t) => {
  const s = await online(t);
  const page = await request(s.port, { path: "/" });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, "/login?next=%2F");
  const api = await request(s.port, { path: "/api/state" });
  assert.equal(api.status, 401);
  assert.match(api.text, /"code":"login"/);
  assert.equal((await request(s.port, { method: "POST", path: "/api/workspace/clear", body: "{}", type: "application/json", origin: ORIGIN })).status, 401);
  assert.equal((await request(s.port, { path: "/api/google/oauth/callback?code=x" })).status, 401, "OAuth callbacks too");
  assert.equal((await request(s.port, { path: "/healthz" })).status, 200, "the health check says only that Kiki is up");
  assert.equal((await request(s.port, { path: "/a/" + "x".repeat(32) })).status, 404, "an answer link needs its own token, not a session");
  assert.equal(page.headers["strict-transport-security"], "max-age=31536000");
});

test("the right password signs you in with an HttpOnly, Secure cookie; the wrong one doesn't", async (t) => {
  const s = await online(t);
  const wrong = await s.signIn("nope nope nope");
  assert.equal(wrong.res.status, 401);
  assert.equal(wrong.res.headers["set-cookie"], undefined);
  const right = await s.signIn();
  assert.equal(right.res.status, 303);
  assert.match(String(right.res.headers["set-cookie"]), /kiki_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
  assert.equal((await request(s.port, { path: "/api/state", cookie: right.cookie })).status, 200);
  assert.match((await request(s.port, { path: "/api/state", cookie: right.cookie })).text, /"signedIn":true/);
  assert.equal((await request(s.port, { path: "/api/state", cookie: "kiki_session=" + "A".repeat(43) })).status, 401, "a made-up session doesn't");
});

test("signing out ends the session, and Kiki keeps only a hash of it", async (t) => {
  const s = await online(t);
  const { cookie } = await s.signIn();
  const token = cookie.split("=")[1]!;
  const stored = s.rig.db.prepare("SELECT key FROM kv WHERE key LIKE 'session.%'").all() as { key: string }[];
  assert.equal(stored.length, 1);
  assert.ok(!stored[0]!.key.includes(token), "the token itself isn't stored");
  await request(s.port, { path: "/logout", cookie });
  assert.equal((await request(s.port, { path: "/api/state", cookie })).status, 401);
});

test("another site can't post the sign-in form; many wrong passwords from one place make it wait", async (t) => {
  const s = await online(t);
  const cross = await request(s.port, { method: "POST", path: "/login", body: `password=${encodeURIComponent(PASSWORD)}`, origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  for (let i = 0; i < 10; i++) await s.signIn("wrong password!", "203.0.113.9");
  const locked = await s.signIn(PASSWORD, "203.0.113.9");
  assert.equal(locked.res.status, 429, "even the right password waits");
  assert.equal((await s.signIn(PASSWORD, "198.51.100.4")).res.status, 303, "somewhere else isn't held up");
});

test("after signing in you go back where you were, only ever on this site", () => {
  assert.equal(safeNext("/"), "/");
  assert.equal(safeNext("/?connected=Fo"), "/?connected=Fo");
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "/login", null]) assert.equal(safeNext(bad), "/", String(bad));
  const l = new LoginLimiter();
  for (let i = 0; i < 9; i++) l.failed("a", 0);
  assert.equal(l.waitMs("a", 0), 0);
  l.failed("a", 0);
  assert.equal(l.waitMs("a", 0), 15 * 60_000);
  assert.equal(l.waitMs("a", 15 * 60_000 + 1), 0);
});

test("on this machine (no password set), the app works as before", async (t) => {
  const rig = makeRig();
  t.after(() => rig.app.close());
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const server = createHttpServer(rig.app, loadConfig({ PORT: String(port), KIKI_MODE: "mock" }), { google: null, fo: null }, "/nonexistent");
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  const res = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/state", headers: { host: `localhost:${port}` }, agent: false }, (r) => (r.resume(), resolve(r.statusCode ?? 0))));
  assert.equal(res, 200);
});
