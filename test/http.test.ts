import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { request as rawRequest } from "node:http";
import { createApp, type App } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { MockExtractor } from "../server/extractor.ts";
import { createHttpServer } from "../server/http.ts";
import { MockFoClient } from "../server/fo/mock.ts";

const port = 18000 + Math.floor(Math.random() * 1000);
const origin = `http://localhost:${port}`;
let server: http.Server;
let app: App;

before(async () => {
  const config = loadConfig({ PORT: String(port), PAPERCHASE_MODE: "mock" });
  app = createApp({
    db: openDb(":memory:"),
    fo: new MockFoClient({ stepMs: 5 }),
    extractor: new MockExtractor(),
    anthropicModel: "test-model",
    claudeCredentialsDetected: false,
    engineOptions: { pollWaitSeconds: 0, backoffBaseMs: 1 },
  });
  server = createHttpServer(app, config, null, "/nonexistent-static-dir");
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
});

after(() => {
  app.close();
  server.close();
});

function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = rawRequest({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: `localhost:${port}`, ...init.headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });

test("state-changing calls reject other origins, cross-site fetches and non-JSON bodies", async () => {
  assert.equal((await json("/api/settings", { studentName: "A" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await json("/api/settings", { studentName: "A" }, { "sec-fetch-site": "cross-site" })).status, 403);
  const form = await call("/api/settings", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: "studentName=A" });
  assert.equal(form.status, 415);
  assert.equal((await json("/api/settings", { studentName: "Anika" })).status, 200);
});

test("only the app's own host names are answered (DNS rebinding)", async () => {
  assert.equal((await call("/api/state", { headers: { host: "attacker.example" } })).status, 421);
  assert.equal((await call("/api/state")).status, 200);
});

test("static paths can't escape the web root", async () => {
  const res = await call("/%2e%2e/%2e%2e/server/db.ts");
  assert.notEqual(res.status, 200);
  assert.doesNotMatch(res.body, /CREATE TABLE/);
});

test("Fo conversation ids never reach the browser", async () => {
  const created = JSON.parse((await json("/api/requests", { demoKey: "maple-street" })).body) as { id: string };
  await app.whenIdle();
  const state = JSON.parse((await call(`/api/state?requestId=${created.id}`)).body);
  const items = state.current.items.map((i: { id: string }) => ({ id: i.id }));
  assert.equal((await json(`/api/requests/${created.id}/checklist`, { items })).status, 200);
  assert.equal((await json(`/api/requests/${created.id}/inventory`, { clientRequestId: "inv-1" })).status, 200);
  await app.whenIdle();
  const body = (await call(`/api/state?requestId=${created.id}`)).body;
  assert.match(body, /"parseStatus":"parsed"/);
  assert.doesNotMatch(body, /mock-[0-9a-f-]{36}/);
  assert.doesNotMatch(body, /conversation_?id/i);
});

test("errors come back as readable messages with status codes", async () => {
  const res = await json("/api/drafts/00000000-0000-0000-0000-000000000000/send", { contentHash: "x", clientRequestId: "k" });
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { error: "That draft doesn't exist." });
  const bad = await call("/api/settings", { method: "POST", headers: { "content-type": "application/json", origin }, body: "{not json" });
  assert.equal(bad.status, 400);
});
