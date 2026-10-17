import { createHash } from "node:crypto";
import { all, kvGet, kvSet, logEvent, one, type DocumentRow, type PlanOpRow, type PlanRow, type WorkspaceRow } from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { money } from "../domain/reconcile.ts";
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

function message(text: string, reference: string, channel: "note" | "text" = "note"): string {
  const how = channel === "text" ? "a text message (SMS)" : "a short note, using the channel you normally use to reach me,";
  const why = channel === "text" ? "The user turned on \"Fo texts me about new finds\" in the Fo-rganized app; this text is covered by that setting." : "The user reviewed and approved this in the Fo-rganized app.";
  return `Fo-rganized request (ref ${reference}). ${why}

Please send ME (the account holder, the person you're talking to) ${how} with exactly this text:
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

const AUTO_TEXT = "settings.auto_text";

export function autoTextEnabled(ctx: Ctx): boolean {
  return kvGet(ctx.db, AUTO_TEXT) === "1";
}

export function setAutoText(ctx: Ctx, on: boolean): void {
  kvSet(ctx.db, AUTO_TEXT, on ? "1" : undefined);
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE active = 1");
  logEvent(ctx.db, ws?.id ?? null, "settings", on ? "You turned on: Fo texts you when Kiki finds something to file. Only you are texted." : "You turned off Fo's texts about new finds.");
}

function describeDoc(f: DocFacts | null): string {
  if (!f) return "a document";
  const type = f.docType === "invoice" ? "invoice" : f.docType === "quote" ? "quote" : "document";
  const details = [f.reference.value, f.date.value ? `dated ${f.date.value}` : null, f.total.value !== null ? money(f.total.value, f.total.currency) : null].filter(Boolean).join(", ");
  return `a new ${type}${f.issuer.value ? ` from ${f.issuer.value}` : ""}${details ? ` (${details})` : ""}`;
}

/** The text Kiki asks Fo to send when she has a new proposal: facts, where it would go, and that nothing moves yet. */
export function newFindText(ctx: Ctx, plan: PlanRow): string {
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", plan.workspace_id)!;
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' ORDER BY seq", plan.id);
  if (moves.length === 1) {
    const op = moves[0]!;
    const doc = op.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", op.doc_id) : undefined;
    const facts = doc?.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
    const supplier = /supplier on \d+ other document/.test(op.reason) ? ` It's from a supplier you already have filed under ${(op.new_path ?? "").split("/")[1] ?? "that project"}.` : "";
    return `Kiki here: I found ${describeDoc(facts)} in "${ws.name}".${supplier} I'd file it in ${op.new_path} as "${op.new_name}". Approve it in Fo-rganized; nothing moves until you do.`;
  }
  return `Kiki here: I found ${moves.length} documents to file in "${ws.name}" and prepared a plan. Approve it in Fo-rganized; nothing moves until you do.`;
}

/** Standing permission, texts to the account holder only: one text per new proposal. */
export function autoNotifyProposal(ctx: Ctx, plan: PlanRow): void {
  if (!autoTextEnabled(ctx)) return;
  if (kvGet(ctx.db, `notify.plan.${plan.id}`)) return;
  const text = newFindText(ctx, plan);
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  kvSet(ctx.db, `notify.plan.${plan.id}`, taskId);
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  logEvent(ctx.db, plan.workspace_id, "fo_text", `Kiki asked ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to text you about the new proposal.`);
  void ctx.engine.start(taskId, message(text, newReference(), "text")).catch(() => undefined);
}
