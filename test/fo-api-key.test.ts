// With a Wajo API key, Kiki reaches Fo with the key as a bearer token instead of the sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../server/db.ts";
import { DbOAuthProvider } from "../server/fo/oauth.ts";
import { LiveFoClient } from "../server/fo/live.ts";
import { loadConfig } from "../server/config.ts";
import { tempDbPath } from "./helpers.ts";

test("the key goes to Fo as a bearer token, and counts as signed in", async (t) => {
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(503).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/fo`;
  const fo = new LiveFoClient(url, new DbOAuthProvider(openDb(tempDbPath()), "http://localhost/cb"), "wak_test123");
  await fo.listConversations().catch(() => undefined);
  assert.ok(seen.length > 0, "Kiki reached the server");
  assert.ok(seen.every((h) => h === "Bearer wak_test123"), JSON.stringify(seen));
  assert.deepEqual(await fo.beginAuth(), { alreadyAuthorized: true });
});

test("only a wak_ key is taken from FO_API_KEY", () => {
  assert.equal(loadConfig({ FO_API_KEY: "wak_abc" }).foApiKey, "wak_abc");
  assert.equal(loadConfig({ FO_API_KEY: "sk-something" }).foApiKey, null);
  assert.equal(loadConfig({}).foApiKey, null);
});
