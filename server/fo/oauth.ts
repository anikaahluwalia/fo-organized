import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { kvGet, kvSet, type Db } from "../db.ts";

const KEYS = {
  client: "fo.oauth.client",
  tokens: "fo.oauth.tokens",
  verifier: "fo.oauth.verifier",
  state: "fo.oauth.state",
  discovery: "fo.oauth.discovery",
} as const;

function readJson<T>(db: Db, key: string): T | undefined {
  const raw = kvGet(db, key);
  return raw === undefined ? undefined : (JSON.parse(raw) as T);
}

/**
 * OAuth client for the Fo MCP server (dynamic client registration + PKCE, public client).
 * Credentials live only in the local SQLite database under .data/, never in the browser or logs.
 */
export class DbOAuthProvider implements OAuthClientProvider {
  private readonly db: Db;
  private readonly redirect: string;
  /** Set by the SDK when the user has to sign in; read by the /api/fo/connect handler. */
  pendingAuthorizationUrl: string | null = null;

  constructor(db: Db, redirectUrl: string) {
    this.db = db;
    this.redirect = redirectUrl;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Paper Chase (local)",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp",
    };
  }

  state(): string {
    const value = randomBytes(24).toString("hex");
    kvSet(this.db, KEYS.state, value);
    return value;
  }

  /** Checks and consumes the OAuth state from the callback. */
  consumeState(received: string | null): boolean {
    const expected = kvGet(this.db, KEYS.state);
    kvSet(this.db, KEYS.state, undefined);
    if (!expected || !received || expected.length !== received.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readJson(this.db, KEYS.client);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    kvSet(this.db, KEYS.client, JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    return readJson(this.db, KEYS.tokens);
  }

  saveTokens(tokens: OAuthTokens): void {
    kvSet(this.db, KEYS.tokens, JSON.stringify(tokens));
  }

  hasTokens(): boolean {
    return kvGet(this.db, KEYS.tokens) !== undefined;
  }

  redirectToAuthorization(url: URL): void {
    this.pendingAuthorizationUrl = url.toString();
  }

  saveCodeVerifier(verifier: string): void {
    kvSet(this.db, KEYS.verifier, verifier);
  }

  codeVerifier(): string {
    const v = kvGet(this.db, KEYS.verifier);
    if (!v) throw new Error("No PKCE code verifier saved; start sign-in again.");
    return v;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    kvSet(this.db, KEYS.discovery, JSON.stringify(state));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readJson(this.db, KEYS.discovery);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") kvSet(this.db, KEYS.client, undefined);
    if (scope === "all" || scope === "tokens") kvSet(this.db, KEYS.tokens, undefined);
    if (scope === "all" || scope === "verifier") kvSet(this.db, KEYS.verifier, undefined);
    if (scope === "all" || scope === "discovery") kvSet(this.db, KEYS.discovery, undefined);
  }
}
