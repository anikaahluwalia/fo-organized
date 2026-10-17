import { createHash } from "node:crypto";
import { all, kvGet, kvSet, logEvent, one, type PlanOpRow, type PlanRow } from "../db.ts";
import { classifyDispatchReply, newReference, STATUS_LINES, stripStatusLines } from "../domain/outreach.ts";
import { badRequest, conflict } from "../errors.ts";
import { getTask, insertTask, type TaskHandler } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { requireWorkspace } from "./workspace.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** The note Kiki would ask Fo to send you, built only from verified results. */
export function notifyPreview(ctx: Ctx): { text: string; contentHash: string; planId: string } | null {
  const ws = requireWorkspace(ctx.db);
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE workspace_id = ? AND status IN ('applied', 'partial') ORDER BY finished_at DESC LIMIT 1", ws.id);
  if (!plan) return null;
  const ops = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state = 'verified'", plan.id);
  const folders = ops.filter((o) => o.kind === "create_folder").length;
  const moved = ops.filter((o) => o.kind === "move_rename");
  const invoices = moved.filter((o) => (o.new_path ?? "").endsWith("Invoices")).length;
  const quotes = moved.filter((o) => (o.new_path ?? "").includes("Quotes")).length;
  const index = ops.find((o) => o.kind === "write_index");
  const total = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state <> 'excluded'", plan.id).length;
  const parts = [
    folders ? `created ${folders} folder${folders === 1 ? "" : "s"}` : null,
    moved.length ? `filed and renamed ${moved.length} document${moved.length === 1 ? "" : "s"} (${invoices} invoice${invoices === 1 ? "" : "s"}, ${quotes} quote${quotes === 1 ? "" : "s"})` : null,
    index ? `updated the project index ("${index.new_name}")` : null,
  ].filter(Boolean);
  const text = `Hi, it's Kiki. I organized "${ws.name}" in Google Drive: ${parts.join(", ")}. ${ops.length === total ? "Every change was checked in Drive." : `${ops.length} of ${total} steps were checked in Drive; the rest need a look in Fo-rganized.`} Nothing was deleted.`;
  return { text, contentHash: hash(text), planId: plan.id };
}

function message(text: string, reference: string): string {
  return `Fo-rganized request (ref ${reference}). The user reviewed and approved this in the Fo-rganized app.

Please send ME (the account holder, the person you're talking to) a short note, using the channel you normally use to reach me, with exactly this text:
-----BEGIN APPROVED BODY-----
${text}
-----END APPROVED BODY-----

Don't contact anyone else, don't attach anything, and don't take any other action.

End your reply with exactly one of these lines:
${STATUS_LINES.sent}
${STATUS_LINES.notSent}
${STATUS_LINES.needInput}`;
}

/** Approve-and-send for the note to yourself. Bound to the exact text; repeated clicks don't resend. */
export function notifySend(ctx: Ctx, input: { contentHash?: string; clientRequestId?: string }): { taskId: string; created: boolean } {
  const clientRequestId = input.clientRequestId ?? "";
  if (!clientRequestId || clientRequestId.length > 100) throw badRequest("Missing request id.");
  const existing = kvGet(ctx.db, `notify.request.${clientRequestId}`);
  if (existing) return { taskId: existing, created: false };
  const preview = notifyPreview(ctx);
  if (!preview) throw conflict("There's nothing verified to report yet.");
  if (input.contentHash !== preview.contentHash) throw conflict("The note changed after you reviewed it. Review it again.", "hash_mismatch");
  const sentFor = kvGet(ctx.db, `notify.plan.${preview.planId}`);
  if (sentFor) {
    const prior = getTask(ctx.db, sentFor);
    if (prior && !["failed"].includes(prior.state)) return { taskId: sentFor, created: false };
  }
  const reference = newReference();
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  kvSet(ctx.db, `notify.request.${clientRequestId}`, taskId);
  kvSet(ctx.db, `notify.plan.${preview.planId}`, taskId);
  kvSet(ctx.db, `notify.text.${taskId}`, preview.text);
  logEvent(ctx.db, requireWorkspace(ctx.db).id, "approved", `You approved a note for ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to send you.`);
  void ctx.engine.start(taskId, message(preview.text, reference)).catch(() => undefined);
  return { taskId, created: true };
}

export function notifyText(ctx: Ctx, taskId: string): string | null {
  return kvGet(ctx.db, `notify.text.${taskId}`) ?? null;
}

export const notifyHandler: TaskHandler = {
  onComplete(_task, response) {
    const c = classifyDispatchReply(response);
    if (c === "sent" || c === "not_sent") return { question: null };
    return { question: stripStatusLines(response) || response };
  },
  onStateChange() {},
};

export function notifyOutcome(response: string | null): "reported_sent" | "not_sent" | "unclear" {
  if (!response) return "unclear";
  const c = classifyDispatchReply(response);
  return c === "sent" ? "reported_sent" : c === "not_sent" ? "not_sent" : "unclear";
}
