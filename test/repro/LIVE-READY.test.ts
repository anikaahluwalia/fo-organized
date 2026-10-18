// LIVE-READY: the live Drive, Gmail and Google sign-in code against Drive v3 / Gmail v1 / OAuth
// responses as Google sends them (a stubbed fetch; nothing leaves this machine). These pass: they
// are the parts of the audit that hold up. What doesn't hold up is in LIVE-X1 ... LIVE-X12.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { kvGet, kvSet, openDb } from "../../server/db.ts";
import { GMAIL_READONLY, LiveGmail } from "../../server/google/gmail.ts";
import { LiveDrive } from "../../server/google/live.ts";
import { GoogleAuth } from "../../server/google/oauth.ts";
import { DriveError, GOOGLE_SHEET_MIME, SHORTCUT_MIME } from "../../server/google/types.ts";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
type Seen = { method: string; url: URL; body: string };
type Reply = { status?: number; body: unknown };

function rig(t: TestContext, route: (req: Seen) => Reply, tokens: Record<string, unknown> = {}) {
  const db = openDb(":memory:");
  kvSet(db, "google.oauth.tokens", JSON.stringify({ access_token: "token-1", expires_at: Date.now() + 3_600_000, refresh_token: "refresh-1", scope: DRIVE_SCOPE, ...tokens }));
  const auth = new GoogleAuth(db, { clientId: "client", clientSecret: "secret", redirectUri: "http://localhost:8787/api/google/oauth/callback", scopes: [DRIVE_SCOPE] });
  const seen: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body === undefined ? "" : Buffer.isBuffer(init.body) ? init.body.toString("utf8") : String(init.body);
    const req = { method: init?.method ?? "GET", url, body };
    seen.push(req);
    const r = route(req);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
    db.close();
  });
  return { db, auth, drive: new LiveDrive(auth), gmail: new LiveGmail(auth), seen };
}

const file = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, mimeType: "application/pdf", parents: ["ws"], version: "3", md5Checksum: `md5-${id}`, modifiedTime: "2026-10-17T12:00:00.000Z", createdTime: "2026-10-17T11:00:00.000Z", size: "1200", ...extra });
const driveError = (status: number, reason: string, message = reason) => ({ status, body: { error: { code: status, message, errors: [{ reason, message }] } } });

test("listing a folder follows every page and asks for shared-drive items", async (t) => {
  const { drive, seen } = rig(t, ({ url }) =>
    url.searchParams.get("pageToken") === "p2" ? { body: { files: [file("c")] } } : { body: { files: [file("a"), file("b")], nextPageToken: "p2" } },
  );
  const files = await drive.listChildren("ws", "0ASharedDrive");
  assert.deepEqual(files.map((f) => f.id), ["a", "b", "c"]);
  const first = seen[0]!.url.searchParams;
  assert.equal(first.get("q"), "'ws' in parents and trashed = false");
  assert.equal(first.get("supportsAllDrives"), "true");
  assert.equal(first.get("includeItemsFromAllDrives"), "true");
  assert.equal(first.get("corpora"), "drive");
  assert.equal(first.get("driveId"), "0ASharedDrive");
  assert.match(first.get("fields") ?? "", /nextPageToken,files\(.*md5Checksum.*capabilities\(canRename,canMoveItemWithinDrive,canAddChildren\)/);
});

test("Drive's metadata maps over: trashed, shortcuts, capabilities, Sheets without md5", async (t) => {
  const { drive } = rig(t, ({ url }) => {
    const id = url.pathname.split("/").pop()!;
    if (id === "trashed") return { body: file("trashed", { trashed: true }) };
    if (id === "shortcut") return { body: file("shortcut", { mimeType: SHORTCUT_MIME, md5Checksum: undefined, shortcutDetails: { targetId: "elsewhere" } }) };
    if (id === "viewonly") return { body: file("viewonly", { capabilities: { canRename: false, canMoveItemWithinDrive: false, canAddChildren: false } }) };
    return { body: file("sheet", { mimeType: GOOGLE_SHEET_MIME, md5Checksum: undefined, modifiedTime: "2026-10-17T12:30:00.000Z" }) };
  });
  assert.equal((await drive.getFile("trashed")).trashed, true, "files.get returns trashed files; callers check .trashed");
  assert.equal((await drive.getFile("shortcut")).shortcutTargetId, "elsewhere");
  assert.deepEqual((await drive.getFile("viewonly")).capabilities, { canRename: false, canMove: false, canAddChildren: false });
  assert.equal((await drive.getFile("sheet")).contentKey, "2026-10-17T12:30:00.000Z", "no md5Checksum: the modified time stands in (see LIVE-X3)");
});

test("rate limits and server errors are retryable; permission problems aren't; 5xx may have applied", async (t) => {
  const replies: Record<string, Reply> = {
    rate: driveError(403, "rateLimitExceeded", "Rate Limit Exceeded"),
    user: driveError(403, "userRateLimitExceeded", "User Rate Limit Exceeded"),
    many: driveError(429, "rateLimitExceeded", "Rate Limit Exceeded"),
    locked: driveError(403, "insufficientFilePermissions", "The user does not have sufficient permissions for file locked."),
    down: { status: 503, body: { error: { code: 503, message: "Backend Error" } } },
  };
  const { drive } = rig(t, ({ url }) => replies[url.pathname.split("/").pop()!]!);
  const kind = (id: string) => drive.getFile(id).then(() => "ok", (e: DriveError) => `${e.kind}/${e.retryable ? "retry" : "final"}/${e.delivery}`);
  assert.deepEqual(
    { rate: await kind("rate"), user: await kind("user"), many: await kind("many"), locked: await kind("locked"), down: await kind("down") },
    { rate: "rate_limit/retry/not_sent", user: "rate_limit/retry/not_sent", many: "rate_limit/retry/not_sent", locked: "permission/final/not_sent", down: "server/retry/unknown" },
  );
});

test("a rejected access token is refreshed once and the request retried", async (t) => {
  let calls = 0;
  const { drive, db } = rig(t, ({ url }) => {
    if (url.hostname === "oauth2.googleapis.com") return { body: { access_token: "token-2", expires_in: 3599, scope: DRIVE_SCOPE, token_type: "Bearer" } };
    return ++calls === 1 ? driveError(401, "authError", "Invalid Credentials") : { body: file("a") };
  });
  assert.equal((await drive.getFile("a")).id, "a");
  assert.equal(JSON.parse(kvGet(db, "google.oauth.tokens")!).access_token, "token-2");
});

test("a revoked or expired refresh token (Testing apps: every 7 days) asks you to connect again", async (t) => {
  const { drive, db } = rig(
    t,
    ({ url }) => (url.hostname === "oauth2.googleapis.com" ? { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } : { body: file("a") }),
    { expires_at: Date.now() - 1000 },
  );
  await assert.rejects(drive.getFile("a"), (e: DriveError) => e.kind === "auth" && /Connect Google Drive again/.test(e.message));
  assert.equal(kvGet(db, "google.oauth.tokens"), undefined, "the dead tokens are dropped");
  assert.deepEqual(await drive.connection(), { state: "needs_auth" });
});

test("Gmail is offered only when Google actually granted gmail.readonly", (t) => {
  assert.equal(rig(t, () => ({ body: {} })).gmail.available(), false);
  assert.equal(rig(t, () => ({ body: {} }), { scope: `${DRIVE_SCOPE} ${GMAIL_READONLY}` }).gmail.available(), true);
});

test("an upload carries the pre-generated id, so a retry can't make a second copy", async (t) => {
  const { drive, seen } = rig(t, () => ({ body: file("pre-generated", { mimeType: "text/csv" }) }));
  await drive.createFile({ id: "pre-generated", name: "Flooring - document index (kept by Kiki).csv", parentId: "ws", mimeType: "text/csv", content: "Type,Status\r\n" });
  const up = seen[0]!;
  assert.equal(up.url.pathname, "/upload/drive/v3/files");
  assert.equal(up.url.searchParams.get("uploadType"), "multipart");
  assert.match(up.body, /"id":"pre-generated","name":"Flooring - document index \(kept by Kiki\)\.csv","parents":\["ws"\],"mimeType":"text\/csv"/);
});

