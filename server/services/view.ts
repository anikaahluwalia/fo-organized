import type {
  AppView,
  DispatchState,
  DispatchView,
  FoTaskView,
  ItemView,
  ModesView,
  OutreachView,
  RequestSummary,
  RequestView,
} from "../../shared/api.ts";
import { all, one, type ActionVersionRow, type ApprovalRow, type Db, type DispatchRow, type EventRow, type FoTaskRow, type FoTurnRow, type ItemRow, type RequestRow } from "../db.ts";
import { DEMO_REQUESTS, findDemo } from "../demo.ts";
import { quoteFound } from "../domain/extraction.ts";
import { deriveKiki } from "../domain/kiki.ts";
import { validateDraft } from "../domain/outreach.ts";
import { normalizeDomain } from "../domain/risk.ts";
import { getTask } from "../fo/engine.ts";
import { latestRun } from "./inventory.ts";
import { getStudentName } from "./outreach.ts";
import { storedExtraction, storedRisk } from "./requests.ts";

/** Note: conversation ids are deliberately absent. They are internal handles. */
function taskView(t: FoTaskRow): FoTaskView {
  return {
    taskId: t.id,
    mode: t.mode,
    state: t.state,
    progress: t.progress,
    elapsedSeconds: t.elapsed_seconds,
    question: t.question,
    pollPaused: Boolean(t.poll_paused),
    pollError: t.poll_error,
    failureKind: t.failure_kind,
    failureDetail: t.failure_detail,
    finalResponse: t.final_response,
    startedAt: t.ask_started_at,
  };
}

export function dispatchState(d: DispatchRow, t: FoTaskRow): DispatchState {
  if (d.retired_at) return "retired";
  if (d.outcome) return d.outcome;
  switch (t.state) {
    case "pending":
      return "approved";
    case "asking":
      return "dispatching";
    case "working":
      return "working";
    case "needs_user_input":
      return "needs_user_input";
    case "failed":
      return "failed";
    case "uncertain":
    case "complete":
      return "uncertain";
  }
}

function requestLabel(r: RequestRow): string {
  const ex = storedExtraction(r);
  const who = ex?.extraction.requester.organization ?? ex?.extraction.requester.name ?? ex?.requesterDomain;
  const demo = findDemo(r.demo_key);
  return demo ? demo.title : who ? `Request from ${who}` : "Pasted request";
}

function outreachFor(db: Db, requestId: string, items: ItemRow[]): OutreachView[] {
  const views: OutreachView[] = [];
  for (const item of items) {
    const versions = all<ActionVersionRow>(db, "SELECT * FROM action_versions WHERE item_id = ? ORDER BY version", item.id);
    const dispatchRows = all<DispatchRow>(db, "SELECT * FROM dispatches WHERE item_id = ? ORDER BY created_at, attempt", item.id);
    if (versions.length === 0 && dispatchRows.length === 0) continue;
    const current = versions.find((v) => !v.superseded_at) ?? null;
    const dispatches: DispatchView[] = dispatchRows.map((d) => {
      const t = getTask(db, d.fo_task_id)!;
      const v = versions.find((x) => x.id === d.action_version_id)!;
      const approval = one<ApprovalRow>(db, "SELECT * FROM approvals WHERE id = ?", d.approval_id)!;
      return {
        id: d.id,
        attempt: d.attempt,
        version: v.version,
        state: dispatchState(d, t),
        open: Boolean(d.open),
        task: taskView(t),
        reference: d.reference,
        createdAt: d.created_at,
        approvedAt: approval.approved_at,
        recipientName: v.recipient_name,
        recipientEmail: v.recipient_email,
        subject: v.subject,
        body: v.body,
        reconciledAt: d.reconciled_at,
        reconcileNote: d.reconcile_note,
        retiredAt: d.retired_at,
        stopRequested: Boolean(d.stop_requested_at),
      };
    });
    views.push({
      itemId: item.id,
      itemLabel: item.label,
      versionCount: versions.length,
      draft: current
        ? {
            versionId: current.id,
            version: current.version,
            recipientName: current.recipient_name,
            recipientEmail: current.recipient_email,
            subject: current.subject,
            body: current.body,
            contentHash: current.content_hash,
            createdAt: current.created_at,
            problems: validateDraft({ recipientName: current.recipient_name, recipientEmail: current.recipient_email, subject: current.subject, body: current.body }),
          }
        : null,
      dispatches,
    });
  }
  void requestId;
  return views;
}

export function buildRequestView(db: Db, r: RequestRow): RequestView {
  const ex = storedExtraction(r);
  const risk = storedRisk(r);
  const items = all<ItemRow>(db, "SELECT * FROM checklist_items WHERE request_id = ? AND removed = 0 ORDER BY position", r.id);
  const run = latestRun(db, r.id);
  const runTask = run ? getTask(db, run.fo_task_id) : undefined;

  const itemViews: ItemView[] = items.map((i) => ({
    id: i.id,
    label: i.label,
    category: i.category,
    sourceQuote: i.source_quote,
    quoteFound: Boolean(i.quote_found),
    involvesOtherPerson: Boolean(i.involves_other_person),
    origin: i.origin,
    status: i.status,
    statusReason: i.status_reason,
    candidates: i.candidates_json ? JSON.parse(i.candidates_json) : [],
    searchable: i.category !== "credential",
  }));

  const taskIds = all<{ id: string; kind: "inventory" | "dispatch"; mode: "live" | "mock" }>(
    db,
    `SELECT t.id, t.kind, t.mode FROM fo_tasks t
       LEFT JOIN inventory_runs ir ON ir.fo_task_id = t.id
       LEFT JOIN dispatches d ON d.fo_task_id = t.id
       LEFT JOIN checklist_items ci ON ci.id = d.item_id
     WHERE ir.request_id = ? OR ci.request_id = ?`,
    r.id,
    r.id,
  );
  const taskMeta = new Map(taskIds.map((t) => [t.id, t]));
  const turns = taskIds.length
    ? all<FoTurnRow>(db, `SELECT * FROM fo_turns WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY id`, ...taskIds.map((t) => t.id))
    : [];

  return {
    id: r.id,
    createdAt: r.created_at,
    inputKind: r.input_kind,
    demoTitle: findDemo(r.demo_key)?.title ?? null,
    rawText: r.raw_text,
    trusted: { domain: r.trusted_domain, source: r.trusted_source },
    extraction: {
      status: r.extraction_status,
      mode: r.extraction_mode,
      error: r.extraction_error,
      requester: ex
        ? { name: ex.extraction.requester.name, email: ex.requesterEmail, domain: ex.requesterDomain, organization: ex.extraction.requester.organization }
        : null,
      deadline: ex?.extraction.deadline
        ? { text: ex.extraction.deadline.text, isoDate: ex.extraction.deadline.iso_date, sourceQuote: ex.extraction.deadline.source_quote, quoteFound: quoteFound(r.raw_text, ex.extraction.deadline.source_quote) }
        : null,
      payments: (ex?.extraction.payment_requests ?? []).map((p) => ({
        amountText: p.amount_text,
        method: p.method,
        purpose: p.purpose,
        sourceQuote: p.source_quote,
        quoteFound: quoteFound(r.raw_text, p.source_quote),
      })),
      links: (ex?.extraction.links ?? []).map((l) => ({ url: l.url, host: normalizeDomain(l.url) })),
      sensitive: ex?.extraction.sensitive_identifiers_requested.map((s) => ({ kind: s.kind, sourceQuote: s.source_quote })) ?? [],
      notes: ex?.notes ?? [],
    },
    checklistConfirmedAt: r.checklist_confirmed_at,
    items: itemViews,
    risk: risk ? { ...risk, reviewedAt: r.risk_reviewed_at, reviewNote: r.risk_review_note } : null,
    inventory:
      run && runTask
        ? { runId: run.id, createdAt: run.created_at, parseStatus: run.parse_status, parseNotes: run.parse_notes ? JSON.parse(run.parse_notes) : [], task: taskView(runTask) }
        : null,
    outreach: outreachFor(db, r.id, items),
    evidence: {
      turns: turns.map((t) => ({
        at: t.at,
        kind: taskMeta.get(t.task_id)!.kind,
        mode: taskMeta.get(t.task_id)!.mode,
        direction: t.direction,
        tool: t.tool,
        status: t.status,
        text: t.text,
      })),
      events: all<EventRow>(db, "SELECT * FROM events WHERE request_id = ? ORDER BY id", r.id).map((e) => ({ at: e.at, kind: e.kind, message: e.message })),
    },
  };
}

export function buildAppView(db: Db, modes: ModesView, requestId: string | null): AppView {
  const rows = all<RequestRow>(db, "SELECT * FROM requests ORDER BY created_at DESC, rowid DESC LIMIT 50");
  const requests: RequestSummary[] = rows.map((r) => ({ id: r.id, label: requestLabel(r), createdAt: r.created_at, inputKind: r.input_kind }));
  const currentRow = requestId ? rows.find((r) => r.id === requestId) ?? one<RequestRow>(db, "SELECT * FROM requests WHERE id = ?", requestId) : rows[0];
  const current = currentRow ? buildRequestView(db, currentRow) : null;
  return {
    modes,
    settings: { studentName: getStudentName(db) },
    requests,
    current,
    kiki: deriveKiki(current),
    demos: DEMO_REQUESTS.map((d) => ({ key: d.key, title: d.title, description: d.description })),
  };
}
