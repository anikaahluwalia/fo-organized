/**
 * Answering Fo by text. A text reply lands in a separate Fo conversation (a different surface), so
 * Kiki makes the link, as Wajo advises: while a proposal waits for your decision, a text you send
 * Fo after Kiki's question is a candidate answer. Kiki can't read texts directly, but Fo can: Kiki
 * asks Fo, in Kiki's own conversation for that request, to read it and report your decision there,
 * bound to that exact proposal and quoting your words. From there it's the same as an answer in
 * Kiki: only a plain yes approves, changes make a new version, and anything unclear approves nothing.
 *
 * Kiki learns about your text one of two ways. With a Fo webhook, Wajo sends word the moment Fo
 * answers a text, in any conversation (an iMessage thread you've had with Fo for months included).
 * Without one, Kiki looks every 20 s for a text conversation that started after the question; those
 * texts carry an answer link and say text replies aren't processed, so for them Kiki doesn't look.
 */
import { approvalInstructions } from "../domain/approval.ts";
import { inert } from "../domain/inert.ts";
import { all, kvGet, logEvent, one, run, type PlanRow } from "../db.ts";
import { getTask } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { replyState, replyWindowMs, saveReply } from "./notify.ts";

/** Channels where you answer Fo by texting. */
export const TEXT_CHANNELS = new Set(["sms", "imessage", "rcs", "whatsapp", "telegram"]);
const EVERY_SECONDS = 20;

/** A text you sent Fo: its conversation, the channel, and when (the conversation's start, or Fo's reply to it). */
export interface TextSeen {
  conversationId: string;
  channel: string;
  at: string;
  /** Tells this text apart from others in the same conversation (a webhook's run id). */
  key: string;
  title?: string;
}

/** The request a text answers: the newest one still waiting. */
function waitingRequest(ctx: Ctx): string | null {
  const newest = all<{ id: string }>(ctx.db, "SELECT id FROM fo_tasks WHERE kind = 'notify' AND conversation_id IS NOT NULL ORDER BY created_at DESC LIMIT 20").find(
    (t) => replyState(ctx, t.id)?.status === "waiting" && replyState(ctx, t.id)?.requestId,
  );
  return newest?.id ?? null;
}

const kikiConversations = (ctx: Ctx) => new Set(all<{ conversation_id: string }>(ctx.db, "SELECT conversation_id FROM fo_tasks WHERE conversation_id IS NOT NULL").map((r) => r.conversation_id));

/**
 * Has Fo read `text` and report your decision on request `taskId`, if it can answer it: sent after
 * the question, not already read, the request still open. "busy" while Fo is mid-turn there.
 */
async function askFoToRead(ctx: Ctx, taskId: string, text: TextSeen, alsoSeen: string[] = []): Promise<"asked" | "busy" | "skipped"> {
  const state = replyState(ctx, taskId);
  const task = getTask(ctx.db, taskId);
  if (!state?.requestId || state.status !== "waiting" || !state.requestedAt || !task?.conversation_id) return "skipped";
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", state.planId);
  if (!plan || plan.status !== "proposed" || plan.content_hash !== state.contentHash) return "skipped";
  if (Date.now() - Date.parse(state.requestedAt) > replyWindowMs(ctx, taskId)) return "skipped";
  if (!(Date.parse(text.at) > Date.parse(state.requestedAt)) || (state.textsChecked ?? []).includes(text.key)) return "skipped";
  if (kikiConversations(ctx).has(text.conversationId)) return "skipped";
  if (["pending", "asking", "working"].includes(task.state)) return "busy";
  if (task.state === "complete") {
    // Fo's turn here is over; make sure it hasn't started another before writing into it.
    const status = await ctx.fo.getFoReply({ conversationId: task.conversation_id, waitSeconds: 0 }).catch(() => null);
    if (!status || status.status === "working") return "busy";
    run(ctx.db, "UPDATE fo_tasks SET state = 'needs_user_input' WHERE id = ? AND state = 'complete'", taskId);
  }
  const binding = { requestId: state.requestId, planId: state.planId, contentHash: state.contentHash };
  const kind = text.channel === "sms" ? "a text" : `a ${text.channel === "imessage" ? "iMessage" : text.channel} message`;
  const where = `${kind} I sent you around ${text.at}${text.title && text.title !== "Untitled" ? ` (in "${inert(text.title, 80)}")` : ""}`;
  const message = `I may have answered this by text: ${where}. Please read what I wrote there. If it answers the proposal in this conversation, report my decision here as described below, with userReply my exact words from the text. If it's about something else, say so in one line and don't report a decision. Don't text me or anyone about this.\n\n${approvalInstructions(binding)}`;
  // Your answer, to be filled with your words when Fo quotes them; a decision counts only as Fo's reply to it.
  saveReply(ctx, taskId, { ...state, textsChecked: [...(state.textsChecked ?? []), text.key, ...alsoSeen], answers: [...(state.answers ?? []), { text: "", at: new Date().toISOString(), via: text.conversationId }] });
  logEvent(ctx.db, plan.workspace_id, "fo_reply", `You texted Fo after Kiki's question about "${plan.title}". Kiki asked Fo to read it.`);
  void ctx.engine.continue(taskId, message).catch(() => undefined);
  return "asked";
}

/** Without a webhook: checks (read-only) for a text conversation you started since Kiki asked. */
export async function watchTextReplies(ctx: Ctx, taskId: string): Promise<{ rescheduleSeconds?: number } | void> {
  // A webhook says when you text Fo; looking as well would only ask Fo twice.
  if (ctx.foWebhook) return;
  const state = replyState(ctx, taskId);
  if (!state?.requestId || state.status !== "waiting" || !state.requestedAt) return;
  // A text with an answer link says text replies aren't processed, so none is.
  if (kvGet(ctx.db, `answer.linked.${taskId}`)) return;
  if (Date.now() - Date.parse(state.requestedAt) > replyWindowMs(ctx, taskId)) return;
  // One request at a time can be answered by text: the newest one still waiting.
  if (waitingRequest(ctx) !== taskId) return;
  if (["pending", "asking", "working"].includes(getTask(ctx.db, taskId)?.state ?? "")) return { rescheduleSeconds: EVERY_SECONDS };

  const kikis = kikiConversations(ctx);
  const checked = new Set(state.textsChecked ?? []);
  let fresh;
  try {
    fresh = (await ctx.fo.listConversations()).filter(
      (c) => TEXT_CHANNELS.has(c.channel) && c.startedAt && Date.parse(c.startedAt) > Date.parse(state.requestedAt!) && !kikis.has(c.conversationId) && !checked.has(c.conversationId),
    );
  } catch {
    return { rescheduleSeconds: EVERY_SECONDS * 3 };
  }
  if (fresh.length) {
    // The earliest text since the question; any later ones are looked at after Fo answers about it.
    const c = [...fresh].sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))[0]!;
    await askFoToRead(ctx, taskId, { conversationId: c.conversationId, channel: c.channel, at: c.startedAt!, key: c.conversationId, title: c.title }, fresh.map((f) => f.conversationId));
  }
  return { rescheduleSeconds: EVERY_SECONDS };
}

/** From the webhook: Fo answered a text of yours. If a proposal waits for you, Fo reads it for Kiki. */
export async function textFromWebhook(ctx: Ctx, text: TextSeen): Promise<{ rescheduleSeconds?: number } | void> {
  const taskId = waitingRequest(ctx);
  if (taskId && (await askFoToRead(ctx, taskId, text)) === "busy") return { rescheduleSeconds: 10 };
}
