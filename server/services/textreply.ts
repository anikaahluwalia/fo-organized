/**
 * Answering Fo by text. A text reply lands in a separate Fo conversation (a different surface), so
 * Kiki watches for one and links it herself, as Wajo advises: while a proposal waits for your
 * decision, a text conversation that starts after Kiki's question is a candidate answer. Kiki
 * can't read texts directly, but Fo can: she asks Fo, in her own conversation for that request,
 * to read it and report your decision there, bound to that exact proposal and quoting your words.
 * From there it's the same as an answer in Kiki: only a plain yes approves, changes make a new
 * version, and anything unclear approves nothing.
 */
import { approvalInstructions } from "../domain/approval.ts";
import { inert } from "../domain/inert.ts";
import { all, logEvent, one, run, type PlanRow } from "../db.ts";
import { getTask } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { replyState, replyWindowMs, saveReply } from "./notify.ts";

/** Channels where you answer Fo by texting. */
const TEXT_CHANNELS = new Set(["sms", "whatsapp", "telegram"]);
const EVERY_SECONDS = 20;

/** Checks (read-only) for a text you sent Fo since Kiki asked, and has Fo read it. */
export async function watchTextReplies(ctx: Ctx, taskId: string): Promise<{ rescheduleSeconds?: number } | void> {
  const state = replyState(ctx, taskId);
  const task = getTask(ctx.db, taskId);
  if (!state?.requestId || state.status !== "waiting" || !state.requestedAt || !task?.conversation_id) return;
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", state.planId);
  if (!plan || plan.status !== "proposed" || plan.content_hash !== state.contentHash) return;
  if (Date.now() - Date.parse(state.requestedAt) > replyWindowMs(ctx, taskId)) return;
  // While Fo is busy in this conversation, look again later.
  if (["pending", "asking", "working"].includes(task.state)) return { rescheduleSeconds: EVERY_SECONDS };
  // One request at a time can be answered by text: the newest one still waiting.
  const newest = all<{ id: string }>(ctx.db, "SELECT id FROM fo_tasks WHERE kind = 'notify' AND conversation_id IS NOT NULL ORDER BY created_at DESC LIMIT 20").find(
    (t) => replyState(ctx, t.id)?.status === "waiting" && replyState(ctx, t.id)?.requestId,
  );
  if (newest?.id !== taskId) return;

  const kikis = new Set(all<{ conversation_id: string }>(ctx.db, "SELECT conversation_id FROM fo_tasks WHERE conversation_id IS NOT NULL").map((r) => r.conversation_id));
  const checked = new Set(state.textsChecked ?? []);
  let fresh;
  try {
    fresh = (await ctx.fo.listConversations()).filter(
      (c) => TEXT_CHANNELS.has(c.channel) && c.startedAt && Date.parse(c.startedAt) > Date.parse(state.requestedAt!) && !kikis.has(c.conversationId) && !checked.has(c.conversationId),
    );
  } catch {
    return { rescheduleSeconds: EVERY_SECONDS * 3 };
  }
  if (!fresh.length) return { rescheduleSeconds: EVERY_SECONDS };

  // The earliest text since the question; any later ones are looked at after Fo answers about it.
  const text = [...fresh].sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))[0]!;
  const binding = { requestId: state.requestId, planId: state.planId, contentHash: state.contentHash };
  const message = `I may have answered this by text: a ${text.channel === "sms" ? "text" : text.channel} conversation with you started ${text.startedAt}${text.title && text.title !== "Untitled" ? ` ("${inert(text.title, 80)}")` : ""}. Please read what I wrote there. If it answers the proposal in this conversation, report my decision here as described below, with userReply my exact words from the text. If it's about something else, say so in one line and don't report a decision. Don't text me or anyone about this.\n\n${approvalInstructions(binding)}`;
  if (task.state === "complete") {
    // Fo's turn here is over; make sure it hasn't started another before writing into it.
    const status = await ctx.fo.getFoReply({ conversationId: task.conversation_id, waitSeconds: 0 }).catch(() => null);
    if (!status || status.status === "working") return { rescheduleSeconds: EVERY_SECONDS };
    run(ctx.db, "UPDATE fo_tasks SET state = 'needs_user_input' WHERE id = ? AND state = 'complete'", taskId);
  }
  // Your answer, to be filled with your words when Fo quotes them; a decision counts only as Fo's reply to it.
  saveReply(ctx, taskId, { ...state, textsChecked: [...checked, ...fresh.map((c) => c.conversationId)], answers: [...(state.answers ?? []), { text: "", at: new Date().toISOString(), via: text.conversationId }] });
  logEvent(ctx.db, plan.workspace_id, "fo_reply", `You texted Fo after Kiki's question about "${plan.title}". Kiki asked Fo to read it.`);
  void ctx.engine.continue(taskId, message).catch(() => undefined);
  return { rescheduleSeconds: EVERY_SECONDS };
}
