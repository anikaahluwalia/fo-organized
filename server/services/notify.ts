import { createHash, randomUUID } from "node:crypto";
import { oneLine } from "../domain/adjust.ts";
import { approvalInstructions, parseApprovalReport, type ApprovalBinding } from "../domain/approval.ts";
import { inDuplicatesFolder } from "../domain/duplicates.ts";
import { all, kvGet, kvSet, logEvent, one, tx, type DocumentRow, type PlanOpRow, type PlanRow, type WorkspaceRow } from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { money } from "../domain/reconcile.ts";
import { classifyDispatchReply, newReference, STATUS_LINES, stripStatusLines } from "../domain/outreach.ts";
import { AppError, badRequest, conflict } from "../errors.ts";
import { getTask, insertTask, type TaskHandler } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { approvePlan } from "./plans.ts";
import { proposalLines } from "./proposal.ts";
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
  const text = `Hi, it's Kiki. I organized "${ws.name}" in Google Drive: ${parts.join(", ")}. ${ops.length === total ? "Every change was checked in Drive." : `${ops.length} of ${total} steps were checked in Drive; the rest need a look in Kiki.`} Nothing was deleted.`;
  return { text, contentHash: hash(text), planId: plan.id };
}

function message(text: string, reference: string, channel: "note" | "text" = "note", expectReply = false): string {
  const how = channel === "text" ? "Please text me (an SMS to my phone, nobody else) this exact message:" : "Please send me (nobody else) this exact note, the way you normally reach me:";
  const reply = expectReply
    ? `

I may text back "go ahead". If I do, please don't move or change any files yourself: Kiki reads my reply and does the filing. Just acknowledge it, and if you can, tell me here what I replied.`
    : "";
  return `${how}

-----BEGIN APPROVED BODY-----
${text}
-----END APPROVED BODY-----

This comes from Kiki, the file-organizing app I connected to you (ref ${reference}). Don't contact anyone else or do anything besides sending this to me.${reply}

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
  kvSet(ctx.db, `notify.purpose.${taskId}`, "summary");
  logEvent(ctx.db, requireWorkspace(ctx.db).id, "approved", `You approved a note for ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to send you.`);
  void ctx.engine.start(taskId, message(preview.text, reference)).catch(() => undefined);
  return { taskId, created: true };
}

export function notifyText(ctx: Ctx, taskId: string): string | null {
  return kvGet(ctx.db, `notify.text.${taskId}`) ?? null;
}

export function notifyPurpose(ctx: Ctx, taskId: string): "find" | "done" | "summary" | "decide" {
  return (kvGet(ctx.db, `notify.purpose.${taskId}`) as "find" | "done" | "summary" | "decide" | undefined) ?? "summary";
}

// Approving by replying to Fo's text ---------------------------------------------------------

export type ReplyStatus = "waiting" | "approved" | "declined" | "expired" | "stale" | "failed" | "adjusting" | "revised" | "not_changed";
export interface ReplyState {
  status: ReplyStatus;
  text: string | null;
  source: "text_reply" | "relayed_by_fo" | null;
  planId: string;
  contentHash: string;
  conversationId?: string;
  at?: string;
  requestId?: string;
  requestedAt?: string;
  clarification?: string;
  /** After you asked for changes: the version Kiki made from them, or why she couldn't. */
  revision?: { planId: string | null; version: number | null; note: string | null };
}

const REPLY_WINDOW_MS = 30 * 60_000;
/** A proposal Fo brings you in Kiki waits for your answer there, as long as the proposal itself is unchanged. */
const DECIDE_WINDOW_MS = 7 * 24 * 3600_000;

/** How long an answer to this request counts: a text reply soon after, an answer in Kiki for days. */
export function replyWindowMs(ctx: Ctx, taskId: string): number {
  return notifyPurpose(ctx, taskId) === "decide" ? DECIDE_WINDOW_MS : REPLY_WINDOW_MS;
}
export function replyState(ctx: Ctx, taskId: string): ReplyState | null {
  const raw = kvGet(ctx.db, `notify.reply.${taskId}`);
  return raw ? (JSON.parse(raw) as ReplyState) : null;
}

/** The plan a text was about: the proposal it offered, the plan it reported done, or the one it summarized. */
export function notifyPlanId(ctx: Ctx, taskId: string): string | null {
  const r = replyState(ctx, taskId);
  if (r?.planId) return r.planId;
  const row = one<{ key: string }>(ctx.db, "SELECT key FROM kv WHERE (key LIKE 'notify.done.%' OR key LIKE 'notify.plan.%') AND value = ?", taskId);
  return row ? row.key.replace(/^notify\.(done|plan)\./, "") : null;
}

export function saveReply(ctx: Ctx, taskId: string, state: ReplyState): void {
  kvSet(ctx.db, `notify.reply.${taskId}`, JSON.stringify(state));
}

/**
 * Looks for the user's reply to Kiki's text (read-only: it only reads Fo conversations). An
 * approving reply approves exactly the plan version that was texted about, nothing newer.
 */
export async function checkTextReply(ctx: Ctx, taskId: string): Promise<{ rescheduleSeconds?: number } | void> {
  const state = replyState(ctx, taskId);
  const task = getTask(ctx.db, taskId);
  if (!state || state.status !== "waiting" || !task) return;
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", state.planId);
  if (!plan || !one(ctx.db, "SELECT id FROM workspaces WHERE id = ? AND active = 1", plan.workspace_id) || plan.status !== "proposed" || plan.content_hash !== state.contentHash) {
    // Approved in the app, set aside, or replaced: the reply no longer has anything to approve.
    saveReply(ctx, taskId, { ...state, status: "stale" });
    return;
  }
  const sentAtMs = Date.parse(state.requestedAt ?? task.created_at);
  const decide = notifyPurpose(ctx, taskId) === "decide";
  if (!state.requestId || !Number.isFinite(sentAtMs) || Date.now() - sentAtMs > replyWindowMs(ctx, taskId)) {
    saveReply(ctx, taskId, { ...state, status: "expired" });
    return;
  }
  if (["asking", "working"].includes(task.state)) return { rescheduleSeconds: 6 };
  const binding: ApprovalBinding = { requestId: state.requestId, planId: state.planId, contentHash: state.contentHash };
  // Only Fo's report on the mapped conversation can authorize execution. Inbound SMS chats
  // are not reliably correlated by MCP; do not search unrelated chats for an affirmative.
  const reports: { text: string; at?: string | null }[] = [];
  if (task.final_response && task.state === "complete") reports.push({ text: task.final_response, at: task.updated_at });
  if (task.conversation_id) {
    try {
      const turns = await ctx.fo.getConversation(task.conversation_id);
      reports.push(...turns.filter((t) => t.role === "assistant"));
    } catch {
      // A completed ask_fo/get_fo_reply response is also a report from this mapped conversation.
    }
  }
  // Use the newest report, so a later clarification cannot be bypassed by an older approval.
  for (const turn of reports.reverse()) {
    if (turn.at && (!Number.isFinite(Date.parse(turn.at)) || Date.parse(turn.at) < sentAtMs)) continue;
    const report = parseApprovalReport(turn.text, binding);
    if (!report) continue;
    if (report.decision === "clarification") {
      saveReply(ctx, taskId, { ...state, clarification: report.userReply });
      return decide ? undefined : { rescheduleSeconds: 6 };
    }
    if (report.decision === "changes_requested") {
      // Never an approval: Kiki makes a new version from your words, and it goes back to Fo.
      saveReply(ctx, taskId, { ...state, status: "adjusting", text: report.userReply, source: "relayed_by_fo", at: new Date().toISOString() });
      ctx.jobs.enqueue("adjust", `adjust:${taskId}`, { taskId });
      logEvent(ctx.db, plan.workspace_id, "fo_reply", `You asked for changes through Fo: "${report.userReply}". Kiki is preparing a new version.`);
      return;
    }
    const reply = { verdict: report.decision, text: report.userReply, source: "relayed_by_fo" as const };
    const at = new Date().toISOString();
    if (reply.verdict === "declined") {
      saveReply(ctx, taskId, { ...state, status: "declined", text: reply.text, source: reply.source, at });
      logEvent(ctx.db, plan.workspace_id, "fo_reply", `You replied "${reply.text}" to Fo's text, so Kiki isn't filing it.`);
      return;
    }
    try {
      tx(ctx.db, () => {
        approvePlan(ctx, plan.id, { contentHash: state.contentHash, clientRequestId: `fo-reply-${taskId}` });
        saveReply(ctx, taskId, { ...state, status: "approved", text: reply.text, source: reply.source, at });
        kvSet(ctx.db, `notify.approved_by_text.${plan.id}`, taskId);
      });
    } catch (err) {
      saveReply(ctx, taskId, { ...state, status: err instanceof AppError ? "stale" : "failed", text: reply.text, source: reply.source, at });
      logEvent(ctx.db, plan.workspace_id, "fo_reply", `You replied "${reply.text}", but the plan had changed. Review it in Kiki.`);
      return;
    }
    logEvent(ctx.db, plan.workspace_id, "approved", `You replied "${reply.text}" to Fo's text. Kiki is filing it now.`);
    return;
  }
  // Fo is waiting for your answer in Kiki: it comes back through Kiki, so there's nothing to poll.
  if (decide && task.state === "needs_user_input") return;
  return { rescheduleSeconds: 6 };
}

/** After a plan you approved by text is applied, Fo texts you that it's done. */
export function sendDoneText(ctx: Ctx, planId: string): void {
  if (!kvGet(ctx.db, `notify.approved_by_text.${planId}`) || kvGet(ctx.db, `notify.done.${planId}`)) return;
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", planId);
  if (!plan || !["applied", "partial", "failed", "stale"].includes(plan.status)) return;
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state = 'verified' ORDER BY seq", planId);
  const text = plan.status !== "applied"
    ? `Kiki: the approved plan stopped (${plan.status}). ${all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state = 'verified'", planId).length} steps were verified in Drive. The remaining changes need review; I have not marked the plan done.`
    : moves.length === 1
      ? `Kiki: done. It's filed in ${moves[0]!.new_path} as "${moves[0]!.new_name}".`
      : `Kiki: done. I filed ${moves.length} documents and updated the index.`;
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  kvSet(ctx.db, `notify.done.${planId}`, taskId);
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  kvSet(ctx.db, `notify.purpose.${taskId}`, "done");
  logEvent(ctx.db, plan.workspace_id, "fo_text", `Kiki asked ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to text you that it's done.`);
  void ctx.engine.start(taskId, message(text, newReference(), "text")).catch(() => undefined);
}

export function notifyHandler(ctx: Ctx): TaskHandler {
  return {
    onComplete(task, response) {
      const state = replyState(ctx, task.id);
      const report = state?.requestId ? parseApprovalReport(response, { requestId: state.requestId, planId: state.planId, contentHash: state.contentHash }) : null;
      if (report) {
        ctx.jobs.enqueue("text_reply", `text_reply:${task.id}`, { taskId: task.id });
        return { question: report.decision === "clarification" ? "Fo needs clarification: " + report.userReply : null };
      }
      const c = classifyDispatchReply(response);
      if (c === "sent") {
        if (notifyPurpose(ctx, task.id) === "find" && replyState(ctx, task.id)?.status === "waiting") {
          ctx.jobs.enqueue("text_reply", `text_reply:${task.id}`, { taskId: task.id }, 4);
        }
        return { question: null };
      }
      if (c === "not_sent") return { question: null };
      return { question: stripStatusLines(response) || response };
    },
    onStateChange(task) {
      if (replyState(ctx, task.id)?.status === "waiting" && ["complete", "needs_user_input"].includes(task.state)) {
        ctx.jobs.enqueue("text_reply", `text_reply:${task.id}`, { taskId: task.id }, 4);
      }
    },
  };
}

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
  logEvent(ctx.db, ws?.id ?? null, "settings", on ? "You turned on texts from Fo when Kiki finds something new. Reply \"go ahead\" to approve." : "You turned off Fo's texts about new finds.");
}

function describeDoc(f: DocFacts | null): string {
  if (!f) return "a document";
  const type = f.docType === "invoice" ? "invoice" : f.docType === "quote" ? "quote" : "document";
  const details = [f.total.value !== null ? money(f.total.value, f.total.currency) : null, f.reference.value].filter(Boolean).join(", ");
  return `a new ${type}${f.issuer.value ? ` from ${f.issuer.value}` : ""}${details ? ` (${details})` : ""}`;
}

/** What Fo texts: what Kiki found, where she'd put it, and how to say yes. */
/** Moves that file a document, as opposed to setting an exact copy aside. */
/** Already inside the folders Kiki files into (Projects, or the earlier Renovations). */
const alreadyFiled = (path: string | null) => /^(Projects|Renovations)(\/|$)/.test(path ?? "");

/** New documents to file, documents already filed that would be renamed or moved, and exact copies set aside. */
function filingMoves(ctx: Ctx, planId: string): { filing: PlanOpRow[]; fresh: PlanOpRow[]; refiled: number; copies: number } {
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state <> 'excluded' ORDER BY seq", planId);
  const filing = moves.filter((o) => !(o.new_path && inDuplicatesFolder(o.new_path)));
  const fresh = filing.filter((o) => !alreadyFiled(o.pre_path));
  return { filing, fresh, refiled: filing.length - fresh.length, copies: moves.length - filing.length };
}

function findSummary(ctx: Ctx, plan: PlanRow): string {
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", plan.workspace_id)!;
  const { fresh, refiled, copies } = filingMoves(ctx, plan.id);
  const extras = [
    refiled ? `rename or move ${refiled} document${refiled === 1 ? "" : "s"} already filed` : null,
    copies ? `set aside ${copies} exact cop${copies === 1 ? "y" : "ies"}` : null,
  ].filter(Boolean);
  const also = extras.length ? ` (Kiki would also ${extras.join(" and ")}; nothing is deleted.)` : "";
  if (fresh.length === 1) {
    const op = fresh[0]!;
    const doc = op.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", op.doc_id) : undefined;
    const facts = doc?.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
    return `Kiki: ${oneLine(describeDoc(facts))} just landed in "${oneLine(ws.name)}". Want me to file it in ${oneLine(op.new_path)}?${also} Reply "go ahead" and I'll do it.`;
  }
  return `Kiki: ${fresh.length} new documents in "${oneLine(ws.name)}" are ready to file.${also} Reply "go ahead" and I'll file them.`;
}

/** Complete scope is supplied to Fo and the account holder, including renames and version changes. */
export function newFindText(ctx: Ctx, plan: PlanRow): string {
  return `${findSummary(ctx, plan)}\n\nProposed changes (version ${plan.version}):\n${proposalLines(ctx, plan)}\nNothing is deleted. You can answer Fo naturally, ask a question, ask for changes, or decline.`;
}

/** Standing permission, texts to the account holder only: one text per new proposal. */
export function autoNotifyProposal(ctx: Ctx, plan: PlanRow): void {
  if (!autoTextEnabled(ctx)) return;
  // Renaming what's already filed, or setting copies aside, is housekeeping, not something new:
  // it waits in the app, no text.
  if (filingMoves(ctx, plan.id).fresh.length === 0 && !one(ctx.db, "SELECT id FROM plan_ops WHERE plan_id = ? AND kind = 'set_status' AND state <> 'excluded'", plan.id)) return;
  // One text per distinct proposal, even if it gets re-saved as a new version.
  if (kvGet(ctx.db, `notify.plan.${plan.id}`) || kvGet(ctx.db, `notify.hash.${plan.content_hash}`)) return;
  kvSet(ctx.db, `notify.hash.${plan.content_hash}`, plan.id);
  const text = newFindText(ctx, plan);
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  kvSet(ctx.db, `notify.plan.${plan.id}`, taskId);
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  kvSet(ctx.db, `notify.purpose.${taskId}`, "find");
  const binding: ApprovalBinding = { requestId: randomUUID(), planId: plan.id, contentHash: plan.content_hash };
  saveReply(ctx, taskId, { status: "waiting", text: null, source: null, ...binding, requestedAt: new Date().toISOString() });
  logEvent(ctx.db, plan.workspace_id, "fo_text", `Kiki asked ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to text you about it.`);
  void ctx.engine.start(taskId, message(text, newReference(), "text") + "\n\n" + approvalInstructions(binding)).catch(() => undefined);
}
