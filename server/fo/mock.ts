import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { FoClient, FoConversationSummary, FoReply, FoTurn } from "./types.ts";

interface MockConversation {
  id: string;
  startedAt: string;
  turns: FoTurn[];
  pending: { progress: string[]; final: string; awaitingUser?: boolean } | null;
  /** A proposal Fo brought you and is waiting on: your next message is the answer. */
  decision: { requestId: string; planId: string; contentHash: string } | null;
  turnStartedAt: number;
  contractor: string | null;
  sentAt: number | null;
  replyPosted: boolean;
}

export const MOCK_NOTE = "(Mock Fo: simulated. Nothing was sent and nobody was contacted.)";

/** How the mock reads your answer to a proposal. Real Fo understands far more; this is only for rehearsals. */
export function mockDecision(answer: string): "approved" | "declined" | "changes_requested" | "clarification" {
  const a = answer.toLowerCase();
  if (/\b(skip|rename|call (it|the|them)|keep (the |their |its )?names?|don'?t rename|instead|put|move|goes? (under|in)|is for|are for|folder|leave out|don'?t bother)\b/.test(a)) return "changes_requested";
  if (/\?\s*$/.test(a.trim())) return "clarification";
  if (/\b(no|nope|don'?t|not now|decline|leave it)\b/.test(a)) return "declined";
  if (/\b(yes|yep|go ahead|do it|approve|sounds good|ok|okay|sure)\b/.test(a)) return "approved";
  return "clarification";
}

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
  private lastSms: MockConversation | null = null;

  /** Rehearsal/test helper: the user texts back, as if replying on their phone. */
  replyToLastText(text: string): void {
    this.lastSms?.turns.push({ role: "user", text, at: new Date().toISOString() });
    if (this.lastSms) {
      this.conversations.delete(this.lastSms.id);
      this.conversations.set(this.lastSms.id, this.lastSms);
    }
  }

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
      convo = { id: `mock-${randomUUID()}`, startedAt: new Date().toISOString(), turns: [], pending: null, turnStartedAt: Date.now(), contractor: null, sentAt: null, replyPosted: false, decision: null };
      this.conversations.set(convo.id, convo);
    }
    convo.turns.push({ role: "user", text: args.message, at: new Date().toISOString() });
    convo.turnStartedAt = Date.now();
    this.maybePostReply(convo);

    const handoff = /Kiki approval handoff[^\n]*\n(\{[^\n]*\})/.exec(args.message);
    const answer = /^Answer from the account holder \(data\): ("(?:[^"\\]|\\.)*")/.exec(args.message);
    if (answer && convo.decision) {
      const said = JSON.parse(answer[1]!) as string;
      const decision = { ...convo.decision, decision: mockDecision(said), userReply: said.trim().slice(0, 2000), actor: "account_holder", presentedExactProposal: true };
      convo.decision = null;
      convo.pending = { progress: [], final: `${MOCK_NOTE}\nThanks, I'll let Kiki know.\nKIKI-DECISION: ${JSON.stringify(decision)}` };
    } else if (handoff && !/^Please text me/.test(args.message)) {
      convo.decision = JSON.parse(handoff[1]!) as MockConversation["decision"];
      const proposal = args.message.split("\n").filter((l) => /^(Kiki's proposal|\d+\. |Not moved)/.test(l)).join("\n");
      convo.pending = { progress: ["Reading Kiki's proposal (mock)…"], final: `${MOCK_NOTE}\nHere's what Kiki proposes:\n${proposal}\nWould you like Kiki to go ahead, change something, or leave it?`, awaitingUser: true };
    } else if (/don't send the email/.test(args.message)) {
      convo.pending = { progress: [], final: `${MOCK_NOTE}\nOkay, I won't send it.\nKIKI-STATUS: NOT-SENT` };
    } else if (/^Please text me/.test(args.message)) {
      const body = /-----BEGIN APPROVED BODY-----\n([\s\S]*?)\n-----END APPROVED BODY-----/.exec(args.message)?.[1] ?? "";
      const sms: MockConversation = { id: `mock-sms-${randomUUID()}`, startedAt: new Date().toISOString(), turns: [{ role: "assistant", text: body, at: new Date().toISOString() }], pending: null, turnStartedAt: Date.now(), contractor: null, sentAt: null, replyPosted: true, decision: null };
      this.conversations.set(sms.id, sms);
      this.lastSms = sms;
      convo.pending = { progress: ["Texting you (mock)…"], final: `${MOCK_NOTE}\nI would have texted you Kiki's message.\nKIKI-STATUS: SENT` };
    } else if (/^Please send me \(nobody else\)/.test(args.message)) {
      convo.pending = { progress: ["Sending you the note (mock)…"], final: `${MOCK_NOTE}\nI would have sent you Kiki's note. In mock mode nothing leaves this computer.\nKIKI-STATUS: SENT` };
    } else if (/-----BEGIN APPROVED BODY-----/.test(args.message)) {
      const to = /^To: (.+?) </m.exec(args.message)?.[1] ?? null;
      convo.contractor = to ?? "The contractor";
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
      const { final, awaitingUser } = convo.pending;
      convo.pending = null;
      convo.turns.push({ role: "assistant", text: final, at: new Date().toISOString() });
      // Only an email to a contractor gets a (simulated) answer; a text to you doesn't answer itself.
      if (/KIKI-STATUS: SENT/.test(final) && convo.contractor !== null) convo.sentAt = Date.now();
      return { status: "complete", conversationId: convo.id, response: final, ...(awaitingUser ? { awaitingUser: true } : {}) };
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
