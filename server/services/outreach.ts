import { randomUUID } from "node:crypto";
import {
  isUniqueViolation,
  kvGet,
  kvSet,
  logEvent,
  now,
  one,
  run,
  tx,
  type ActionVersionRow,
  type Db,
  type DispatchRow,
  type FoTaskRow,
  type ItemRow,
} from "../db.ts";
import {
  buildDispatchMessage,
  buildReplyMessage,
  buildStopMessage,
  classifyDispatchReply,
  contentHash,
  draftTemplate,
  newReference,
  stripStatusLines,
  validateDraft,
  withGreeting,
  type DraftContent,
} from "../domain/outreach.ts";
import { AppError, badRequest, conflict, notFound } from "../errors.ts";
import { getTask, insertTask, type FoEngine, type TaskHandler } from "../fo/engine.ts";
import { inventoryReplyMessage, runForTask } from "./inventory.ts";
import { getRequest, storedExtraction, storedRisk } from "./requests.ts";

const STUDENT_NAME = "settings.student_name";

export function getStudentName(db: Db): string | null {
  return kvGet(db, STUDENT_NAME) ?? null;
}

export function setStudentName(db: Db, name: string): void {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw badRequest("Add your first name.");
  kvSet(db, STUDENT_NAME, clean);
}

function getItem(db: Db, itemId: string): ItemRow {
  const item = one<ItemRow>(db, "SELECT * FROM checklist_items WHERE id = ? AND removed = 0", itemId);
  if (!item) throw notFound("That checklist item doesn't exist.");
  return item;
}

function getVersion(db: Db, versionId: string): ActionVersionRow {
  const v = one<ActionVersionRow>(db, "SELECT * FROM action_versions WHERE id = ?", versionId);
  if (!v) throw notFound("That draft doesn't exist.");
  return v;
}

export function currentVersion(db: Db, itemId: string): ActionVersionRow | undefined {
  return one<ActionVersionRow>(db, "SELECT * FROM action_versions WHERE item_id = ? AND superseded_at IS NULL", itemId);
}

function contentOf(v: ActionVersionRow): DraftContent {
  return { recipientName: v.recipient_name, recipientEmail: v.recipient_email, subject: v.subject, body: v.body };
}

function insertVersion(db: Db, item: ItemRow, version: number, c: DraftContent): string {
  const id = randomUUID();
  run(
    db,
    `INSERT INTO action_versions (id, request_id, item_id, version, channel, recipient_name, recipient_email, subject, body, content_hash, created_at)
     VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)`,
    id,
    item.request_id,
    item.id,
    version,
    c.recipientName.trim(),
    c.recipientEmail.trim(),
    c.subject,
    c.body,
    contentHash(c),
    now(),
  );
  return id;
}

/** Drafts the outreach in the app. Nothing is sent to Fo until the user approves this exact text. */
export function createDraft(db: Db, itemId: string, input: { recipientName?: string; recipientEmail?: string }): string {
  const item = getItem(db, itemId);
  if (item.status !== "missing" && item.status !== "needs_review") throw conflict("Only a missing item needs outreach.");
  if (item.category === "credential" || item.category === "sensitive_number") throw conflict("Paper Chase won't ask anyone for passwords or identifiers.");
  const existing = currentVersion(db, itemId);
  if (existing) return existing.id;
  const studentName = getStudentName(db);
  if (!studentName) throw badRequest("Add your first name so Kiki can introduce herself on your behalf.");
  const recipientName = (input.recipientName ?? "").trim();
  if (!recipientName) throw badRequest("Add who this is for (for example, Mom).");

  const request = getRequest(db, item.request_id);
  const extraction = storedExtraction(request);
  const organization = extraction?.extraction.requester.organization ?? extraction?.requesterDomain ?? null;
  const template = draftTemplate({
    studentName,
    itemLabel: item.label,
    isGuarantor: item.category === "guarantor" || /guarantor|co-?signer/i.test(item.label),
    organization,
    deadlineText: extraction?.extraction.deadline?.text ?? null,
  });
  const content: DraftContent = {
    recipientName,
    recipientEmail: (input.recipientEmail ?? "").trim(),
    subject: template.subject,
    body: withGreeting(recipientName, template.body),
  };
  return tx(db, () => {
    const raced = currentVersion(db, itemId);
    if (raced) return raced.id;
    const id = insertVersion(db, item, 1, content);
    logEvent(db, item.request_id, "draft", `Kiki drafted a message to ${recipientName} about "${item.label}" (version 1). Nothing has been sent.`);
    return id;
  });
}

/** Every edit is a new version. Approvals are bound to a version, so they never carry over. */
export function reviseDraft(db: Db, versionId: string, input: Partial<DraftContent>): string {
  const v = getVersion(db, versionId);
  if (v.superseded_at) throw conflict("This draft was already changed. Reload to see the latest version.", "stale_draft");
  const next: DraftContent = {
    recipientName: (input.recipientName ?? v.recipient_name).trim(),
    recipientEmail: (input.recipientEmail ?? v.recipient_email).trim(),
    subject: input.subject ?? v.subject,
    body: input.body ?? v.body,
  };
  if (next.subject.length > 200 || next.body.length > 5000 || next.recipientName.length > 80 || next.recipientEmail.length > 200) throw badRequest("That's too long.");
  if (contentHash(next) === v.content_hash) return v.id;
  const item = getItem(db, v.item_id);
  return tx(db, () => {
    const n = run(db, "UPDATE action_versions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL", now(), v.id);
    if (n !== 1) throw conflict("This draft was already changed. Reload to see the latest version.", "stale_draft");
    const id = insertVersion(db, item, v.version + 1, next);
    logEvent(db, v.request_id, "draft", `You changed the message (now version ${v.version + 1}). It needs a fresh approval.`);
    return id;
  });
}

export function discardDraft(db: Db, versionId: string): void {
  const v = getVersion(db, versionId);
  if (v.superseded_at) return;
  tx(db, () => {
    run(db, "UPDATE action_versions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL", now(), v.id);
    logEvent(db, v.request_id, "draft", "You set the draft aside. Nothing was sent.");
  });
}

export interface SendResult {
  dispatchId: string;
  created: boolean;
  work: Promise<void>;
}

/**
 * Approve and send, as one transaction: verify the user approved exactly the current version,
 * record the approval and a durable dispatch, then hand the approved text to Fo. Repeated clicks
 * and retried requests resolve to the same dispatch instead of sending again.
 */
export function approveAndSend(
  db: Db,
  engine: FoEngine,
  versionId: string,
  input: { contentHash?: string; clientRequestId?: string; confirmResend?: boolean },
): SendResult {
  const clientRequestId = input.clientRequestId ?? "";
  if (!clientRequestId || clientRequestId.length > 100) throw badRequest("Missing request id.");

  const attempt = (): { dispatch: DispatchRow; created: boolean; message: string | null } =>
    tx(db, () => {
      const same = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE client_request_id = ?", clientRequestId);
      if (same) return { dispatch: same, created: false, message: null };

      const v = getVersion(db, versionId);
      if (v.superseded_at) throw conflict("This draft changed after you reviewed it. Review the latest version.", "stale_draft");
      if (input.contentHash !== v.content_hash) throw conflict("What you approved doesn't match the saved draft. Review it again.", "hash_mismatch");
      const problems = validateDraft(contentOf(v));
      if (problems.length) throw badRequest(problems.join(" "));

      const request = getRequest(db, v.request_id);
      const risk = storedRisk(request);
      if (risk?.hasWarnings && !request.risk_reviewed_at) {
        throw new AppError(423, "Sharing is on hold: review this request's warning signs first.", "risk_hold");
      }

      const open = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE item_id = ? AND open = 1", v.item_id);
      if (open) return { dispatch: open, created: false, message: null };

      const alreadySent = one<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM dispatches WHERE item_id = ? AND (outcome IN ('reported_sent', 'verified_sent') OR retired_at IS NOT NULL)",
        v.item_id,
      )!.n;
      if (alreadySent > 0 && input.confirmResend !== true) {
        throw conflict("Fo may already have sent a message about this. Sending again would send another email.", "already_sent");
      }

      const approvalId = randomUUID();
      run(
        db,
        "INSERT INTO approvals (id, action_version_id, content_hash, approved_at, risk_review_acknowledged) VALUES (?, ?, ?, ?, ?)",
        approvalId,
        v.id,
        v.content_hash,
        now(),
        request.risk_reviewed_at ? 1 : 0,
      );
      const attemptNo = (one<{ a: number | null }>(db, "SELECT MAX(attempt) AS a FROM dispatches WHERE action_version_id = ?", v.id)?.a ?? 0) + 1;
      const taskId = insertTask(db, "dispatch", engine.mode);
      const reference = newReference();
      const dispatchId = randomUUID();
      run(
        db,
        `INSERT INTO dispatches (id, item_id, action_version_id, approval_id, attempt, client_request_id, reference, fo_task_id, open, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        dispatchId,
        v.item_id,
        v.id,
        approvalId,
        attemptNo,
        clientRequestId,
        reference,
        taskId,
        now(),
      );
      logEvent(db, v.request_id, "approved", `You approved version ${v.version} to ${v.recipient_email}. Handing it to ${engine.mode === "mock" ? "Mock Fo" : "Fo"} to send.`);
      const dispatch = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE id = ?", dispatchId)!;
      return { dispatch, created: true, message: buildDispatchMessage(contentOf(v), reference) };
    });

  let result;
  try {
    result = attempt();
  } catch (err) {
    // Another process won the race on a unique index: re-read instead of failing.
    if (!isUniqueViolation(err)) throw err;
    result = attempt();
  }
  const work = result.created && result.message ? engine.start(result.dispatch.fo_task_id, result.message) : Promise.resolve();
  return { dispatchId: result.dispatch.id, created: result.created, work };
}

function getDispatch(db: Db, id: string): DispatchRow {
  const d = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE id = ?", id);
  if (!d) throw notFound("That send attempt doesn't exist.");
  return d;
}

/** The user answers Fo's question. Dispatch answers carry the approval's limits with them. */
export function replyToTask(db: Db, engine: FoEngine, taskId: string, answer: string): Promise<void> {
  const text = (answer ?? "").trim();
  if (!text) throw badRequest("Write an answer for Fo.");
  if (text.length > 2000) throw badRequest("That answer is too long.");
  const task = getTask(db, taskId);
  if (!task) throw notFound("That Fo conversation doesn't exist.");
  let message: string;
  let requestId: string | null = null;
  if (task.kind === "dispatch") {
    const d = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE fo_task_id = ?", taskId)!;
    const v = getVersion(db, d.action_version_id);
    message = buildReplyMessage(text, contentOf(v), d.reference);
    requestId = v.request_id;
  } else {
    const r = runForTask(db, taskId)!;
    message = inventoryReplyMessage(text, r.reference);
    requestId = r.request_id;
  }
  const work = engine.continue(taskId, message);
  logEvent(db, requestId, "fo_reply", "You answered Fo's question.");
  return work;
}

/** Only possible while Fo is waiting on the user; a working turn is never interrupted. */
export function stopDispatch(db: Db, engine: FoEngine, dispatchId: string): Promise<void> {
  const d = getDispatch(db, dispatchId);
  const task = getTask(db, d.fo_task_id)!;
  if (task.state !== "needs_user_input") throw conflict("You can only call this off while Fo is waiting for you.");
  run(db, "UPDATE dispatches SET stop_requested_at = ? WHERE id = ?", now(), d.id);
  const work = engine.continue(d.fo_task_id, buildStopMessage(d.reference));
  const v = getVersion(db, d.action_version_id);
  logEvent(db, v.request_id, "stop", "You asked Fo not to send the email.");
  return work;
}

export async function reconcileDispatch(db: Db, engine: FoEngine, dispatchId: string): Promise<{ found: boolean; note: string }> {
  const d = getDispatch(db, dispatchId);
  const result = await engine.reconcile(d.fo_task_id, d.reference);
  run(db, "UPDATE dispatches SET reconciled_at = ?, reconcile_note = ? WHERE id = ?", now(), result.note, d.id);
  const v = getVersion(db, d.action_version_id);
  logEvent(db, v.request_id, "reconcile", result.note);
  return result;
}

/**
 * After a reconciliation attempt, the user may close an uncertain attempt to allow a new one,
 * explicitly accepting that the first one might have gone out.
 */
export function retireDispatch(db: Db, dispatchId: string, acknowledge: boolean): void {
  const d = getDispatch(db, dispatchId);
  const task = getTask(db, d.fo_task_id)!;
  if (task.state !== "uncertain" || d.retired_at) throw conflict("Only an uncertain attempt can be closed.");
  if (!d.reconciled_at) throw conflict("Check with Fo first.");
  if (!acknowledge) throw badRequest("Confirm that you understand the first email might have been sent.");
  const v = getVersion(db, d.action_version_id);
  tx(db, () => {
    run(db, "UPDATE dispatches SET retired_at = ?, open = 0 WHERE id = ?", now(), d.id);
    logEvent(db, v.request_id, "retire", "You closed an uncertain send attempt. If Fo did send it, a new attempt will send another email.");
  });
}

export function dispatchHandler(db: Db): TaskHandler {
  return {
    onComplete(task: FoTaskRow, response: string) {
      const d = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE fo_task_id = ?", task.id);
      if (!d) return { question: null };
      const v = getVersion(db, d.action_version_id);
      const fo = task.mode === "mock" ? "Mock Fo" : "Fo";
      switch (classifyDispatchReply(response)) {
        case "sent":
          run(db, "UPDATE dispatches SET outcome = 'reported_sent', open = 0 WHERE id = ?", d.id);
          logEvent(db, v.request_id, "reported_sent", `${fo} reports the email to ${v.recipient_email} was sent. Not independently verified.`);
          return { question: null };
        case "not_sent":
          run(db, "UPDATE dispatches SET outcome = 'not_sent', open = 0 WHERE id = ?", d.id);
          logEvent(db, v.request_id, "not_sent", `${fo} reports it did not send the email.`);
          return { question: null };
        case "need_input":
          return { question: stripStatusLines(response) || response };
        case "unclear":
          return { question: `Fo replied without saying whether the email went out:\n\n${stripStatusLines(response) || response}` };
      }
    },
    onStateChange(task: FoTaskRow) {
      if (task.state !== "failed") return;
      const d = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE fo_task_id = ?", task.id);
      if (!d || !d.open) return;
      run(db, "UPDATE dispatches SET open = 0 WHERE id = ?", d.id);
      const v = getVersion(db, d.action_version_id);
      logEvent(db, v.request_id, "send_failed", task.failure_kind === "not_sent" || task.failure_kind === "not_started" ? `Not sent: ${task.failure_detail}` : `Fo reported a failure: ${task.failure_detail}`);
    },
  };
}
