// LIVE-X12: when the access token needs refreshing and Google's token endpoint has a passing
// problem (HTTP 500/503), GoogleAuth reports it as a sign-in failure (kind "auth"). Drive calls
// then fail as "not retryable": the executor pauses an approved plan with "Google sign-in
// expired. Reconnect Google Drive, then retry the unfinished steps." and the header asks you to
// connect again, though nothing is wrong with the sign-in. Fakes never refresh tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kvGet, kvSet, openDb } from "../../server/db.ts";
import { GoogleAuth } from "../../server/google/oauth.ts";
import { DriveError } from "../../server/google/types.ts";

test("a passing error from Google's token endpoint is retryable, and the sign-in is kept", async (t) => {
  const db = openDb(":memory:");
  kvSet(db, "google.oauth.tokens", JSON.stringify({ access_token: "old", expires_at: Date.now() - 1000, refresh_token: "refresh-1", scope: "https://www.googleapis.com/auth/drive" }));
  const auth = new GoogleAuth(db, { clientId: "client", clientSecret: "secret", redirectUri: "http://localhost:8787/api/google/oauth/callback", scopes: ["https://www.googleapis.com/auth/drive"] });
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "internal_failure", error_description: "Backend Error" }), { status: 503, headers: { "content-type": "application/json" } })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
    db.close();
  });
  const err = await auth.accessToken().then(() => null, (e: DriveError) => e);
  assert.ok(kvGet(db, "google.oauth.tokens"), "the stored sign-in is kept");
  assert.deepEqual({ kind: err?.kind, retryable: err?.retryable }, { kind: "server", retryable: true }, `GoogleAuth said: ${err?.kind}: ${err?.message}`);
});
