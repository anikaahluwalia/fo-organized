import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { kvGet, kvSet, type Db } from "../db.ts";
import { DriveError } from "./types.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const KEYS = { tokens: "google.oauth.tokens", state: "google.oauth.state", verifier: "google.oauth.verifier" } as const;

interface StoredTokens {
  access_token: string;
  expires_at: number;
  refresh_token: string | null;
  scope: string;
}

/**
 * Server-side Google OAuth (authorization code + PKCE). Tokens live only in the local SQLite
 * database under .data/: never in the browser, prompts, logs or the repository.
 */
export class GoogleAuth {
  private readonly db: Db;
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly redirectUri: string;
  readonly scopes: string[];

  constructor(db: Db, opts: { clientId: string | null; clientSecret: string | null; redirectUri: string; scopes: string[] }) {
    this.db = db;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri;
    this.scopes = opts.scopes;
  }

  configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private tokens(): StoredTokens | null {
    const raw = kvGet(this.db, KEYS.tokens);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  }

  hasTokens(): boolean {
    return this.tokens() !== null;
  }

  /** Scopes Google actually granted (the user can untick some on the consent screen). */
  grantedScopes(): string[] {
    return this.tokens()?.scope.split(" ").filter(Boolean) ?? [];
  }

  missingScopes(): string[] {
    const granted = new Set(this.grantedScopes());
    return this.scopes.filter((s) => !granted.has(s));
  }

  beginAuth(): string {
    if (!this.configured()) throw new DriveError("Google sign-in isn't configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.", "auth", { delivery: "not_sent" });
    const state = randomBytes(24).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    kvSet(this.db, KEYS.state, state);
    kvSet(this.db, KEYS.verifier, verifier);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async finishAuth(code: string, state: string | null): Promise<void> {
    const expected = kvGet(this.db, KEYS.state);
    kvSet(this.db, KEYS.state, undefined);
    if (!expected || !state || expected.length !== state.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(state))) {
      throw new Error("Google sign-in state didn't match. Start connecting again.");
    }
    const verifier = kvGet(this.db, KEYS.verifier);
    kvSet(this.db, KEYS.verifier, undefined);
    const body = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      ...(verifier ? { code_verifier: verifier } : {}),
    });
    this.store(body, null);
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.clientId!, client_secret: this.clientSecret!, ...params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new DriveError(`Couldn't reach Google sign-in (${err instanceof Error ? err.message : String(err)}).`, "network", { delivery: "not_sent" });
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (body.error === "invalid_grant") {
        kvSet(this.db, KEYS.tokens, undefined);
        throw new DriveError("Google sign-in expired. Connect Google Drive again.", "auth", { status: res.status, reason: "invalid_grant", delivery: "not_sent" });
      }
      throw new DriveError(`Google sign-in failed: ${String(body.error_description ?? body.error ?? res.status)}`, "auth", { status: res.status, delivery: "not_sent" });
    }
    return body;
  }

  private store(body: Record<string, unknown>, previousRefresh: string | null): void {
    const tokens: StoredTokens = {
      access_token: String(body.access_token),
      expires_at: Date.now() + Number(body.expires_in ?? 3600) * 1000,
      refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh,
      scope: typeof body.scope === "string" ? body.scope : (this.tokens()?.scope ?? ""),
    };
    kvSet(this.db, KEYS.tokens, JSON.stringify(tokens));
  }

  /** A valid access token, refreshed when it is about to expire. */
  async accessToken(forceRefresh = false): Promise<string> {
    const tokens = this.tokens();
    if (!tokens) throw new DriveError("Google Drive isn't connected.", "auth", { delivery: "not_sent" });
    if (!forceRefresh && tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
    if (!tokens.refresh_token) {
      kvSet(this.db, KEYS.tokens, undefined);
      throw new DriveError("Google sign-in expired. Connect Google Drive again.", "auth", { delivery: "not_sent" });
    }
    const body = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    this.store(body, tokens.refresh_token);
    return String(body.access_token);
  }

  async disconnect(): Promise<void> {
    const tokens = this.tokens();
    kvSet(this.db, KEYS.tokens, undefined);
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (token) {
      await fetch(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) }).catch(
        () => undefined,
      );
    }
  }
}
