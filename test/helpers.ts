import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp, type App } from "../server/app.ts";
import { openDb, type Db } from "../server/db.ts";
import { MockReader } from "../server/extractor.ts";
import { MockFoClient } from "../server/fo/mock.ts";
import type { FoClient, FoConnection, FoConversationSummary, FoReply, FoTurn } from "../server/fo/types.ts";
import { FakeDrive } from "../server/google/fake.ts";

export type AskArgs = { message: string; conversationId?: string; newConversation?: boolean };
export type PollArgs = { conversationId: string; waitSeconds: number };

/** A scriptable Fo: each test decides what ask_fo and get_fo_reply do. Reports itself as live. */
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

export const reply = (conversationId: string, status: FoReply["status"], extra: Partial<FoReply> = {}): FoReply => ({ status, conversationId, ...extra });

export function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-test-"));
  return path.join(dir, `${randomUUID()}.db`);
}

export interface TestRig {
  app: App;
  db: Db;
  drive: FakeDrive;
  fo: FoClient;
}

/**
 * An app wired to an in-memory Drive (FakeDrive), the pattern reader and a mock or scripted Fo.
 * Background folder polling is off: tests call app.settle() to run due jobs deterministically.
 */
export function makeRig(opts: { drive?: FakeDrive; fo?: FoClient; db?: Db | string } = {}): TestRig {
  const db = opts.db === undefined ? openDb(":memory:") : typeof opts.db === "string" ? openDb(opts.db) : opts.db;
  const drive = opts.drive ?? new FakeDrive("mock");
  const fo = opts.fo ?? new MockFoClient({ stepMs: 5, replyDelayMs: 0 });
  const app = createApp({
    db,
    drive,
    reader: new MockReader(),
    fo,
    anthropicModel: "test-model",
    claudeCredentialsDetected: false,
    engineOptions: { pollWaitSeconds: 0, backoffBaseMs: 1 },
    watchIntervalSeconds: 0,
    workspacePollSeconds: 0,
  });
  return { app, db, drive, fo };
}

/** Creates the demo folder, reads it, and applies the first organizing plan (9 verified steps). */
export async function organized(rig: TestRig): Promise<void> {
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  if (!plan) throw new Error("expected an organizing proposal");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `setup-${plan.id}` });
  await rig.app.settle();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
