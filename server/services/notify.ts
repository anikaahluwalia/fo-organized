import { createHash } from "node:crypto";
import { all, kvGet, kvSet, logEvent, one, type DocumentRow, type PlanOpRow, type PlanRow, type WorkspaceRow } from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { money } from "../domain/reconcile.ts";
import { classifyDispatchReply, newReference, STATUS_LINES, stripStatusLines } from "../domain/outreach.ts";
import { AppError, badRequest, conflict } from "../errors.ts";
import { getTask, insertTask, type TaskHandler } from "../fo/engine.ts";
import type { FoTurn } from "../fo/types.ts";
import type { Ctx } from "./context.ts";
import { approvePlan } from "./plans.ts";
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

export function notifyPurpose(ctx: Ctx, taskId: string): "find" | "done" | "summary" {
  return (kvGet(ctx.db, `notify.purpose.${taskId}`) as "find" | "done" | "summary" | undefined) ?? "summary";
}

// Approving by replying to Fo's text ---------------------------------------------------------

export type ReplyStatus = "waiting" | "approved" | "declined" | "expired" | "stale" | "failed";
export interface ReplyState {
  status: ReplyStatus;
  text: string | null;
  source: "text_reply" | "relayed_by_fo" | null;
  planId: string;
  contentHash: string;
  conversationId?: string;
  at?: string;
}

const REPLY_WINDOW_MS = 30 * 60_000;
const APPROVE = /\b(go ahead|yes|yep|yeah|ok|okay|sure|do it|approve|approved|file it|sounds good|please do|go for it)\b/i;
const DECLINE = /\b(no|nope|don'?t|do not|stop|wait|hold off|not now|later|cancel)\b/i;
const OURS = /KIKI-STATUS|BEGIN APPROVED BODY|Kiki request|Answer from the user|This comes from Kiki/;

export function replyState(ctx: Ctx, taskId: string): ReplyState | null {
  const raw = kvGet(ctx.db, `notify.reply.${taskId}`);
  return raw ? (JSON.parse(raw) as ReplyState) : null;
}

function saveReply(ctx: Ctx, taskId: string, state: ReplyState): void {
  kvSet(ctx.db, `notify.reply.${taskId}`, JSON.stringify(state));
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/** A turn that is Kiki's text (or quotes it): its opening words, or "go ahead" plus the document's reference. */
export function anchorMatcher(text: string, reference: string | null): (t: FoTurn) => boolean {
  const key = norm(text).slice(0, 60);
  const ref = reference ? norm(reference) : null;
  return (t) => {
    const n = norm(t.text);
    return n.includes(key) || (ref !== null && n.includes(ref) && n.includes("go ahead"));
  };
}

/** Reads the user's answer from the turns that follow Kiki's text, if there is one yet. */
export function findReply(turns: FoTurn[], isAnchor: (t: FoTurn) => boolean, sentAtMs: number): { verdict: "approved" | "declined"; text: string; source: "text_reply" | "relayed_by_fo" } | null {
  const idx = turns.findIndex(isAnchor);
  if (idx === -1) return null;
  for (const t of turns.slice(idx + 1)) {
    if (t.at && Date.parse(t.at) < sentAtMs - 120_000) continue;
    let said: string | null = null;
    let source: "text_reply" | "relayed_by_fo" = "text_reply";
    if (t.role === "user") {
      if (OURS.test(t.text) || t.text.length > 300) continue;
      said = t.text.trim();
    } else {
      // Fo relaying it in our conversation, e.g. `You replied "go ahead".`
      const m = /\b(replied|responded|wrote back|texted back|said)\b[^"“\n]{0,40}["“]([^"”\n]{1,200})["”]/i.exec(t.text);
      if (!m) continue;
      said = m[2]!.trim();
      source = "relayed_by_fo";
    }
    if (DECLINE.test(said)) return { verdict: "declined", text: said, source };
    if (APPROVE.test(said)) return { verdict: "approved", text: said, source };
  }
  return null;
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
  if (!plan || plan.status !== "proposed" || plan.content_hash !== state.contentHash) {
    // Approved in the app, set aside, or replaced: the reply no longer has anything to approve.
    saveReply(ctx, taskId, { ...state, status: "stale" });
    return;
  }
  const sentAtMs = Date.parse(task.updated_at);
  if (Date.now() - sentAtMs > REPLY_WINDOW_MS) {
    saveReply(ctx, taskId, { ...state, status: "expired" });
    return;
  }
  const text = notifyText(ctx, taskId) ?? "";
  const move = one<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' ORDER BY seq LIMIT 1", plan.id);
  const doc = move?.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", move.doc_id) : undefined;
  const reference = doc?.facts_json ? ((JSON.parse(doc.facts_json) as DocFacts).reference.value ?? null) : null;
  const isAnchor = anchorMatcher(text, reference);
  const candidates: { id: string; channel: string }[] = [state.conversationId, task.conversation_id].filter((c): c is string => Boolean(c)).map((id) => ({ id, channel: "known" }));
  try {
    for (const c of (await ctx.fo.listConversations()).slice(0, 4)) if (!candidates.some((x) => x.id === c.conversationId)) candidates.push({ id: c.conversationId, channel: c.channel });
  } catch {
    // Listing is a convenience; the known conversations are still checked.
  }
  for (const { id: conversationId, channel } of candidates) {
    let turns: FoTurn[];
    try {
      turns = await ctx.fo.getConversation(conversationId);
    } catch {
      continue;
    }
    let reply = turns.some(isAnchor) ? findReply(turns, isAnchor, sentAtMs) : null;
    if (turns.some(isAnchor) && state.conversationId !== conversationId && conversationId !== task.conversation_id) saveReply(ctx, taskId, { ...state, conversationId });
    // Fallback for a text thread that doesn't show Kiki's message: a short "go ahead" texted after it was sent.
    if (!reply && channel === "sms") {
      const late = turns.filter((t) => t.role === "user" && t.at && Date.parse(t.at) >= sentAtMs && t.text.length <= 60 && !OURS.test(t.text));
      const last = late[late.length - 1];
      if (last && (DECLINE.test(last.text) || APPROVE.test(last.text))) reply = { verdict: DECLINE.test(last.text) ? "declined" : "approved", text: last.text.trim(), source: "text_reply" };
    }
    if (!reply) continue;
    const at = new Date().toISOString();
    if (reply.verdict === "declined") {
      saveReply(ctx, taskId, { ...state, status: "declined", text: reply.text, source: reply.source, at });
      logEvent(ctx.db, plan.workspace_id, "fo_reply", `You replied "${reply.text}" to Fo's text, so Kiki isn't filing it.`);
      return;
    }
    try {
      approvePlan(ctx, plan.id, { contentHash: state.contentHash, clientRequestId: `fo-reply-${taskId}` });
    } catch (err) {
      saveReply(ctx, taskId, { ...state, status: err instanceof AppError ? "stale" : "failed", text: reply.text, source: reply.source, at });
      logEvent(ctx.db, plan.workspace_id, "fo_reply", `You replied "${reply.text}", but the plan had changed. Review it in Kiki.`);
      return;
    }
    saveReply(ctx, taskId, { ...state, status: "approved", text: reply.text, source: reply.source, at });
    kvSet(ctx.db, `notify.approved_by_text.${plan.id}`, taskId);
    logEvent(ctx.db, plan.workspace_id, "approved", `You replied "${reply.text}" to Fo's text. Kiki is filing it now.`);
    return;
  }
  return { rescheduleSeconds: 6 };
}

/** After a plan you approved by text is applied, Fo texts you that it's done. */
export function sendDoneText(ctx: Ctx, planId: string): void {
  if (!kvGet(ctx.db, `notify.approved_by_text.${planId}`) || kvGet(ctx.db, `notify.done.${planId}`)) return;
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", planId);
  if (!plan || plan.status !== "applied") return;
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state = 'verified' ORDER BY seq", planId);
  const text =
    moves.length === 1
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
    onStateChange() {},
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
export function newFindText(ctx: Ctx, plan: PlanRow): string {
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", plan.workspace_id)!;
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' ORDER BY seq", plan.id);
  if (moves.length === 1) {
    const op = moves[0]!;
    const doc = op.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", op.doc_id) : undefined;
    const facts = doc?.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
    return `Kiki: ${describeDoc(facts)} just landed in "${ws.name}". Want me to file it in ${op.new_path}? Reply "go ahead" and I'll do it.`;
  }
  return `Kiki: ${moves.length} new documents in "${ws.name}" are ready to file. Reply "go ahead" and I'll file them.`;
}

/** Standing permission, texts to the account holder only: one text per new proposal. */
export function autoNotifyProposal(ctx: Ctx, plan: PlanRow): void {
  if (!autoTextEnabled(ctx)) return;
  // One text per distinct proposal, even if it gets re-saved as a new version.
  if (kvGet(ctx.db, `notify.plan.${plan.id}`) || kvGet(ctx.db, `notify.hash.${plan.content_hash}`)) return;
  kvSet(ctx.db, `notify.hash.${plan.content_hash}`, plan.id);
  const text = newFindText(ctx, plan);
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  kvSet(ctx.db, `notify.plan.${plan.id}`, taskId);
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  kvSet(ctx.db, `notify.purpose.${taskId}`, "find");
  saveReply(ctx, taskId, { status: "waiting", text: null, source: null, planId: plan.id, contentHash: plan.content_hash });
  logEvent(ctx.db, plan.workspace_id, "fo_text", `Kiki asked ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to text you about it.`);
  void ctx.engine.start(taskId, message(text, newReference(), "text", true)).catch(() => undefined);
}
