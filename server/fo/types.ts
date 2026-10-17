import { z } from "zod";

/** Mirrors the outputSchema the Fo MCP server publishes for ask_fo / get_fo_reply. */
export const FoReplySchema = z.object({
  status: z.enum(["complete", "working", "failed"]),
  conversationId: z.string().min(1),
  response: z.string().optional(),
  progress: z.string().optional(),
  elapsedSeconds: z.number().int().optional(),
});
export type FoReply = z.infer<typeof FoReplySchema>;

export const FoConversationListSchema = z.object({
  conversations: z
    .array(
      z.object({
        conversationId: z.string(),
        title: z.string(),
        channel: z.string(),
        startedAt: z.string().optional(),
      }),
    )
    .optional(),
});
export type FoConversationSummary = NonNullable<z.infer<typeof FoConversationListSchema>["conversations"]>[number];

export const FoConversationSchema = z.object({
  conversation: z.object({ conversationId: z.string(), title: z.string(), channel: z.string(), startedAt: z.string().optional() }),
  turns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string(), at: z.string().optional() })).optional(),
});
export type FoTurn = NonNullable<z.infer<typeof FoConversationSchema>["turns"]>[number];

/**
 * delivery tells the caller whether Fo could have received the request:
 * - "not_sent": the request provably never reached Fo (not signed in, host unreachable).
 * - "unknown": it may have reached Fo; the response was lost, timed out or was an error.
 */
export type FoDelivery = "not_sent" | "unknown";
export type FoErrorKind = "not_connected" | "unreachable" | "timeout" | "tool_error" | "malformed" | "other";

export class FoCallError extends Error {
  readonly delivery: FoDelivery;
  readonly kind: FoErrorKind;
  constructor(message: string, delivery: FoDelivery, kind: FoErrorKind) {
    super(message);
    this.name = "FoCallError";
    this.delivery = delivery;
    this.kind = kind;
  }
}

export type FoConnection =
  | { state: "connected" }
  | { state: "needs_auth" }
  | { state: "error"; message: string };

export interface FoClient {
  readonly mode: "live" | "mock";
  askFo(args: { message: string; conversationId?: string; newConversation?: boolean }): Promise<FoReply>;
  getFoReply(args: { conversationId: string; waitSeconds: number }): Promise<FoReply>;
  listConversations(): Promise<FoConversationSummary[]>;
  getConversation(conversationId: string): Promise<FoTurn[]>;
  connection(): Promise<FoConnection>;
}
