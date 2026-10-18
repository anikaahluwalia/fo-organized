import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { App } from "./app.ts";
import type { Config } from "./config.ts";
import { AppError, badRequest, notFound } from "./errors.ts";
import { createPairingCode, extensionPaired, pairExtension, unpairAll, verifyExtensionToken } from "./extension.ts";

export interface OAuthFlow {
  begin(): Promise<string>; // returns the URL to send the browser to
  finish(code: string, state: string | null): Promise<void>;
  disconnect(): Promise<void> | void;
}

type Body = Record<string, unknown>;
type Handler = (params: string[], body: Body, url: URL, origin: string | undefined) => Promise<unknown> | unknown;

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

export function createHttpServer(app: App, config: Config, oauth: { google: OAuthFlow | null; fo: OAuthFlow | null }, staticDir: string): http.Server {
  const allowedOrigins = new Set([config.appOrigin, ...config.devOrigins]);
  const allowedHosts = new Set([...allowedOrigins].map((o) => new URL(o).host));
  let returnTo = config.appOrigin;

  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  const route = (method: string, pattern: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:[a-z]+/gi, "([A-Za-z0-9_-]+)")}$`), handler });

  route("GET", "/api/state", async () => {
    const view = await app.view();
    return { ...view, settings: { ...view.settings, autoText: app.autoTextEnabled() }, extension: { paired: extensionPaired(app.db) } };
  });
  route("POST", "/api/settings", (_p, b) => app.updateSettings({ userName: str(b, "userName"), autoText: typeof b.autoText === "boolean" ? b.autoText : undefined }));
  route("POST", "/api/workspace/select", (_p, b) => app.selectWorkspace(str(b, "folder") ?? "").then(() => ({ ok: true })));
  route("POST", "/api/workspace/demo", () => app.createDemoWorkspace().then(() => ({ ok: true })));
  route("POST", "/api/workspace/stage-revision", (_p, b) => app.stageRevision(b.variant === "ambiguous" ? "ambiguous" : b.variant === "invoice" ? "invoice" : "single").then((added) => ({ added })));
  route("POST", "/api/workspace/refresh", () => app.refreshInventory());
  route("POST", "/api/workspace/clear", () => app.clearWorkspace());
  route("POST", "/api/plans/organize", () => app.proposeOrganize());
  route("POST", "/api/plans/:id/revise", ([id], b) => {
    if (!Array.isArray(b.edits)) throw badRequest("Send the edits.");
    return app.revisePlan(id!, b.edits as { seq: number; newName?: string; exclude?: boolean }[]);
  });
  route("POST", "/api/plans/:id/approve", ([id], b) => app.approvePlan(id!, { contentHash: str(b, "contentHash"), clientRequestId: str(b, "clientRequestId") }));
  route("POST", "/api/plans/:id/discard", ([id]) => app.discardPlan(id!));
  route("POST", "/api/plans/:id/resume", ([id]) => app.resumePlan(id!));
  route("POST", "/api/plans/:id/undo", ([id]) => app.proposeUndo(id!));
  route("POST", "/api/documents/:id/accept", ([id], b) => app.acceptQuote(id!, b.accepted === true));
  route("POST", "/api/documents/:id/outreach", ([id], b) =>
    app.createOutreachDraft(id!, { contractorName: str(b, "contractorName"), contractorEmail: str(b, "contractorEmail"), consent: b.consent === true }),
  );
  route("POST", "/api/outreach/:id/revise", ([id], b) =>
    app.reviseOutreach(id!, { recipientName: str(b, "recipientName"), recipientEmail: str(b, "recipientEmail"), subject: str(b, "subject"), body: str(b, "body"), consent: b.consent === true }),
  );
  route("POST", "/api/outreach/:id/discard", ([id]) => app.discardOutreach(id!));
  route("POST", "/api/outreach/:id/send", ([id], b) =>
    app.approveAndSend(id!, { contentHash: str(b, "contentHash"), clientRequestId: str(b, "clientRequestId"), confirmResend: b.confirmResend === true }),
  );
  route("POST", "/api/tasks/:id/reply", ([id], b) => app.reply(id!, str(b, "answer") ?? ""));
  route("POST", "/api/tasks/:id/keep-waiting", ([id]) => app.keepWaiting(id!));
  route("POST", "/api/dispatches/:id/stop", ([id]) => app.stopDispatch(id!));
  route("POST", "/api/dispatches/:id/reconcile", ([id]) => app.reconcileDispatch(id!));
  route("POST", "/api/dispatches/:id/retire", ([id], b) => app.retireDispatch(id!, b.acknowledge === true));
  route("POST", "/api/watches/:id/paste", ([id], b) => app.pasteReply(id!, str(b, "text") ?? ""));
  route("POST", "/api/watches/:id/follow-up", ([id], b) => app.followUp(id!, str(b, "text") ?? ""));
  route("POST", "/api/watches/:id/check", ([id]) => app.checkNow(id!));
  route("POST", "/api/watches/:id/watching", ([id], b) => app.setWatching(id!, b.watching === true));
  route("POST", "/api/updates/:id/resolve", ([id], b) => app.resolveOutcome(id!, typeof b.documentId === "string" ? b.documentId : null));
  route("POST", "/api/updates/:id/recheck", ([id]) => app.recheckOutcome(id!));
  route("POST", "/api/updates/:id/dismiss", ([id]) => app.dismissOutcome(id!));
  for (const [name, flow] of [
    ["google", oauth.google],
    ["fo", oauth.fo],
  ] as const) {
    route("POST", `/api/${name}/connect`, async (_p, _b, _u, origin) => {
      if (!flow) throw badRequest(`${name === "google" ? "Google Drive" : "Fo"} is in mock mode; there is nothing to connect.`);
      if (origin && allowedOrigins.has(origin)) returnTo = origin;
      return { authorizationUrl: await flow.begin() };
    });
    route("POST", `/api/${name}/disconnect`, async () => {
      if (!flow) throw badRequest("Mock mode: nothing to disconnect.");
      await flow.disconnect();
      app.forgetConnectionCache();
    });
  }
  route("POST", "/api/notify/preview", () => app.notifyPreview() ?? { text: null });
  route("POST", "/api/notify/send", (_p, b) => app.notifySend({ contentHash: str(b, "contentHash"), clientRequestId: str(b, "clientRequestId") }));
  route("POST", "/api/extension/pairing-code", () => createPairingCode(app.db));
  route("POST", "/api/extension/unpair", () => unpairAll(app.db));

  async function oauthCallback(flow: OAuthFlow | null, label: string, url: URL, res: http.ServerResponse): Promise<void> {
    const back = new URL("/", returnTo);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    try {
      if (!flow) throw new Error(`${label} is in mock mode.`);
      if (error || !code) throw new Error(error ? `Sign-in returned: ${error}` : "No authorization code.");
      await flow.finish(code, url.searchParams.get("state"));
      app.forgetConnectionCache();
      back.searchParams.set("connected", label);
    } catch (err) {
      back.searchParams.set("connectError", `${label}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
    res.writeHead(302, { ...SECURITY_HEADERS, Location: back.toString(), "Cache-Control": "no-store" });
    res.end();
  }

  function serveStatic(url: URL, res: http.ServerResponse): void {
    const root = path.resolve(staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found.");
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(503, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("The web app hasn't been built. Run `npm run build`, or use `npm run dev` for development.");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable" });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const fromExtension = typeof origin === "string" && origin.startsWith("chrome-extension://");
    const cors: Record<string, string> = fromExtension ? { "Access-Control-Allow-Origin": origin!, Vary: "Origin" } : {};
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload ?? { ok: true }));
    };
    try {
      // DNS-rebinding guard: only answer to the hosts this app is served on.
      if (!allowedHosts.has(req.headers.host ?? "")) return send(421, { error: "Unexpected host." });
      const url = new URL(req.url ?? "/", config.appOrigin);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/google/oauth/callback") return await oauthCallback(oauth.google, "Google Drive", url, res);
      if (method === "GET" && url.pathname === "/api/fo/oauth/callback") return await oauthCallback(oauth.fo, "Fo", url, res);
      if (!url.pathname.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") return send(405, { error: "Method not allowed." });
        return serveStatic(url, res);
      }

      if (fromExtension) {
        // The paired side panel authenticates with a bearer token bound to its own origin. A token
        // isn't sent automatically by the browser, so cross-site request forgery doesn't apply.
        if (method === "OPTIONS") {
          res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Max-Age": "600" });
          return res.end();
        }
        if (url.pathname === "/api/extension/pair" && method === "POST") {
          const body = await readJson(req);
          return send(200, pairExtension(app.db, origin!, str(body, "code") ?? ""));
        }
        if (!verifyExtensionToken(app.db, origin!, req.headers.authorization)) return send(401, { error: "Pair this side panel with Kiki first.", code: "not_paired" });
        if (url.pathname.startsWith("/api/extension/") || url.pathname.endsWith("/connect") || url.pathname.endsWith("/disconnect")) {
          return send(403, { error: "Do this in the Kiki web app." });
        }
      } else if (method === "POST") {
        // CSRF guard for the web app: a JSON body from one of our own origins only.
        if (origin && !allowedOrigins.has(origin)) return send(403, { error: "Cross-origin requests aren't allowed." });
        const site = req.headers["sec-fetch-site"];
        if (site && !["same-origin", "none"].includes(String(site))) return send(403, { error: "Cross-site requests aren't allowed." });
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "Send JSON." });
      }

      const match = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!match) throw notFound();
      const params = match.pattern.exec(url.pathname)!.slice(1);
      const body = method === "POST" ? await readJson(req) : {};
      const result = await match.handler(params, body, url, origin);
      send(200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof AppError) return send(err.status, { error: err.message, code: err.code });
      const name = err instanceof Error ? err.name : "";
      if (name === "DriveError" || name === "FoCallError") {
        return send(502, { error: err instanceof Error ? err.message : String(err) });
      }
      console.error("Request failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      send(500, { error: "Something went wrong on the server." });
    }
  });
}
