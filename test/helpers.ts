import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp, type App } from "../server/app.ts";
import { openDb, type Db } from "../server/db.ts";
import { MockExtractor } from "../server/extractor.ts";
import type { FoClient, FoConnection, FoConversationSummary, FoReply, FoTurn } from "../server/fo/types.ts";

export type AskArgs = { message: string; conversationId?: string; newConversation?: boolean };
export type PollArgs = { conversationId: string; waitSeconds: number };

/** A scriptable Fo. Each test decides what ask_fo and get_fo_reply do. */
export class FakeFo implements FoClient {
  readonly mode = "live" as const;
  asks: AskArgs[] = [];
  polls: PollArgs[] = [];
  conversations: FoConversationSummary[] = [];
  transcripts = new Map<string, FoTurn[]>();
  onAsk: (args: AskArgs, n: number) => Promise<FoReply> = async () => {
    throw new Error("no ask script");
  };
  onPoll: (args: PollArgs, n: number) => Promise<FoReply> = async () => {
    throw new Error("no poll script");
  };

  async askFo(args: AskArgs): Promise<FoReply> {
    if (args.conversationId && args.newConversation) throw new Error("conversationId and newConversation can't be combined");
    this.asks.push(args);
    return this.onAsk(args, this.asks.length);
  }
  async getFoReply(args: PollArgs): Promise<FoReply> {
    this.polls.push(args);
    return this.onPoll(args, this.polls.length);
  }
  async listConversations(): Promise<FoConversationSummary[]> {
    return this.conversations;
  }
  async getConversation(conversationId: string): Promise<FoTurn[]> {
    return this.transcripts.get(conversationId) ?? [];
  }
  async connection(): Promise<FoConnection> {
    return { state: "connected" };
  }
}

export function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-chase-test-"));
  return path.join(dir, `${randomUUID()}.db`);
}

export function makeApp(fo: FoClient, dbOrPath: Db | string = ":memory:"): App {
  const db = typeof dbOrPath === "string" ? openDb(dbOrPath) : dbOrPath;
  return createApp({
    db,
    fo,
    extractor: new MockExtractor(),
    anthropicModel: "test-model",
    claudeCredentialsDetected: false,
    engineOptions: { pollWaitSeconds: 0, backoffBaseMs: 1 },
  });
}

/** Creates the staged ordinary request, confirms its checklist and marks the guarantor letter missing. */
export async function readyRequest(app: App, demoKey = "maple-street") {
  const { id } = app.createRequest({ demoKey });
  await app.whenIdle();
  let view = (await app.view(id)).current!;
  app.confirmChecklist(id, view.items.map((i) => ({ id: i.id })));
  view = (await app.view(id)).current!;
  const guarantor = view.items.find((i) => /guarantor/i.test(i.label))!;
  app.decideItem(guarantor.id, "missing");
  return { requestId: id, guarantorId: guarantor.id };
}

/** A request plus an approved-ready draft to mom@example.com. Returns the draft's version and hash. */
export async function readyDraft(app: App, demoKey = "maple-street") {
  const ids = await readyRequest(app, demoKey);
  app.setStudentName("Anika");
  const { versionId } = app.createDraft(ids.guarantorId, { recipientName: "Mom", recipientEmail: "mom@example.com" });
  const draft = (await app.view(ids.requestId)).current!.outreach[0]!.draft!;
  return { ...ids, versionId, contentHash: draft.contentHash };
}

export async function outreach(app: App, requestId: string) {
  return (await app.view(requestId)).current!.outreach[0]!;
}

export const reply = (conversationId: string, status: FoReply["status"], extra: Partial<FoReply> = {}): FoReply => ({ status, conversationId, ...extra });

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
