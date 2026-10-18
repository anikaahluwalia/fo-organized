import { createHash, randomUUID } from "node:crypto";
import { inert } from "../domain/inert.ts";
import { approvalInstructions, isPlainYes, parseApprovalReport, sameAnswer, type ApprovalBinding } from "../domain/approval.ts";
import { inDuplicatesFolder } from "../domain/duplicates.ts";
import { all, kvGet, kvSet, logEvent, now, one, run, tx, type DocumentRow, type PlanOpRow, type PlanRow, type WorkspaceRow } from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { money } from "../domain/reconcile.ts";
import { classifyDispatchReply, newReference, STATUS_LINES } from "../domain/outreach.ts";
import { AppError, badRequest, conflict } from "../errors.ts";
import { getTask, insertTask, type TaskHandler } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { approvePlan } from "./plans.ts";
import { proposalLines } from "./proposal.ts";
import { answerLink } from "./answerlink.ts";
import { requireWorkspace } from "./workspace.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "a, b and c" */
const listed = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** What a plan did, from its verified steps only, in the words of the kind of plan it was. */
function verifiedWork(ctx: Ctx, plan: PlanRow, ops: PlanOpRow[]): string[] {
  const moved = ops.filter((o) => o.kind === "move_rename");
  const copies = moved.filter((o) => o.new_path && inDuplicatesFolder(o.new_path)).length;
  const superseded = moved.filter((o) => (o.new_path ?? "").split("/").includes("Superseded")).length;
  const filed = moved.length - copies - superseded;
  const folders = ops.filter((o) => o.kind === "create_folder").length;
  const indexes = [...new Set(ops.filter((o) => o.kind === "write_index").map((o) => inert((o.folder_path ?? "").split("/")[1] ?? o.new_name, 60)))];
  const index = indexes.length ? `${plan.kind === "undo" ? "restored" : "updated"} the ${listed(indexes)} index${indexes.length === 1 ? "" : "es"}` : null;
  if (plan.kind === "undo") return [moved.length ? `put ${plural(moved.length, "document")} back where ${moved.length === 1 ? "it was" : "they were"}` : null, index].filter((p): p is string => Boolean(p));
  const statuses = ops
    .filter((o) => o.kind === "set_status")
    .map((o) => {
      const doc = o.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", o.doc_id) : undefined;
      const facts = doc?.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
      const what = facts?.reference.value ? `${facts.docType === "quote" ? "quote" : "document"} ${inert(facts.reference.value, 40)}` : "a quote";
      return `recorded ${what} as ${o.target_status === "current" ? "the current one" : inert(o.target_status, 20)}`;
    });
  return [
    folders ? `created ${plural(folders, "folder")}` : null,
    filed ? `filed and renamed ${plural(filed, "document")}` : null,
    superseded ? `moved ${plural(superseded, "earlier version")} to Superseded` : null,
    copies ? `set aside ${plural(copies, "exact copy", "exact copies")}` : null,
    ...statuses,
    index,
  ].filter((p): p is string => Boolean(p));
}

/** The note Kiki would ask Fo to send you, built only from verified results. */
export function notifyPreview(ctx: Ctx): { text: string; contentHash: string; planId: string } | null {
  const ws = requireWorkspace(ctx.db);
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE workspace_id = ? AND status IN ('applied', 'partial') ORDER BY finished_at DESC LIMIT 1", ws.id);
  if (!plan) return null;
  const ops = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state = 'verified'", plan.id);
  const work = verifiedWork(ctx, plan, ops);
  if (!work.length) return null;
  const total = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state <> 'excluded'", plan.id).length;
  const lead = plan.kind === "organize" ? `I organized "${inert(ws.name)}" in Google Drive: ` : `In "${inert(ws.name)}" in Google Drive, I `;
  const text = `Hi, it's Kiki. ${lead}${listed(work)}. ${ops.length === total ? "Every change was checked in Drive." : `${ops.length} of ${total} steps were checked in Drive; the rest need a look in Kiki.`} Nothing was deleted.`;
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
  // A summary on its way isn't sent twice; once Fo has finished with it (sent or not), you can ask again.
  const sentFor = kvGet(ctx.db, `notify.summary.${preview.planId}`);
  const prior = sentFor ? getTask(ctx.db, sentFor) : undefined;
  if (sentFor && prior && ["pending", "asking", "working", "needs_user_input"].includes(prior.state)) return { taskId: sentFor, created: false };
  const reference = newReference();
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  kvSet(ctx.db, `notify.request.${clientRequestId}`, taskId);
  kvSet(ctx.db, `notify.summary.${preview.planId}`, taskId);
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
  /** What you answered Fo in Kiki, in order. A decision counts only as Fo's reply to the latest. */
  answers?: { text: string; at: string; via?: string }[];
  /** Text conversations Kiki already asked Fo to read for this request. */
  textsChecked?: string[];
  /** The answer Kiki last read for changes Fo reported only as a clarification (each is read once). */
  interpretedAt?: string;
}

const REPLY_WINDOW_MS = 30 * 60_000;
/** A proposal Fo brings you in Kiki waits for your answer there, as long as the proposal itself is unchanged. */
const DECIDE_WINDOW_MS = 7 * 24 * 3600_000;

/** How long an answer to this request counts: a text reply soon after, an answer in Kiki for days. */
export function replyWindowMs(ctx: Ctx, taskId: string): number {
  // A text with an answer link waits as long as an answer in Kiki: the link is tied to the request.
  return notifyPurpose(ctx, taskId) === "decide" || kvGet(ctx.db, `answer.linked.${taskId}`) ? DECIDE_WINDOW_MS : REPLY_WINDOW_MS;
}
export function replyState(ctx: Ctx, taskId: string): ReplyState | null {
  const raw = kvGet(ctx.db, `notify.reply.${taskId}`);
  return raw ? (JSON.parse(raw) as ReplyState) : null;
}

/** The plan a text was about: the proposal it offered, the plan it reported done, or the one it summarized. */
export function notifyPlanId(ctx: Ctx, taskId: string): string | null {
  const r = replyState(ctx, taskId);
  if (r?.planId) return r.planId;
  const row = one<{ key: string }>(ctx.db, "SELECT key FROM kv WHERE (key LIKE 'notify.done.%' OR key LIKE 'notify.plan.%' OR key LIKE 'notify.summary.%') AND value = ?", taskId);
  return row ? row.key.replace(/^notify\.(done|plan|summary)\./, "").replace(/\.(done|stopped)$/, "") : null;
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
  // An answer you gave in time still counts when Fo's report about it lands later.
  const lastWordMs = Math.max(sentAtMs, ...(state.answers ?? []).map((a) => Date.parse(a.at)).filter(Number.isFinite));
  if (!state.requestId || !Number.isFinite(sentAtMs) || Date.now() - lastWordMs > replyWindowMs(ctx, taskId)) {
    saveReply(ctx, taskId, { ...state, status: "expired" });
    return;
  }
  if (task.state === "uncertain" && task.conversation_id) {
    // Kiki stopped while this was with Fo: read where the conversation stands (read-only), so you
    // can answer Fo's next question. Never resent.
    try {
      await ctx.engine.reconcile(taskId, "");
    } catch {
      return { rescheduleSeconds: 30 };
    }
    return;
  }
  if (["asking", "working"].includes(task.state)) return { rescheduleSeconds: 6 };
  const binding: ApprovalBinding = { requestId: state.requestId, planId: state.planId, contentHash: state.contentHash };
  // For now you answer in Kiki (a text reply can't be tied to this request yet), so a decision
  // counts only as Fo's reply to the latest answer Kiki relayed. Nothing before it, nothing in
  // another conversation, and never something Fo reports without an answer from you.
  let answer = state.answers?.at(-1);
  if (!answer) return decide ? undefined : { rescheduleSeconds: 6 };
  const answeredAtMs = Date.parse(answer.at);
  let latest: string | null = null;
  if ((task.state === "complete" || task.state === "needs_user_input") && task.final_response && Date.parse(task.updated_at) >= answeredAtMs) {
    // Fo's reply to your latest answer: the newest word, even if the transcript lags behind it.
    latest = task.final_response;
  } else if (task.conversation_id) {
    try {
      const turns = (await ctx.fo.getConversation(task.conversation_id)).filter((t) => t.role === "assistant" && t.at && Date.parse(t.at) >= answeredAtMs);
      latest = turns.at(-1)?.text ?? null;
    } catch {
      latest = null;
    }
  }
  for (const turn of latest ? [{ text: latest }] : []) {
    const report = parseApprovalReport(turn.text, binding);
    if (!report) continue;
    if (answer.via && !answer.text) {
      // You answered by text: your words are what Fo quotes from it (Fo can read texts; Kiki can't).
      answer = { ...answer, text: report.userReply };
      state.answers = [...state.answers!.slice(0, -1), answer];
      saveReply(ctx, taskId, state);
    }
    if (report.decision === "clarification") {
      saveReply(ctx, taskId, { ...state, clarification: report.userReply });
      // Fo may report a change you asked for as a clarification. Kiki reads your words once: if they
      // ask for a change she makes the new version; a question just waits for your next answer.
      if (plan.kind === "organize" && state.interpretedAt !== answer.at) ctx.jobs.enqueue("adjust", `adjust:${taskId}`, { taskId, quiet: true });
      return decide ? undefined : { rescheduleSeconds: 6 };
    }
    if (report.decision === "changes_requested") {
      // Never an approval: Kiki makes a new version from your words, and it goes back to Fo.
      // Your own words, as relayed from Kiki, are what Kiki reads for the changes.
      saveReply(ctx, taskId, { ...state, status: "adjusting", text: answer.text, source: "relayed_by_fo", at: new Date().toISOString() });
      ctx.jobs.enqueue("adjust", `adjust:${taskId}`, { taskId });
      logEvent(ctx.db, plan.workspace_id, "fo_reply", `You asked for changes through Fo: "${report.userReply}". Kiki is preparing a new version.`);
      return;
    }
    const reply = { verdict: report.decision, text: report.userReply, source: "relayed_by_fo" as const };
    const at = new Date().toISOString();
    if (reply.verdict === "approved" && (!sameAnswer(report.userReply, answer.text) || !isPlainYes(answer.text))) {
      // Fo says yes, but your own words aren't a plain yes, or aren't what Fo quotes: nothing is approved.
      saveReply(ctx, taskId, { ...state, clarification: `Fo reported an approval, but your answer ("${inert(answer.text, 200)}") isn't a plain yes to this version, so Kiki didn't apply it. Answer again, or approve it in Kiki.` });
      logEvent(ctx.db, plan.workspace_id, "fo_reply", `Fo reported an approval, but your answer wasn't a plain yes, so Kiki didn't apply anything.`);
      return;
    }
    if (reply.verdict === "declined") {
      saveReply(ctx, taskId, { ...state, status: "declined", text: reply.text, source: reply.source, at });
      // "Leave it" to a question about where files go: set it aside, so it isn't asked again.
      if (!one(ctx.db, "SELECT id FROM plan_ops WHERE plan_id = ? AND state <> 'excluded'", plan.id)) {
        run(ctx.db, "UPDATE plans SET status = 'discarded', finished_at = ? WHERE id = ? AND status = 'proposed'", now(), plan.id);
      }
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
  if (task.state === "needs_user_input") return;
  return { rescheduleSeconds: 6 };
}

/** After a plan you approved by text is applied, Fo texts you that it's done. */
export function sendDoneText(ctx: Ctx, planId: string): void {
  if (!kvGet(ctx.db, `notify.approved_by_text.${planId}`)) return;
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", planId);
  if (!plan || !["applied", "partial", "failed", "stale"].includes(plan.status)) return;
  // One text per outcome: a "done" can still follow a "stopped" once Try again finishes it.
  const outcome = plan.status === "applied" ? "done" : "stopped";
  if (kvGet(ctx.db, `notify.done.${planId}.${outcome}`) || (outcome === "stopped" && kvGet(ctx.db, `notify.done.${planId}.done`))) return;
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state = 'verified' ORDER BY seq", planId);
  const text = plan.status !== "applied"
    ? `Kiki: the approved plan stopped (${plan.status}). ${all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state = 'verified'", planId).length} steps were verified in Drive. The remaining changes need review; I have not marked the plan done.`
    : moves.length === 1
      ? `Kiki: done. It's filed in ${inert(moves[0]!.new_path)} as "${inert(moves[0]!.new_name)}".`
      : `Kiki: done. I filed ${moves.length} documents and updated the index.`;
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  kvSet(ctx.db, `notify.done.${planId}.${outcome}`, taskId);
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  kvSet(ctx.db, `notify.purpose.${taskId}`, "done");
  logEvent(ctx.db, plan.workspace_id, "fo_text", `Kiki asked ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to text you that it's done.`);
  void ctx.engine.start(taskId, message(text, newReference(), "text")).catch(() => undefined);
}

/** Fo's reply as you should read it: its own words, without Kiki's status and decision lines. */
function withoutProtocol(response: string): string {
  return response
    .split(/\r?\n/)
    .filter((l) => !/^\W*KIKI-(DECISION|STATUS)\s*:/i.test(l))
    .join("\n")
    .trim();
}

export function notifyHandler(ctx: Ctx): TaskHandler {
  return {
    onComplete(task, response) {
      const state = replyState(ctx, task.id);
      const report = state?.requestId ? parseApprovalReport(response, { requestId: state.requestId, planId: state.planId, contentHash: state.contentHash }) : null;
      if (report) {
        ctx.jobs.enqueue("text_reply", `text_reply:${task.id}`, { taskId: task.id });
        return { question: report.decision === "clarification" ? withoutProtocol(response) || "Fo needs you to clarify your answer." : null };
      }
      // Fo's reply to an answer you gave in Kiki, with no decision in it: show what Fo said (its
      // answer, its next question) and keep waiting. A status line there doesn't mean anything was sent.
      if (state?.requestId && state.status === "waiting" && (state.answers?.length ?? 0) > 0) return { question: withoutProtocol(response) || "Fo replied without a decision. Answer again, or decide here in Kiki." };
      const c = classifyDispatchReply(response);
      if (c === "sent") {
        if (notifyPurpose(ctx, task.id) === "find" && replyState(ctx, task.id)?.status === "waiting") {
          ctx.jobs.enqueue("text_reply", `text_reply:${task.id}`, { taskId: task.id }, 4);
        }
        return { question: null };
      }
      if (c === "not_sent") return { question: null };
      // Fo's own words, never Kiki's protocol lines (a decision line that couldn't be matched included).
      const said = withoutProtocol(response);
      return { question: said || (/^\W*KIKI-DECISION\s*:/im.test(response) ? "Fo replied, but its report couldn't be matched to this proposal." : null) };
    },
    onStateChange(task) {
      // While a proposal waits for you, a text you send Fo is watched for (it lands in its own conversation).
      if (replyState(ctx, task.id)?.status === "waiting" && ["complete", "needs_user_input"].includes(task.state)) {
        ctx.jobs.enqueue("text_watch", `text_watch:${task.id}`, { taskId: task.id }, 20);
      }
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
  logEvent(ctx.db, ws?.id ?? null, "settings", on ? "You turned on texts from Fo when Kiki finds something new. Reply to the text, or answer here in Kiki." : "You turned off Fo's texts about new finds.");
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
function filingMoves(ctx: Ctx, planId: string): { filing: PlanOpRow[]; fresh: PlanOpRow[]; refiled: number; copies: number; freshCopies: PlanOpRow[] } {
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state <> 'excluded' ORDER BY seq", planId);
  const filing = moves.filter((o) => !(o.new_path && inDuplicatesFolder(o.new_path)));
  const fresh = filing.filter((o) => !alreadyFiled(o.pre_path));
  // A copy still loose in the folder is one you just added, not old housekeeping.
  const freshCopies = moves.filter((o) => o.new_path && inDuplicatesFolder(o.new_path) && !alreadyFiled(o.pre_path));
  return { filing, fresh, refiled: filing.length - fresh.length, copies: moves.length - filing.length, freshCopies };
}

/** Files the proposal asks you about: Kiki read them but couldn't tell where they go. */
function openQuestionNames(plan: PlanRow): string[] {
  const notes = ((plan.details_json ? (JSON.parse(plan.details_json) as { notes?: { name: string; unplaced?: boolean }[] } | null) : null)?.notes ?? []);
  return notes.filter((n) => n.unplaced).map((n) => n.name);
}

function findSummary(ctx: Ctx, plan: PlanRow): string {
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", plan.workspace_id)!;
  // Nothing to move, only files Kiki couldn't place: ask where they go.
  if (!one(ctx.db, "SELECT id FROM plan_ops WHERE plan_id = ? AND state <> 'excluded'", plan.id)) {
    const notes = ((plan.details_json ? (JSON.parse(plan.details_json) as { notes?: { name: string; unplaced?: boolean }[] } | null) : null)?.notes ?? []).filter((n) => n.unplaced);
    const which = notes.length === 1 ? `"${inert(notes[0]!.name)}"` : `${notes.length} documents`;
    return `Kiki: she can't tell where ${which} in "${inert(ws.name)}" should go. Reply to this text, or answer in Kiki: tell her a project or folder, or say to leave ${notes.length === 1 ? "it" : "them"} where ${notes.length === 1 ? "it is" : "they are"}.`;
  }
  // A quote update from a contractor's answer isn't a new document: say what changes.
  if (plan.kind === "version_update") return `Kiki: ${inert(plan.title)} in "${inert(ws.name)}". ${inert(plan.summary, 400)} Reply to this text, or answer in Kiki: yes, a change, or no.`;
  const { fresh, refiled, copies, freshCopies } = filingMoves(ctx, plan.id);
  const questions = openQuestionNames(plan);
  const asks = questions.length
    ? ` She can't tell where ${questions.length === 1 ? `"${inert(questions[0]!)}" goes` : `${questions.length} documents go`}: tell her a project or folder, or say to leave ${questions.length === 1 ? "it" : "them"}.`
    : "";
  const answer = " Reply to this text, or answer in Kiki: yes, a change, or no.";
  if (!fresh.length && freshCopies.length) {
    const which = freshCopies.length === 1 ? `"${inert(freshCopies[0]!.pre_name)}" is an exact copy` : `${freshCopies.length} files you added are exact copies`;
    return `Kiki: ${which} of what's already filed in "${inert(ws.name)}". Want me to set ${freshCopies.length === 1 ? "it" : "them"} aside in Duplicates? Nothing is deleted.${asks}${answer}`;
  }
  const extras = [
    refiled ? `rename or move ${refiled} document${refiled === 1 ? "" : "s"} already filed` : null,
    copies ? `set aside ${copies} exact cop${copies === 1 ? "y" : "ies"}` : null,
  ].filter(Boolean);
  const also = extras.length ? ` (Kiki would also ${extras.join(" and ")}; nothing is deleted.)` : "";
  if (fresh.length === 1) {
    const op = fresh[0]!;
    const doc = op.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", op.doc_id) : undefined;
    const facts = doc?.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
    return `Kiki: ${inert(describeDoc(facts))} just landed in "${inert(ws.name)}". Want me to file it in ${inert(op.new_path)}?${also}${asks}${answer}`;
  }
  if (!fresh.length && questions.length) return `Kiki: new in "${inert(ws.name)}".${asks}${also}${answer}`;
  return `Kiki: ${fresh.length} new documents in "${inert(ws.name)}" are ready to file.${also}${asks}${answer}`;
}

/** Complete scope is supplied to Fo and the account holder, including renames and version changes. */
export function newFindText(ctx: Ctx, plan: PlanRow): string {
  return `${findSummary(ctx, plan)}\n\nProposed changes (version ${plan.version}):\n${proposalLines(ctx, plan)}\nNothing is deleted. You can answer Fo naturally, ask a question, ask for changes, or decline.`;
}

/** A text with its answer link: the link is where you answer, so the text points to it. */
function withLink(text: string, link: string | null): string {
  if (!link) return text;
  return `${text.replace(/Reply to this text, or answer in Kiki:/g, "Answer at the link below:")}\n\nAnswer here: ${link}`;
}

/** The request that has Fo text you a proposal (and only you), with the binding for your answer. */
export function textedProposal(ctx: Ctx, plan: PlanRow, binding: ApprovalBinding, lead?: string, taskId?: string): { body: string; request: string } {
  const link = taskId ? answerLink(ctx, taskId) : null;
  const body = withLink(`${lead ? `${lead}\n\n` : ""}${newFindText(ctx, plan)}`, link);
  return { body, request: message(body, newReference(), "text") + "\n\n" + approvalInstructions(binding) };
}

/** Standing permission, texts to the account holder only: one text per new proposal. */
export function autoNotifyProposal(ctx: Ctx, plan: PlanRow): void {
  if (!autoTextEnabled(ctx)) return;
  // Renaming what's already filed, or setting copies aside, is housekeeping, not something new:
  // it waits in the app, no text. A question about where a new file goes is worth one.
  const moves = filingMoves(ctx, plan.id);
  const news = moves.fresh.length > 0 || moves.freshCopies.length > 0 || openQuestionNames(plan).length > 0;
  if (!news && !one(ctx.db, "SELECT id FROM plan_ops WHERE plan_id = ? AND kind = 'set_status' AND state <> 'excluded'", plan.id)) return;
  // One text per distinct proposal, even if it gets re-saved as a new version.
  if (kvGet(ctx.db, `notify.plan.${plan.id}`) || kvGet(ctx.db, `notify.hash.${plan.content_hash}`)) return;
  kvSet(ctx.db, `notify.hash.${plan.content_hash}`, plan.id);
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  // The link to answer it: your answer there stays tied to this exact proposal.
  const link = answerLink(ctx, taskId);
  const text = withLink(newFindText(ctx, plan), link);
  kvSet(ctx.db, `notify.plan.${plan.id}`, taskId);
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  kvSet(ctx.db, `notify.purpose.${taskId}`, "find");
  const binding: ApprovalBinding = { requestId: randomUUID(), planId: plan.id, contentHash: plan.content_hash };
  saveReply(ctx, taskId, { status: "waiting", text: null, source: null, ...binding, requestedAt: new Date().toISOString() });
  logEvent(ctx.db, plan.workspace_id, "fo_text", `Kiki asked ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to text you about it.`);
  void ctx.engine.start(taskId, message(text, newReference(), "text") + "\n\n" + approvalInstructions(binding)).catch(() => undefined);
}
