import { approvalInstructions } from "../domain/approval.ts";
import { notifyPurpose, replyState, replyWindowMs, saveReply } from "./notify.ts";
import { offerHash } from "./lessons.ts";
import { randomUUID } from "node:crypto";
import {
  all,
  isUniqueViolation,
  kvGet,
  kvSet,
  logEvent,
  now,
  one,
  run,
  tx,
  type Db,
  type DispatchRow,
  type DocumentRow,
  type FoTaskRow,
  type OutreachVersionRow,
  type WatchRow,
} from "../db.ts";
import {
  buildDispatchMessage,
  buildFollowUpMessage,
  buildReplyMessage,
  buildStopMessage,
  classifyDispatchReply,
  contentHash,
  contractorDraft,
  copyRequestDraft,
  newReference,
  stripStatusLines,
  validateDraft,
  type DraftContent,
} from "../domain/outreach.ts";
import { money } from "../domain/reconcile.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { getTask, insertTask, type TaskHandler } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { docFacts } from "./workspace.ts";

const USER_NAME = "settings.user_name";

export function getUserName(db: Db): string | null {
  return kvGet(db, USER_NAME) ?? null;
}

export function setUserName(db: Db, name: string): void {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw badRequest("Add your first name.");
  kvSet(db, USER_NAME, clean);
}

function getDoc(db: Db, id: string): DocumentRow {
  const doc = one<DocumentRow>(db, "SELECT * FROM documents WHERE id = ?", id);
  if (!doc) throw notFound("That document isn't in the index.");
  return doc;
}

function getVersion(db: Db, id: string): OutreachVersionRow {
  const v = one<OutreachVersionRow>(db, "SELECT * FROM outreach_versions WHERE id = ?", id);
  if (!v) throw notFound("That draft doesn't exist.");
  return v;
}

export function currentOutreach(db: Db, documentId: string): OutreachVersionRow | undefined {
  return one<OutreachVersionRow>(db, "SELECT * FROM outreach_versions WHERE document_id = ? AND superseded_at IS NULL", documentId);
}

function contentOf(v: OutreachVersionRow): DraftContent {
  return { recipientName: v.recipient_name, recipientEmail: v.recipient_email, subject: v.subject, body: v.body };
}

function insertVersion(
  db: Db,
  doc: DocumentRow,
  version: number,
  c: DraftContent,
  purpose: string,
  consent: boolean,
  kind: OutreachVersionRow["kind"] = "ask_final",
  requestJson: string | null = null,
): string {
  const id = randomUUID();
  run(
    db,
    `INSERT INTO outreach_versions (id, workspace_id, document_id, version, recipient_name, recipient_email, consent_confirmed, purpose, subject, body, content_hash, created_at, kind, request_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    doc.workspace_id,
    doc.id,
    version,
    c.recipientName.trim(),
    c.recipientEmail.trim(),
    consent ? 1 : 0,
    purpose,
    c.subject,
    c.body,
    contentHash(c),
    now(),
    kind,
    requestJson,
  );
  return id;
}

/** What a copy request asks for, if this outreach is one. */
export function requestOf(v: Pick<OutreachVersionRow, "kind" | "request_json">): { docType: string; reference: string } | null {
  return v.kind === "request_copy" && v.request_json ? (JSON.parse(v.request_json) as { docType: string; reference: string }) : null;
}

const refKey = (s: string | null | undefined) => (s ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

/** Whether a read document in the workspace carries this reference (or replaces it). */
export function referenceOnFile(db: Db, wsId: string, reference: string): DocumentRow | undefined {
  const k = refKey(reference);
  return all<DocumentRow>(db, "SELECT d.* FROM documents d JOIN files f ON f.workspace_id = d.workspace_id AND f.file_id = d.file_id WHERE d.workspace_id = ? AND d.read_status = 'read' AND f.present = 1", wsId).find((d) => {
    const f = docFacts(d);
    return Boolean(f) && (refKey(f!.reference.value) === k || refKey(f!.revision.revisesReference) === k);
  });
}

/**
 * Drafts a request for a copy of a document that another one refers to but that isn't in the
 * folder (say, the quote a deposit invoice is for). Like the quote question, it's composed here
 * and nothing reaches Fo until you approve this exact text.
 */
export function createCopyRequestDraft(ctx: Ctx, documentId: string, input: { reference?: string; contractorName?: string; contractorEmail?: string; consent?: boolean }): string {
  const doc = getDoc(ctx.db, documentId);
  const facts = docFacts(doc);
  if (!facts) throw conflict("Kiki needs to read that document first.");
  const asked = (facts.refersTo ?? []).find((r) => refKey(r.reference) === refKey(input.reference ?? ""));
  if (!asked) throw badRequest("That document doesn't mention it.");
  if (referenceOnFile(ctx.db, doc.workspace_id, asked.reference)) throw conflict(`${asked.reference} is already in the folder.`);
  const existing = currentOutreach(ctx.db, documentId);
  if (existing) {
    if (requestOf(existing)?.reference === asked.reference) return existing.id;
    throw conflict("There's already a message about this document. Finish or discard it first.");
  }
  const userName = getUserName(ctx.db);
  if (!userName) throw badRequest("Add your first name so Kiki can say who she's helping.");
  const name = (input.contractorName ?? "").trim();
  if (!name) throw badRequest("Add the contractor's name.");
  if (input.consent !== true) throw badRequest("Only contact someone who has agreed to hear from your assistant.", "consent_required");
  const type = (t: string) => (t === "other" || t === "unknown" ? "document" : t);
  const draft = copyRequestDraft({
    userName,
    contractorName: name,
    requested: { docType: type(asked.docType), reference: asked.reference },
    mentionedIn: { docType: type(facts.docType), reference: facts.reference.value },
  });
  const content: DraftContent = { recipientName: name, recipientEmail: (input.contractorEmail ?? "").trim(), subject: draft.subject, body: draft.body };
  return tx(ctx.db, () => {
    const raced = currentOutreach(ctx.db, documentId);
    if (raced) return raced.id;
    const id = insertVersion(ctx.db, doc, 1, content, draft.purpose, true, "request_copy", JSON.stringify({ docType: asked.docType, reference: asked.reference }));
    logEvent(ctx.db, doc.workspace_id, "draft", `Kiki drafted a request to ${name} for a copy of ${asked.reference} (version 1). Nothing has been sent.`);
    return id;
  });
}

/** Drafts the question to the contractor locally. Fo is not involved until this exact text is approved. */
export function createOutreachDraft(ctx: Ctx, documentId: string, input: { contractorName?: string; contractorEmail?: string; consent?: boolean }): string {
  const doc = getDoc(ctx.db, documentId);
  const facts = docFacts(doc);
  if (doc.doc_type !== "quote" || !facts) throw conflict("Kiki can only ask about a quote she has read.");
  const existing = currentOutreach(ctx.db, documentId);
  if (existing) return existing.id;
  const userName = getUserName(ctx.db);
  if (!userName) throw badRequest("Add your first name so Kiki can say who she's helping.");
  const name = (input.contractorName ?? "").trim();
  if (!name) throw badRequest("Add the contractor's name.");
  if (input.consent !== true) throw badRequest("Only contact someone who has agreed to hear from your assistant.", "consent_required");
  const project = facts.project.value ?? "renovation";
  const draft = contractorDraft({
    userName,
    contractorName: name,
    project,
    quote: { issuer: facts.issuer.value, reference: facts.reference.value, date: facts.date.value, total: facts.total.value === null ? null : money(facts.total.value, facts.total.currency) },
  });
  const content: DraftContent = { recipientName: name, recipientEmail: (input.contractorEmail ?? "").trim(), subject: draft.subject, body: draft.body };
  return tx(ctx.db, () => {
    const raced = currentOutreach(ctx.db, documentId);
    if (raced) return raced.id;
    const id = insertVersion(ctx.db, doc, 1, content, draft.purpose, true);
    logEvent(ctx.db, doc.workspace_id, "draft", `Kiki drafted a question to ${name} about ${facts.reference.value ?? "the quote"} (version 1). Nothing has been sent.`);
    return id;
  });
}

/** Every edit is a new version, so an approval never carries over to different text. */
export function reviseOutreach(ctx: Ctx, versionId: string, input: Partial<DraftContent> & { consent?: boolean }): string {
  const v = getVersion(ctx.db, versionId);
  if (v.superseded_at) throw conflict("This draft was already changed. Reload to see the latest version.", "stale_draft");
  const next: DraftContent = {
    recipientName: (input.recipientName ?? v.recipient_name).trim(),
    recipientEmail: (input.recipientEmail ?? v.recipient_email).trim(),
    subject: input.subject ?? v.subject,
    body: input.body ?? v.body,
  };
  if (next.subject.length > 200 || next.body.length > 4000 || next.recipientName.length > 80 || next.recipientEmail.length > 200) throw badRequest("That's too long.");
  if (contentHash(next) === v.content_hash) return v.id;
  const recipientChanged = next.recipientEmail.toLowerCase() !== v.recipient_email.toLowerCase();
  if (recipientChanged && input.consent !== true) throw badRequest("Confirm the new recipient agreed to hear from your assistant.", "consent_required");
  const doc = getDoc(ctx.db, v.document_id);
  return tx(ctx.db, () => {
    const n = run(ctx.db, "UPDATE outreach_versions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL", now(), v.id);
    if (n !== 1) throw conflict("This draft was already changed. Reload to see the latest version.", "stale_draft");
    const id = insertVersion(ctx.db, doc, v.version + 1, next, v.purpose, recipientChanged ? true : Boolean(v.consent_confirmed), v.kind, v.request_json);
    logEvent(ctx.db, v.workspace_id, "draft", `You changed the message (now version ${v.version + 1}). It needs a fresh approval.`);
    return id;
  });
}

export function discardOutreach(ctx: Ctx, versionId: string): void {
  const v = getVersion(ctx.db, versionId);
  if (v.superseded_at) return;
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE outreach_versions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL", now(), v.id);
    logEvent(ctx.db, v.workspace_id, "draft", "You set the message aside. Nothing was sent.");
  });
}

/**
 * Approve and send, as one transaction: the user approved exactly the current version, the
 * approval and a durable dispatch are recorded, and only then is Fo asked to send it. Repeated
 * clicks and retried requests resolve to the same dispatch.
 */
export function approveAndSend(ctx: Ctx, versionId: string, input: { contentHash?: string; clientRequestId?: string; confirmResend?: boolean }): { dispatchId: string; created: boolean } {
  const clientRequestId = input.clientRequestId ?? "";
  if (!clientRequestId || clientRequestId.length > 100) throw badRequest("Missing request id.");
  const attempt = () =>
    tx(ctx.db, () => {
      const same = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE client_request_id = ?", clientRequestId);
      if (same) return { dispatch: same, created: false, message: null as string | null };
      const v = getVersion(ctx.db, versionId);
      if (v.superseded_at) throw conflict("This message changed after you reviewed it. Review the latest version.", "stale_draft");
      if (input.contentHash !== v.content_hash) throw conflict("What you approved doesn't match the saved message. Review it again.", "hash_mismatch");
      if (!v.consent_confirmed) throw badRequest("Confirm the recipient agreed to hear from your assistant.", "consent_required");
      const problems = validateDraft(contentOf(v));
      if (problems.length) throw badRequest(problems.join(" "));
      const open = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE document_id = ? AND open = 1", v.document_id);
      if (open) return { dispatch: open, created: false, message: null };
      const sentBefore = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM dispatches WHERE document_id = ? AND (outcome = 'reported_sent' OR retired_at IS NOT NULL)", v.document_id)!.n;
      if (sentBefore > 0 && input.confirmResend !== true) throw conflict("Fo may already have sent a message about this quote. Sending again would send another email.", "already_sent");
      const approvalId = randomUUID();
      run(ctx.db, "INSERT INTO outreach_approvals (id, version_id, content_hash, approved_at) VALUES (?, ?, ?, ?)", approvalId, v.id, v.content_hash, now());
      const attemptNo = (one<{ a: number | null }>(ctx.db, "SELECT MAX(attempt) AS a FROM dispatches WHERE version_id = ?", v.id)?.a ?? 0) + 1;
      const taskId = insertTask(ctx.db, "dispatch", ctx.engine.mode);
      const reference = newReference();
      const id = randomUUID();
      run(
        ctx.db,
        `INSERT INTO dispatches (id, document_id, version_id, approval_id, attempt, client_request_id, reference, fo_task_id, open, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        id,
        v.document_id,
        v.id,
        approvalId,
        attemptNo,
        clientRequestId,
        reference,
        taskId,
        now(),
      );
      logEvent(ctx.db, v.workspace_id, "approved", `You approved version ${v.version} to ${v.recipient_email}. Handing it to ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to send.`);
      return { dispatch: one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE id = ?", id)!, created: true, message: buildDispatchMessage(contentOf(v), reference) };
    });
  let result;
  try {
    result = attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    result = attempt();
  }
  if (result.created && result.message) void ctx.engine.start(result.dispatch.fo_task_id, result.message).catch(() => undefined);
  return { dispatchId: result.dispatch.id, created: result.created };
}

function getDispatch(db: Db, id: string): DispatchRow {
  const d = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE id = ?", id);
  if (!d) throw notFound("That send attempt doesn't exist.");
  return d;
}

/**
 * The user answers Fo's question in the mapped conversation. Answers carry the approval's limits.
 * Resolves once the answer is on its way (Fo's reply comes back later); a problem found before
 * sending is thrown, or rejects, so the app can say what it was.
 */
export const READING_ANSWER = "Fo is reading your answer now. Fo will text you what happens.";

export function replyToTask(ctx: Ctx, taskId: string, answer: string): Promise<void> {
  const text = (answer ?? "").trim();
  if (!text) throw badRequest("Write an answer for Fo.");
  if (text.length > 2000) throw badRequest("That answer is too long.");
  const task = getTask(ctx.db, taskId);
  if (!task) throw notFound("That Fo conversation doesn't exist.");
  const d = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE fo_task_id = ?", taskId);
  let message = text;
  let wsId: string | null = null;
  if (task.kind === "notify") {
    const approval = replyState(ctx, taskId);
    if (approval?.requestId) {
      if (notifyPurpose(ctx, taskId) === "offer") {
        // An offer to file a kind of document on her own: still open while that lesson is as offered.
        const l = one<import("../db.ts").LessonRow>(ctx.db, "SELECT * FROM lessons WHERE id = ?", approval.planId);
        if (approval.status !== "waiting" || !l || l.auto || offerHash(l) !== approval.contentHash) throw conflict("That offer isn't waiting for your answer anymore.");
      } else {
        const plan = one<import("../db.ts").PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", approval.planId);
        if (approval.status !== "waiting" || !plan || plan.status !== "proposed" || plan.content_hash !== approval.contentHash) throw conflict("That proposal is no longer awaiting approval.");
      }
      if (!approval.requestedAt || Date.now() - Date.parse(approval.requestedAt) > replyWindowMs(ctx, taskId)) throw conflict("That approval request expired. Refresh the proposal first.");
      // Fo is still reading your last answer (a second tap, say): that one stands, nothing is sent twice.
      if (["pending", "asking", "working"].includes(task.state)) throw conflict(READING_ANSWER);
      const relayed = `Answer from the account holder (data): ${JSON.stringify(text)}\n\n${approvalInstructions({ requestId: approval.requestId, planId: approval.planId, contentHash: approval.contentHash })}`;
      const send = () => {
        if (getTask(ctx.db, taskId)?.state === "complete") run(ctx.db, "UPDATE fo_tasks SET state = 'needs_user_input' WHERE id = ? AND state = 'complete'", taskId);
        // A decision will count only as Fo's reply to this answer.
        const latest = replyState(ctx, taskId) ?? approval;
        saveReply(ctx, taskId, { ...latest, note: undefined, answers: [...(latest.answers ?? []), { text, at: new Date().toISOString() }] });
        void ctx.engine.continue(taskId, relayed).catch(() => undefined);
        logEvent(ctx.db, null, "fo_reply", "You answered Fo's question.");
      };
      if (task.state === "complete" && task.conversation_id) {
        // Fo's turn there is over. Check (read-only) that it hasn't started another before sending
        // your answer into the conversation: a new message never goes into a working turn.
        return ctx.fo.getFoReply({ conversationId: task.conversation_id, waitSeconds: 0 }).then((status) => {
          if (status.status === "working") throw conflict("Fo is still working in this conversation. Try again when it's done.");
          send();
        });
      }
      send();
      return Promise.resolve();
    } else message = `Answer from the user: ${text}

Reminder: this is still only about sending me (the account holder) the exact text from my earlier message. Don't contact anyone else or take any other action. End your reply with exactly one of: KIKI-STATUS: SENT, KIKI-STATUS: NOT-SENT, KIKI-STATUS: NEED-INPUT.`;
  } else if (d) {
    const v = getVersion(ctx.db, d.version_id);
    message = buildReplyMessage(text, contentOf(v), d.reference);
    wsId = v.workspace_id;
  } else {
    const w = one<WatchRow & { reference: string }>(ctx.db, "SELECT w.*, d.reference FROM watches w JOIN dispatches d ON d.id = w.dispatch_id WHERE w.conversation_id = ?", task.conversation_id ?? "");
    message = buildFollowUpMessage(text, w?.reference ?? "");
    wsId = w?.workspace_id ?? null;
  }
  void ctx.engine.continue(taskId, message).catch(() => undefined);
  logEvent(ctx.db, wsId, "fo_reply", "You answered Fo's question.");
  return Promise.resolve();
}

/** Only while Fo is waiting on the user; a working turn is never interrupted. */
export function stopDispatch(ctx: Ctx, dispatchId: string): Promise<void> {
  const d = getDispatch(ctx.db, dispatchId);
  const task = getTask(ctx.db, d.fo_task_id)!;
  if (task.state !== "needs_user_input") throw conflict("You can only call this off while Fo is waiting for you.");
  run(ctx.db, "UPDATE dispatches SET stop_requested_at = ? WHERE id = ?", now(), d.id);
  const work = ctx.engine.continue(d.fo_task_id, buildStopMessage(d.reference));
  logEvent(ctx.db, getVersion(ctx.db, d.version_id).workspace_id, "stop", "You asked Fo not to send the email.");
  return work;
}

export async function reconcileDispatch(ctx: Ctx, dispatchId: string): Promise<{ found: boolean; note: string }> {
  const d = getDispatch(ctx.db, dispatchId);
  const result = await ctx.engine.reconcile(d.fo_task_id, d.reference);
  run(ctx.db, "UPDATE dispatches SET reconciled_at = ?, reconcile_note = ? WHERE id = ?", now(), result.note, d.id);
  logEvent(ctx.db, getVersion(ctx.db, d.version_id).workspace_id, "reconcile", result.note);
  return result;
}

export function retireDispatch(ctx: Ctx, dispatchId: string, acknowledge: boolean): void {
  const d = getDispatch(ctx.db, dispatchId);
  const task = getTask(ctx.db, d.fo_task_id)!;
  if (task.state !== "uncertain" || d.retired_at) throw conflict("Only an uncertain attempt can be closed.");
  if (!d.reconciled_at) throw conflict("Check with Fo first.");
  if (!acknowledge) throw badRequest("Confirm that you understand the first email might have been sent.");
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE dispatches SET retired_at = ?, open = 0 WHERE id = ?", now(), d.id);
    logEvent(ctx.db, getVersion(ctx.db, d.version_id).workspace_id, "retire", "You closed an uncertain send attempt. If Fo did send it, a new attempt sends another email.");
  });
}

/** Starts following the dispatch's Fo conversation so Kiki can pick up its outcome. */
function openWatch(ctx: Ctx, d: DispatchRow, task: FoTaskRow, workspaceId: string): void {
  if (!task.conversation_id) return;
  const id = randomUUID();
  run(ctx.db, "INSERT OR IGNORE INTO watches (id, workspace_id, dispatch_id, conversation_id, state, created_at) VALUES (?, ?, ?, ?, 'watching', ?)", id, workspaceId, d.id, task.conversation_id, now());
  const watch = one<WatchRow>(ctx.db, "SELECT * FROM watches WHERE dispatch_id = ?", d.id)!;
  ctx.jobs.enqueue("watch", `watch:${watch.id}`, { watchId: watch.id }, 1);
}

export function dispatchHandler(ctx: Ctx): TaskHandler {
  return {
    onComplete(task, response) {
      const d = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE fo_task_id = ?", task.id);
      if (!d) return { question: null };
      const v = getVersion(ctx.db, d.version_id);
      const fo = task.mode === "mock" ? "Mock Fo" : "Fo";
      switch (classifyDispatchReply(response)) {
        case "sent":
          run(ctx.db, "UPDATE dispatches SET outcome = 'reported_sent', open = 0 WHERE id = ?", d.id);
          logEvent(ctx.db, v.workspace_id, "reported_sent", `${fo} reports the email to ${v.recipient_email} was sent. Not independently verified. Kiki is now following that conversation for a reply.`);
          openWatch(ctx, d, task, v.workspace_id);
          return { question: null };
        case "not_sent":
          run(ctx.db, "UPDATE dispatches SET outcome = 'not_sent', open = 0 WHERE id = ?", d.id);
          logEvent(ctx.db, v.workspace_id, "not_sent", `${fo} reports it did not send the email.`);
          return { question: null };
        case "need_input":
          return { question: stripStatusLines(response) || response };
        case "unclear":
          return { question: `Fo replied without saying whether the email went out:\n\n${stripStatusLines(response) || response}` };
      }
    },
    onStateChange(task) {
      if (task.state !== "failed") return;
      const d = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE fo_task_id = ?", task.id);
      if (!d || !d.open) return;
      run(ctx.db, "UPDATE dispatches SET open = 0 WHERE id = ?", d.id);
      const v = getVersion(ctx.db, d.version_id);
      logEvent(ctx.db, v.workspace_id, "send_failed", task.failure_kind === "not_sent" || task.failure_kind === "not_started" ? `Not sent: ${task.failure_detail}` : `Fo reported a failure: ${task.failure_detail}`);
    },
  };
}

export const followUpHandler: TaskHandler = { onComplete: () => ({ question: null }), onStateChange: () => undefined };

