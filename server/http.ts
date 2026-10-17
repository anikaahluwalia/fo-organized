import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { App } from "./app.ts";
import type { Config } from "./config.ts";
import { AppError, badRequest, notFound } from "./errors.ts";
import type { ItemDecision } from "./services/requests.ts";

export interface FoAuth {
  begin(): Promise<{ authorizationUrl: string } | { alreadyAuthorized: true }>;
  finish(code: string, state: string | null): Promise<void>;
  disconnect(): void;
}

type Body = Record<string, unknown>;
type Handler = (params: string[], body: Body, url: URL) => Promise<unknown> | unknown;

const MAX_BODY = 256 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function str(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw badRequest(`${key} must be text.`);
  return v;
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload ?? { ok: true });
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(json);
}

async function readJson(req: http.IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AppError(413, "That's too much data.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Body;
  } catch {
    throw badRequest("The request body isn't valid JSON.");
  }
}

export function createHttpServer(app: App, config: Config, foAuth: FoAuth | null, staticDir: string): http.Server {
  const allowedOrigins = new Set([config.appOrigin, ...config.devOrigins]);
  const allowedHosts = new Set([...allowedOrigins].map((o) => new URL(o).host));
  let oauthReturnTo = config.appOrigin;

  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  const route = (method: string, pattern: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:[a-z]+/g, "([A-Za-z0-9-]+)")}$`), handler });

  route("GET", "/api/state", (_p, _b, url) => app.view(url.searchParams.get("requestId")));
  route("POST", "/api/requests", (_p, b) => app.createRequest({ text: str(b, "text"), trustedDomain: str(b, "trustedDomain"), demoKey: str(b, "demoKey") }));
  route("POST", "/api/requests/:id/retry-extraction", ([id]) => app.retryExtraction(id!));
  route("POST", "/api/requests/:id/trusted-domain", ([id], b) => app.setTrustedDomain(id!, str(b, "domain") ?? ""));
  route("POST", "/api/requests/:id/risk-review", ([id], b) => app.reviewRisk(id!, { acknowledge: b.acknowledge === true, note: str(b, "note") }));
  route("POST", "/api/requests/:id/checklist", ([id], b) => {
    if (!Array.isArray(b.items)) throw badRequest("Send the checklist items.");
    return app.confirmChecklist(id!, b.items as { id?: string; label?: string; removed?: boolean }[]);
  });
  route("POST", "/api/requests/:id/inventory", ([id], b) => app.startInventory(id!, str(b, "clientRequestId") ?? ""));
  route("POST", "/api/items/:id/decision", ([id], b) => app.decideItem(id!, (str(b, "decision") ?? "") as ItemDecision));
  route("POST", "/api/items/:id/draft", ([id], b) => app.createDraft(id!, { recipientName: str(b, "recipientName"), recipientEmail: str(b, "recipientEmail") }));
  route("POST", "/api/drafts/:id/revise", ([id], b) =>
    app.reviseDraft(id!, { recipientName: str(b, "recipientName"), recipientEmail: str(b, "recipientEmail"), subject: str(b, "subject"), body: str(b, "body") }),
  );
  route("POST", "/api/drafts/:id/discard", ([id]) => app.discardDraft(id!));
  route("POST", "/api/drafts/:id/send", ([id], b) =>
    app.approveAndSend(id!, { contentHash: str(b, "contentHash"), clientRequestId: str(b, "clientRequestId"), confirmResend: b.confirmResend === true }),
  );
  route("POST", "/api/tasks/:id/reply", ([id], b) => app.reply(id!, str(b, "answer") ?? ""));
  route("POST", "/api/tasks/:id/keep-waiting", ([id]) => app.keepWaiting(id!));
  route("POST", "/api/dispatches/:id/stop", ([id]) => app.stopDispatch(id!));
  route("POST", "/api/dispatches/:id/reconcile", ([id]) => app.reconcileDispatch(id!));
  route("POST", "/api/dispatches/:id/retire", ([id], b) => app.retireDispatch(id!, b.acknowledge === true));
  route("POST", "/api/settings", (_p, b) => app.setStudentName(str(b, "studentName") ?? ""));
  route("POST", "/api/fo/connect", async () => {
    if (!foAuth) throw badRequest("Fo is in mock mode; there is nothing to connect.");
    return foAuth.begin();
  });
  route("POST", "/api/fo/disconnect", () => {
    if (!foAuth) throw badRequest("Fo is in mock mode.");
    foAuth.disconnect();
  });

  async function oauthCallback(url: URL, res: http.ServerResponse): Promise<void> {
    const back = new URL("/", oauthReturnTo);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    try {
      if (!foAuth) throw new Error("Fo is in mock mode.");
      if (error || !code) throw new Error(error ? `Wajo returned: ${error}` : "No authorization code.");
      await foAuth.finish(code, url.searchParams.get("state"));
      back.searchParams.set("fo", "connected");
    } catch (err) {
      back.searchParams.set("fo", "error");
      back.searchParams.set("foMessage", (err instanceof Error ? err.message : String(err)).slice(0, 200));
    }
    res.writeHead(302, { ...SECURITY_HEADERS, Location: back.toString(), "Cache-Control": "no-store" });
    res.end();
  }

  function serveStatic(url: URL, res: http.ServerResponse): void {
    const root = path.resolve(staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) && file !== root) return send(res, 404, { error: "Not found." });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(503, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("The web app hasn't been built. Run `npm run build`, or use `npm run dev` for development.");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer to the hosts this app is served on.
      if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 421, { error: "Unexpected host." });
      const url = new URL(req.url ?? "/", config.appOrigin);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/fo/oauth/callback") return await oauthCallback(url, res);
      if (!url.pathname.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
        return serveStatic(url, res);
      }

      if (method === "POST") {
        // CSRF guard for state-changing calls: a JSON body from one of our own origins only.
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: "Cross-origin requests aren't allowed." });
        if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) {
          return send(res, 403, { error: "Cross-site requests aren't allowed." });
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "Send JSON." });
        if (url.pathname === "/api/fo/connect" && origin) oauthReturnTo = origin;
      }

      const match = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!match) throw notFound();
      const params = match.pattern.exec(url.pathname)!.slice(1);
      const body = method === "POST" ? await readJson(req) : {};
      const result = await match.handler(params, body, url);
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof AppError) return send(res, err.status, { error: err.message, code: err.code });
      console.error("Request failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      send(res, 500, { error: "Something went wrong on the server." });
    }
  });
}
