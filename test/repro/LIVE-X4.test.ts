// LIVE-X4: LiveFoClient keeps one MCP session open for as long as Kiki runs. When Fo's server
// drops it (a deploy, a restart, an idle timeout), the MCP spec says the server answers 404 and
// the client must start a new session: the request was never processed. The SDK surfaces that as
// StreamableHTTPError(404), and classifyFoError calls it "Lost contact with Fo during the request"
// with delivery "unknown". For ask_fo that turns an approved email (or a text to you) into "I'm
// not sure the email went out", though Fo never saw it. A 429 from Fo's gateway is the same.
// The mocks never drop a session, so the tests never saw it.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../server/db.ts";
import { LiveFoClient } from "../../server/fo/live.ts";
import { DbOAuthProvider } from "../../server/fo/oauth.ts";
import type { FoCallError } from "../../server/fo/types.ts";

/** Just enough of a Streamable HTTP MCP server (JSON responses, sessions) to stand in for Fo. */
function stubFo() {
  let sessions = new Set<string>();
  let n = 0;
  const runs: string[] = [];
  let rejectNextCallWith: number | null = null;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { name?: string; protocolVersion?: string } };
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (msg.method === "initialize") {
      const id = `s-${++n}`;
      sessions.add(id);
      return json(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fo-stub", version: "1" } } }, { "mcp-session-id": id });
    }
    const session = String(req.headers["mcp-session-id"] ?? "");
    if (!sessions.has(session)) return json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    if (msg.method.startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    }
    if (msg.method === "tools/call") {
      if (rejectNextCallWith !== null) {
        const status = rejectNextCallWith;
        rejectNextCallWith = null;
        return json(status, { error: "Too many requests" });
      }
      runs.push(msg.params!.name!);
      const structured = msg.params!.name === "ask_fo" ? { status: "working", conversationId: "c-1", progress: "Sending it now" } : { conversations: [] };
      return json(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured } });
    }
    return json(200, { jsonrpc: "2.0", id: msg.id, result: {} });
  });
  return {
    server,
    runs,
    dropSessions() {
      sessions = new Set();
    },
    rejectNextCall(status: number) {
      rejectNextCallWith = status;
    },
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/fo`;
    },
  };
}

async function client(url: string) {
  const db = openDb(":memory:");
  const provider = new DbOAuthProvider(db, "http://localhost:8787/api/fo/oauth/callback");
  provider.saveTokens({ access_token: "token", token_type: "Bearer" });
  return { fo: new LiveFoClient(url, provider), db };
}

const outcome = (p: Promise<unknown>) => p.then(() => "answered", (e: FoCallError) => `${e.delivery} (${e.kind}): ${e.message}`);

test("ask_fo after Fo's server dropped the session is never reported as possibly sent", async (t) => {
  const stub = stubFo();
  const url = await stub.start();
  const { fo, db } = await client(url);
  t.after(() => {
    stub.server.close();
    db.close();
  });
  await fo.listConversations(); // Kiki connected and checked the sign-in
  stub.dropSessions(); // Fo deployed, restarted or expired idle sessions overnight

  const result = await outcome(fo.askFo({ message: "Please send ONE email with exactly these details: ...", newConversation: true }));
  const asks = stub.runs.filter((r) => r === "ask_fo").length;
  assert.ok(
    (result === "answered" && asks === 1) || (result.startsWith("not_sent") && asks === 0),
    `Fo ran ask_fo ${asks} time(s); Kiki recorded: ${result}`,
  );
});

test("a 429 from Fo's server before the tool runs is reported as not sent", async (t) => {
  const stub = stubFo();
  const url = await stub.start();
  const { fo, db } = await client(url);
  t.after(() => {
    stub.server.close();
    db.close();
  });
  await fo.listConversations();
  stub.rejectNextCall(429);
  const result = await outcome(fo.askFo({ message: "Please text me (an SMS to my phone, nobody else) this exact message: ...", newConversation: true }));
  assert.equal(stub.runs.filter((r) => r === "ask_fo").length, 0);
  assert.ok(result === "answered" || result.startsWith("not_sent"), `Kiki recorded: ${result}`);
});
