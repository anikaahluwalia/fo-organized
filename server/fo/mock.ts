import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { FoClient, FoConversationSummary, FoReply, FoTurn } from "./types.ts";

interface MockConversation {
  id: string;
  startedAt: string;
  turns: FoTurn[];
  pending: { progress: string[]; final: string } | null;
  turnStartedAt: number;
  contractor: string | null;
  sentAt: number | null;
  replyPosted: boolean;
}

export const MOCK_NOTE = "(Mock Fo: simulated. Nothing was sent and nobody was contacted.)";

/**
 * A clearly labelled stand-in for Fo, used only when FO_MODE=mock. It plays a short
 * working -> complete sequence for an approved email, then, after replyDelayMs, adds a simulated
 * contractor reply to the same conversation so the "Kiki picks up the outcome" loop can be
 * rehearsed. It never contacts anyone.
 */
export class MockFoClient implements FoClient {
  readonly mode = "mock" as const;
  private conversations = new Map<string, MockConversation>();
  private readonly stepMs: number;
  private readonly replyDelayMs: number;
  /** What the simulated contractor says. */
  contractorReply = "No, use the revised quote I emailed today.";

  constructor(options: { stepMs?: number; replyDelayMs?: number } = {}) {
    this.stepMs = options.stepMs ?? 1200;
    this.replyDelayMs = options.replyDelayMs ?? 8000;
  }

  async connection() {
    return { state: "connected" as const };
  }

  private maybePostReply(convo: MockConversation): void {
    if (convo.sentAt === null || convo.replyPosted || Date.now() - convo.sentAt < this.replyDelayMs) return;
    convo.replyPosted = true;
    const who = convo.contractor ?? "The contractor";
    convo.turns.push({ role: "assistant", text: `${MOCK_NOTE}\n${who} replied: "${this.contractorReply}"`, at: new Date().toISOString() });
  }

  async askFo(args: { message: string; conversationId?: string; newConversation?: boolean }): Promise<FoReply> {
    if (args.conversationId && args.newConversation) throw new Error("conversationId and newConversation can't be combined");
    let convo = args.conversationId ? this.conversations.get(args.conversationId) : undefined;
    if (args.conversationId && !convo) throw new Error("Unknown conversation");
    if (!convo) {
      convo = { id: `mock-${randomUUID()}`, startedAt: new Date().toISOString(), turns: [], pending: null, turnStartedAt: Date.now(), contractor: null, sentAt: null, replyPosted: false };
      this.conversations.set(convo.id, convo);
    }
    convo.turns.push({ role: "user", text: args.message, at: new Date().toISOString() });
    convo.turnStartedAt = Date.now();
    this.maybePostReply(convo);

    if (/don't send the email/.test(args.message)) {
      convo.pending = { progress: [], final: `${MOCK_NOTE}\nOkay, I won't send it.\nKIKI-STATUS: NOT-SENT` };
    } else if (/send ME \(the account holder/.test(args.message) && /text message \(SMS\)/.test(args.message)) {
      convo.pending = { progress: ["Texting you (mock)…"], final: `${MOCK_NOTE}\nI would have texted you Kiki's message.\nKIKI-STATUS: SENT` };
    } else if (/send ME \(the account holder/.test(args.message)) {
      convo.pending = { progress: ["Sending you the note (mock)…"], final: `${MOCK_NOTE}\nI would have sent you Kiki's note. In mock mode nothing leaves this computer.\nKIKI-STATUS: SENT` };
    } else if (/-----BEGIN APPROVED BODY-----/.test(args.message)) {
      const to = /^To: (.+?) </m.exec(args.message)?.[1] ?? null;
      convo.contractor = to;
      convo.pending = {
        progress: ["Preparing the approved email (mock)…"],
        final: `${MOCK_NOTE}\nI would have sent the approved email to ${to ?? "the contractor"}. I'll let you know here if they reply.\nKIKI-STATUS: SENT`,
      };
    } else {
      const reply = convo.turns.find((t) => t.role === "assistant" && /replied:/.test(t.text));
      convo.pending = { progress: [], final: `${MOCK_NOTE}\n${reply ? reply.text.replace(`${MOCK_NOTE}\n`, "") : "No reply from the contractor yet."}` };
    }
    await sleep(Math.min(this.stepMs, 300));
    return this.step(convo);
  }

  async getFoReply(args: { conversationId: string; waitSeconds: number }): Promise<FoReply> {
    const convo = this.conversations.get(args.conversationId);
    if (!convo) throw new Error("Unknown conversation");
    if (convo.pending && args.waitSeconds > 0) await sleep(Math.min(this.stepMs, args.waitSeconds * 1000));
    return this.step(convo);
  }

  private step(convo: MockConversation): FoReply {
    const elapsedSeconds = Math.round((Date.now() - convo.turnStartedAt) / 1000);
    if (convo.pending && convo.pending.progress.length > 0) {
      return { status: "working", conversationId: convo.id, progress: convo.pending.progress.shift()!, elapsedSeconds, response: "Fo is still working (mock)." };
    }
    if (convo.pending) {
      const final = convo.pending.final;
      convo.pending = null;
      convo.turns.push({ role: "assistant", text: final, at: new Date().toISOString() });
      if (/KIKI-STATUS: SENT/.test(final)) convo.sentAt = Date.now();
      return { status: "complete", conversationId: convo.id, response: final };
    }
    const last = [...convo.turns].reverse().find((t) => t.role === "assistant");
    return { status: "complete", conversationId: convo.id, response: last?.text ?? "" };
  }

  async listConversations(): Promise<FoConversationSummary[]> {
    return [...this.conversations.values()].reverse().slice(0, 50).map((c) => ({ conversationId: c.id, title: "Kiki (mock)", channel: "chat", startedAt: c.startedAt }));
  }

  async getConversation(conversationId: string): Promise<FoTurn[]> {
    const convo = this.conversations.get(conversationId);
    if (!convo) return [];
    this.maybePostReply(convo);
    return convo.turns.slice(-40);
  }
}
