import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { FoClient, FoConversationSummary, FoReply, FoTurn } from "./types.ts";

interface MockConversation {
  id: string;
  startedAt: string;
  turns: FoTurn[];
  /** Scripted steps still to play for the current turn: progress lines, then the final reply. */
  pending: { progress: string[]; final: string } | null;
  turnStartedAt: number;
}

const MOCK_NOTE = "(Mock Fo: simulated reply. Nothing was searched or sent.)";

function inventoryReply(message: string): string {
  const refs = [...message.matchAll(/^(C\d+)\. (.+)$/gm)].map((m) => ({ id: m[1]!, label: m[2]! }));
  const items = refs.map(({ id, label }) => {
    if (/guarantor/i.test(label)) return { id, status: "missing", files: [], note: "No guarantor letter in Drive." };
    if (/reference/i.test(label)) return { id, status: "unsure", files: [], note: "Found an old email draft that might be a reference; not sure." };
    if (/social security|banking/i.test(label)) return { id, status: "missing", files: [], note: "Nothing like this in Drive." };
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return { id, status: "found", files: [{ name: `MOCK ${slug}.pdf`, link: null }], note: "Mock candidate." };
  });
  return `${MOCK_NOTE}\n\n\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``;
}

/**
 * A clearly labelled stand-in for Fo, used only when FO_MODE=mock. It plays a short working ->
 * complete sequence so the UI and polling loop can be rehearsed. It never contacts anyone.
 */
export class MockFoClient implements FoClient {
  readonly mode = "mock" as const;
  private conversations = new Map<string, MockConversation>();
  private readonly stepMs: number;

  constructor(options: { stepMs?: number } = {}) {
    this.stepMs = options.stepMs ?? 1500;
  }

  async connection() {
    return { state: "connected" as const };
  }

  async askFo(args: { message: string; conversationId?: string; newConversation?: boolean }): Promise<FoReply> {
    if (args.conversationId && args.newConversation) throw new Error("conversationId and newConversation can't be combined");
    let convo = args.conversationId ? this.conversations.get(args.conversationId) : undefined;
    if (args.conversationId && !convo) throw new Error("Unknown conversation");
    if (!convo) {
      convo = { id: `mock-${randomUUID()}`, startedAt: new Date().toISOString(), turns: [], pending: null, turnStartedAt: Date.now() };
      this.conversations.set(convo.id, convo);
    }
    convo.turns.push({ role: "user", text: args.message, at: new Date().toISOString() });
    convo.turnStartedAt = Date.now();

    if (/read-only document check/.test(args.message)) {
      convo.pending = { progress: ["Looking through your Drive (mock)…", "Matching file names to the checklist (mock)…"], final: inventoryReply(args.message) };
    } else if (/don't send the email/.test(args.message)) {
      convo.pending = { progress: [], final: `${MOCK_NOTE}\nOkay, I won't send it.\nPAPER-CHASE-STATUS: NOT-SENT` };
    } else {
      const to = /^To: (.+)$/m.exec(args.message)?.[1] ?? "the recipient";
      convo.pending = {
        progress: ["Preparing the approved email (mock)…"],
        final: `${MOCK_NOTE}\nI would have sent the approved email to ${to}. In mock mode nothing leaves this computer.\nPAPER-CHASE-STATUS: SENT`,
      };
    }
    await sleep(Math.min(this.stepMs, 400));
    return this.step(convo);
  }

  async getFoReply(args: { conversationId: string; waitSeconds: number }): Promise<FoReply> {
    const convo = this.conversations.get(args.conversationId);
    if (!convo) throw new Error("Unknown conversation");
    if (convo.pending) await sleep(Math.min(this.stepMs, args.waitSeconds * 1000));
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
      return { status: "complete", conversationId: convo.id, response: final };
    }
    const last = [...convo.turns].reverse().find((t) => t.role === "assistant");
    return { status: "complete", conversationId: convo.id, response: last?.text ?? "" };
  }

  async listConversations(): Promise<FoConversationSummary[]> {
    return [...this.conversations.values()].reverse().slice(0, 50).map((c) => ({ conversationId: c.id, title: "Paper Chase (mock)", channel: "chat", startedAt: c.startedAt }));
  }

  async getConversation(conversationId: string): Promise<FoTurn[]> {
    return (this.conversations.get(conversationId)?.turns ?? []).slice(-40);
  }
}
