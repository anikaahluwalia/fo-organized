import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { DbOAuthProvider } from "./oauth.ts";
import { redact } from "../secrets.ts";
import {
  FoCallError,
  FoConversationListSchema,
  FoConversationSchema,
  FoReplySchema,
  type FoClient,
  type FoConnection,
  type FoConversationSummary,
  type FoReply,
  type FoTurn,
} from "./types.ts";

/** Network errors raised before a request is written: the server cannot have received it. */
const PRE_SEND_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** Maps any failure to whether the request could have reached Fo. Unknown is the default. */
export function classifyFoError(err: unknown, stage: "connect" | "call"): FoCallError {
  if (err instanceof FoCallError) return err;
  const message = redact(err instanceof Error ? err.message : String(err));
  if (err instanceof UnauthorizedError) return new FoCallError("Fo isn't connected. Sign in to Wajo first.", "not_sent", "not_connected");
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
    return new FoCallError("Wajo rejected the sign-in. Connect Fo again.", "not_sent", "not_connected");
  }
  if (errorCodes(err).some((c) => PRE_SEND_CODES.has(c))) return new FoCallError(`Couldn't reach Fo (${message}).`, "not_sent", "unreachable");
  if (stage === "connect") return new FoCallError(`Couldn't start a session with Fo (${message}).`, "not_sent", "unreachable");
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return new FoCallError("Timed out waiting for Fo's response.", "unknown", "timeout");
  return new FoCallError(`Lost contact with Fo during the request (${message}).`, "unknown", "other");
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
}

function resultText(result: ToolResult): string {
  return (result.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
}

function resultPayload(result: ToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class LiveFoClient implements FoClient {
  readonly mode = "live" as const;
  private readonly serverUrl: string;
  private readonly provider: DbOAuthProvider;
  /** A Wajo API key (wak_…), sent as a bearer token in place of the sign-in. Server-side only. */
  private readonly apiKey: string | null;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private lastCheck: { at: number; value: FoConnection } | null = null;

  constructor(serverUrl: string, provider: DbOAuthProvider, apiKey: string | null = null) {
    this.serverUrl = serverUrl;
    this.provider = provider;
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const transport = new StreamableHTTPClientTransport(
        new URL(this.serverUrl),
        this.apiKey ? { requestInit: { headers: { Authorization: `Bearer ${this.apiKey}` } } } : { authProvider: this.provider },
      );
      const client = new Client({ name: "kiki", version: "0.1.0" });
      client.onclose = () => {
        if (this.client === client) this.client = null;
      };
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private reset(): void {
    const c = this.client;
    this.client = null;
    this.lastCheck = null;
    void c?.close().catch(() => undefined);
  }

  private async call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let client: Client;
    try {
      client = await this.getClient();
    } catch (err) {
      this.reset();
      throw classifyFoError(err, "connect");
    }
    let result: ToolResult;
    try {
      result = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true })) as ToolResult;
    } catch (err) {
      const classified = classifyFoError(err, "call");
      if (classified.kind === "not_connected" || classified.kind === "other") this.reset();
      throw classified;
    }
    if (result.isError) {
      throw new FoCallError(`Fo returned an error: ${resultText(result) || "no details"}`, "unknown", "tool_error");
    }
    const payload = resultPayload(result);
    if (payload === undefined) throw new FoCallError("Fo's response wasn't in the documented format.", "unknown", "malformed");
    return payload;
  }

  private parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, payload: unknown): T {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new FoCallError("Fo's response wasn't in the documented format.", "unknown", "malformed");
    return parsed.data;
  }

  async askFo(args: { message: string; conversationId?: string; newConversation?: boolean }): Promise<FoReply> {
    if (args.conversationId && args.newConversation) throw new Error("conversationId and newConversation can't be combined");
    const payload = await this.call("ask_fo", { ...args }, 90_000);
    return this.parse(FoReplySchema, payload);
  }

  async getFoReply(args: { conversationId: string; waitSeconds: number }): Promise<FoReply> {
    const waitSeconds = Math.max(0, Math.min(40, Math.round(args.waitSeconds)));
    const payload = await this.call("get_fo_reply", { conversationId: args.conversationId, waitSeconds }, (waitSeconds + 30) * 1000);
    return this.parse(FoReplySchema, payload);
  }

  async listConversations(): Promise<FoConversationSummary[]> {
    const payload = await this.call("list_fo_conversations", {}, 30_000);
    return this.parse(FoConversationListSchema, payload).conversations ?? [];
  }

  async getConversation(conversationId: string): Promise<FoTurn[]> {
    const payload = await this.call("get_fo_conversation", { conversationId }, 30_000);
    return this.parse(FoConversationSchema, payload).turns ?? [];
  }

  /** Verifies the sign-in with a read-only call. Cached briefly so status polling stays cheap. */
  async connection(): Promise<FoConnection> {
    if (!this.apiKey && !this.provider.hasTokens()) return { state: "needs_auth" };
    if (this.lastCheck && Date.now() - this.lastCheck.at < 5 * 60_000) return this.lastCheck.value;
    let value: FoConnection;
    try {
      await this.listConversations();
      value = { state: "connected" };
    } catch (err) {
      const e = classifyFoError(err, "call");
      value = e.kind === "not_connected" ? { state: "needs_auth" } : { state: "error", message: e.message };
    }
    this.lastCheck = { at: Date.now(), value };
    return value;
  }

  async beginAuth(): Promise<{ authorizationUrl: string } | { alreadyAuthorized: true }> {
    if (this.apiKey) return { alreadyAuthorized: true };
    this.provider.pendingAuthorizationUrl = null;
    const result = await auth(this.provider, { serverUrl: this.serverUrl, scope: "mcp" });
    if (result === "AUTHORIZED") {
      this.reset();
      return { alreadyAuthorized: true };
    }
    if (!this.provider.pendingAuthorizationUrl) throw new Error("Wajo didn't return a sign-in URL.");
    return { authorizationUrl: this.provider.pendingAuthorizationUrl };
  }

  async finishAuth(code: string, state: string | null): Promise<void> {
    if (!this.provider.consumeState(state)) throw new Error("Sign-in state didn't match. Start connecting again.");
    await auth(this.provider, { serverUrl: this.serverUrl, authorizationCode: code });
    this.reset();
  }

  disconnect(): void {
    this.provider.invalidateCredentials("all");
    this.reset();
  }
}
