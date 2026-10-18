import type {
  AppView,
  CandidateView,
  DispatchState,
  DispatchView,
  DocView,
  FileView,
  FoTaskView,
  IndexRowView,
  IntegrationsView,
  OpState,
  OpView,
  OutreachView,
  PlanView,
  ProjectIndexView,
  TurnView,
  UpdateView,
} from "../../shared/api.ts";
import {
  all,
  one,
  type DispatchRow,
  type DocumentRow,
  type EventRow,
  type FileRow,
  type FoTaskRow,
  type FoTurnRow,
  type InventoryRunRow,
  type ObservedTurnRow,
  type OutcomeRow,
  type OutreachVersionRow,
  type PlanOpRow,
  type PlanRow,
  type ProjectRow,
  type VersionEventRow,
  type WatchRow,
} from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { deriveKiki } from "../domain/kiki.ts";
import { sourceLabel, type Outcome } from "../domain/outcome.ts";
import { validateDraft } from "../domain/outreach.ts";
import { join } from "../domain/plan.ts";
import { money, type Candidate, type QuoteDiff } from "../domain/reconcile.ts";
import { getTask } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { projectIndexRows } from "./indexfile.ts";
import { getUserName, requestOf } from "./outreach.ts";
import { activeWorkspace, docFacts } from "./workspace.ts";
import { notifyOutcome, notifyPlanId, notifyPurpose, notifyText, replyState } from "./notify.ts";
import { foundAttachments } from "./attachments.ts";
import { attentionItems } from "./attention.ts";
import { lessonsView } from "./lessons.ts";
import { redact } from "../secrets.ts";

const STATUS_WORD: Record<string, string> = { current: "current", superseded: "superseded", unresolved: "not yet confirmed", proposed: "proposed" };

function fact(f: { value: unknown; quote: string | null; quoteFound: boolean | null } | undefined): { value: string | null; quote: string | null; quoteFound: boolean | null } {
  if (!f) return { value: null, quote: null, quoteFound: null };
  return { value: f.value === null || f.value === undefined ? null : String(f.value), quote: f.quote, quoteFound: f.quoteFound };
}

function docView(d: DocumentRow): DocView {
  const f = docFacts(d);
  return {
    docId: d.id,
    docType: d.doc_type,
    readStatus: d.read_status,
    readMode: d.read_mode,
    readError: d.read_error === null ? null : redact(d.read_error),
    issuer: fact(f?.issuer),
    reference: fact(f?.reference),
    date: fact(f?.date),
    total: f ? { value: f.total.value === null ? null : money(f.total.value, f.total.currency), quote: f.total.quote, quoteFound: f.total.quoteFound } : fact(undefined),
    project: f?.project.value ?? null,
    scope: f?.scope ?? null,
    revision: f?.revision.isRevision ? (f.revision.label ?? "Revision") : null,
    aiDirectedText: f?.aiDirectedText ?? [],
    textChecked: f?.textAvailable ?? false,
    versionStatus: d.version_status,
    acceptedAt: d.accepted_at,
  };
}

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
    default:
      return "uncertain";
  }
}

function opView(op: PlanOpRow, plan: PlanRow, docLabels: Map<string, string>): OpView {
  const docLabel = op.doc_id ? (docLabels.get(op.doc_id) ?? "this document") : "";
  let title: string;
  let before: OpView["before"] = null;
  let after: OpView["after"] = null;
  if (op.kind === "create_folder") {
    title = `Create the "${op.new_name}" folder`;
    after = { name: op.new_name ?? "", path: op.new_path ?? "" };
  } else if (op.kind === "move_rename") {
    const moved = op.pre_path !== op.new_path;
    const renamed = op.pre_name !== op.new_name;
    title = moved && renamed ? "Move and rename" : moved ? "Move" : "Rename";
    before = { name: op.pre_name ?? "", path: op.pre_path ?? "" };
    after = { name: op.new_name ?? "", path: op.new_path ?? "" };
  } else if (op.kind === "set_status") {
    title = `Mark ${docLabel} as ${STATUS_WORD[op.target_status ?? ""] ?? op.target_status}`;
    before = { name: STATUS_WORD[op.pre_status ?? "unresolved"] ?? "not yet confirmed", path: "Index" };
    after = { name: STATUS_WORD[op.target_status ?? ""] ?? String(op.target_status), path: "Index" };
  } else {
    title = op.file_id ? "Update the project index file" : "Create the project index file";
    after = { name: op.new_name ?? "", path: op.new_path ?? "" };
  }
  return { seq: op.seq, kind: op.kind, state: op.state, title, before, after, reason: op.reason, error: op.error, editable: plan.status === "proposed" && op.kind === "move_rename" };
}

const OP_STATES: OpState[] = ["pending", "running", "verified", "failed", "stale", "skipped", "uncertain", "excluded"];

export function buildAppView(ctx: Ctx, integrations: IntegrationsView): AppView {
  const { db } = ctx;
  const ws = activeWorkspace(db);
  const empty = { status: "never" as const, lastError: null, files: [] as FileView[], reading: 0 };
  if (!ws) {
    const base = {
      notifications: [],
      integrations,
      settings: { userName: getUserName(db) },
      lessons: [],
      workspace: null,
      inventory: empty,
      plans: [],
      index: [],
      attention: [],
      outreach: [],
      updates: [],
      activity: { events: all<EventRow>(db, "SELECT * FROM events WHERE workspace_id IS NULL ORDER BY id DESC LIMIT 50").map((e) => ({ at: e.at, kind: e.kind, message: e.message })), turns: [] },
      busy: { inventory: false, reading: false, executing: false, interpreting: false },
    };
    return { ...base, kiki: deriveKiki(base) };
  }

  const files = all<FileRow>(db, "SELECT * FROM files WHERE workspace_id = ? AND present = 1 ORDER BY path, is_folder DESC, name", ws.id);
  const docsByFile = new Map(all<DocumentRow>(db, "SELECT * FROM documents WHERE workspace_id = ?", ws.id).map((d) => [d.file_id, d]));
  const docsById = new Map([...docsByFile.values()].map((d) => [d.id, d]));
  const fileById = new Map(files.map((f) => [f.file_id, f]));
  const docLabel = (d: DocumentRow | undefined) => {
    if (!d) return "a document";
    const f = docFacts(d);
    const name = fileById.get(d.file_id)?.name;
    return f?.reference.value ? `${f.issuer.value ?? ""} ${f.reference.value}`.trim() : (name ?? "a document");
  };
  const docLabels = new Map([...docsById.values()].map((d) => [d.id, docLabel(d)]));
  const lastRun = one<InventoryRunRow>(db, "SELECT * FROM inventory_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1", ws.id);
  const jobsBusy = (prefix: string) => one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key LIKE ? AND state IN ('queued', 'running') AND run_after <= ?", `${prefix}%`, new Date(Date.now() + 2000).toISOString())!.n > 0;

  const fileViews: FileView[] = files.map((f) => {
    const d = docsByFile.get(f.file_id);
    return {
      fileId: f.file_id,
      name: f.name,
      path: f.path,
      kind: f.is_shortcut ? "shortcut" : f.is_folder ? "folder" : "file",
      origin: f.origin,
      link: f.web_link,
      doc: d && !f.is_folder && f.origin !== "created_by_kiki" ? docView(d) : null,
      isNew: f.origin !== "created_by_kiki" && Date.parse(f.first_seen_at) > Date.parse(ws.created_at) + 60_000 && Date.now() - Date.parse(f.first_seen_at) < 30 * 60_000,
    };
  });

  // Plans: the latest version of each series, and every earlier plan that changed something (so
  // its undo stays within reach after later filings).
  const plans = all<PlanRow>(
    db,
    `SELECT p.* FROM plans p WHERE p.workspace_id = ? AND (p.version = (SELECT MAX(version) FROM plans q WHERE q.series_id = p.series_id) OR p.status IN ('applied', 'partial', 'stale'))
     ORDER BY p.created_at DESC LIMIT 30`,
    ws.id,
  );
  const openUndo = new Set(all<{ s: string }>(db, "SELECT series_id AS s FROM plans WHERE kind = 'undo' AND status IN ('proposed', 'approved', 'executing', 'applied')").map((r) => r.s));
  const planViews: PlanView[] = plans.map((p) => {
    const ops = all<PlanOpRow>(db, "SELECT * FROM plan_ops WHERE plan_id = ? ORDER BY seq", p.id);
    const details = p.details_json ? (JSON.parse(p.details_json) as { notes?: PlanView["notes"]; diff?: QuoteDiff; evidence?: Record<string, unknown>; conflict?: string | null }) : {};
    const counts = Object.fromEntries(OP_STATES.map((s) => [s, ops.filter((o) => o.state === s).length])) as Record<OpState, number>;
    const undoable = p.kind !== "undo" && ["applied", "partial", "stale"].includes(p.status) && !openUndo.has(`undo:${p.id}`) && ops.some((o) => o.state === "verified" && (o.kind === "move_rename" || o.kind === "set_status"));
    const ev = details.evidence;
    return {
      id: p.id,
      version: p.version,
      kind: p.kind,
      status: p.status,
      title: p.title,
      summary: p.summary,
      contentHash: p.content_hash,
      createdAt: p.created_at,
      approvedAt: p.approved_at,
      finishedAt: p.finished_at,
      ops: ops.map((o) => opView(o, p, docLabels)),
      notes: (details.notes ?? []).map((n) => ({ fileId: n.fileId, name: n.name, path: n.path, status: n.status, reason: n.reason, unplaced: Boolean(n.unplaced), options: n.options ?? [] })),
      diff: details.diff ? { lines: details.diff.lines, total: details.diff.total ? { from: details.diff.total.from, to: details.diff.total.to, delta: details.diff.total.delta } : null } : null,
      evidence: ev
        ? {
            source: String(ev.source ?? ""),
            statement: String(ev.statement ?? ""),
            sourceKind: (ev.sourceKind as string | undefined) ?? null,
            interpreter: (ev.interpreter as "live" | "mock" | undefined) ?? null,
            candidateReasons: (ev.candidateReasons as string[] | undefined) ?? [],
          }
        : null,
      conflict: details.conflict ?? null,
      counts: { ...counts, total: ops.length },
      canUndo: undoable,
      canResume: ["partial", "failed"].includes(p.status) && ops.some((o) => ["failed", "skipped", "uncertain", "pending"].includes(o.state)),
    };
  });

  // A copy request for this reference already drafted or sent (and not given up on).
  const refKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const copyRequests = all<OutreachVersionRow>(db, "SELECT * FROM outreach_versions WHERE workspace_id = ? AND kind = 'request_copy' AND superseded_at IS NULL", ws.id);
  const copyAsked = (reference: string) => copyRequests.some((v) => refKey(requestOf(v)?.reference ?? "") === refKey(reference));

  // Index: per project, from verified locations and read facts.
  const openDispatchDocs = new Set(all<{ document_id: string }>(db, "SELECT document_id FROM dispatches WHERE open = 1").map((r) => r.document_id));
  const index: ProjectIndexView[] = all<ProjectRow>(db, "SELECT * FROM projects WHERE workspace_id = ? ORDER BY name", ws.id).flatMap((project) => {
    const rows: IndexRowView[] = projectIndexRows(db, project).map((r) => {
      const lastEvent = one<VersionEventRow>(db, "SELECT * FROM version_events WHERE document_id = ? ORDER BY id DESC LIMIT 1", r.doc.id);
      return {
        docId: r.doc.id,
        fileName: r.file.name,
        link: r.file.web_link,
        folder: r.file.path || "(workspace folder)",
        docType: r.facts.docType,
        issuer: r.facts.issuer.value,
        reference: r.facts.reference.value,
        date: r.facts.date.value,
        total: r.facts.total.value === null ? null : money(r.facts.total.value, r.facts.total.currency),
        status: r.doc.version_status,
        latestReceived: r.latestReceived,
        acceptedAt: r.doc.accepted_at,
        supersedes: r.doc.supersedes_id ? (docLabels.get(r.doc.supersedes_id) ?? null) : null,
        evidence: lastEvent?.detail ?? null,
        canAsk: r.facts.docType === "quote" && r.doc.version_status !== "superseded" && !openDispatchDocs.has(r.doc.id),
      };
    });
    // A spelling none of the documents carries any more: they were filed into its collection.
    if (rows.length === 0 && !project.index_file_id) return [];
    return [{ name: project.name, category: project.category, indexFileLink: project.index_file_id ? (fileById.get(project.index_file_id)?.web_link ?? null) : null, rows }];
  });

  // Outreach per quote.
  const outreachDocIds = all<{ document_id: string }>(db, "SELECT DISTINCT document_id FROM outreach_versions WHERE workspace_id = ?", ws.id).map((r) => r.document_id);
  const outreach: OutreachView[] = outreachDocIds.map((docId) => {
    const versions = all<OutreachVersionRow>(db, "SELECT * FROM outreach_versions WHERE document_id = ? ORDER BY version", docId);
    const current = versions.find((v) => !v.superseded_at) ?? null;
    const dispatches: DispatchView[] = all<DispatchRow>(db, "SELECT * FROM dispatches WHERE document_id = ? ORDER BY created_at, attempt", docId).map((d) => {
      const t = getTask(db, d.fo_task_id)!;
      const v = versions.find((x) => x.id === d.version_id)!;
      const w = one<WatchRow>(db, "SELECT * FROM watches WHERE dispatch_id = ?", d.id);
      return {
        id: d.id,
        attempt: d.attempt,
        version: v.version,
        state: dispatchState(d, t),
        open: Boolean(d.open),
        task: taskView(t),
        reference: d.reference,
        createdAt: d.created_at,
        recipientName: v.recipient_name,
        recipientEmail: v.recipient_email,
        subject: v.subject,
        body: v.body,
        reconciledAt: d.reconciled_at,
        reconcileNote: d.reconcile_note,
        retiredAt: d.retired_at,
        stopRequested: Boolean(d.stop_requested_at),
        watch: w ? { id: w.id, state: w.state, checks: w.checks, lastCheckedAt: w.last_checked_at, lastError: w.last_error } : null,
      };
    });
    const request = current ? requestOf(current) : versions.length ? requestOf(versions[versions.length - 1]!) : null;
    const who = (current ?? versions[versions.length - 1])?.recipient_name ?? "the contractor";
    return {
      documentId: docId,
      kind: request ? ("request_copy" as const) : ("ask_final" as const),
      title: request ? `Ask ${who} for a copy of ${request.docType === "other" ? "document" : request.docType} ${request.reference}` : `Ask about ${docLabel(docsById.get(docId))}`,
      quoteLabel: docLabel(docsById.get(docId)),
      draft: current
        ? {
            versionId: current.id,
            version: current.version,
            recipientName: current.recipient_name,
            recipientEmail: current.recipient_email,
            consentConfirmed: Boolean(current.consent_confirmed),
            purpose: current.purpose,
            subject: current.subject,
            body: current.body,
            contentHash: current.content_hash,
            createdAt: current.created_at,
            problems: validateDraft({ recipientName: current.recipient_name, recipientEmail: current.recipient_email, subject: current.subject, body: current.body }),
          }
        : null,
      dispatches,
    };
  });

  // Updates picked up from Fo conversations (or pasted in).
  const updates: UpdateView[] = all<OutcomeRow & { w_ws: string }>(
    db,
    "SELECT o.*, w.workspace_id AS w_ws FROM outcomes o JOIN watches w ON w.id = o.watch_id WHERE w.workspace_id = ? ORDER BY o.created_at DESC",
    ws.id,
  ).map((o) => {
    const turn = one<ObservedTurnRow>(db, "SELECT * FROM observed_turns WHERE id = ?", o.turn_id)!;
    const interp = o.interpretation_json ? (JSON.parse(o.interpretation_json) as Outcome) : null;
    const candidates: CandidateView[] = (o.candidates_json ? (JSON.parse(o.candidates_json) as Candidate[]) : []).map((c) => {
      const d = docsById.get(c.docId);
      const f: DocFacts | null = d ? docFacts(d) : null;
      return {
        docId: c.docId,
        name: fileById.get(c.fileId)?.name ?? c.name,
        link: fileById.get(c.fileId)?.web_link ?? null,
        reasons: c.reasons,
        reference: f?.reference.value ?? null,
        date: f?.date.value ?? null,
        total: f && f.total.value !== null ? money(f.total.value, f.total.currency) : null,
      };
    });
    const planId = o.plan_series_id ? (one<{ id: string }>(db, "SELECT id FROM plans WHERE series_id = ? ORDER BY version DESC LIMIT 1", o.plan_series_id)?.id ?? null) : null;
    return {
      id: o.id,
      watchId: o.watch_id,
      status: o.status,
      createdAt: o.created_at,
      source: turn.source,
      sourceLabel: interp ? sourceLabel(interp, turn.source) : turn.source === "pasted_by_user" ? "Reply you pasted in" : "A message from Fo",
      message: turn.text,
      statement: interp?.statement ?? null,
      quote: interp?.verbatim_quote ?? null,
      interpreter: o.interpreter_mode,
      question: o.question,
      candidates,
      planId,
      error: o.error,
      ignoredRequests: interp?.requests_to_ignore ?? [],
      emailAttachments: foundAttachments(ctx, o.id).map((a, index) => ({ index, filename: a.filename, from: a.from, subject: a.subject, date: a.date, saved: a.saved })),
    };
  });

  // Fo exchanges for this workspace's dispatches and follow-ups.
  const conversationIds = all<{ c: string }>(db, "SELECT conversation_id AS c FROM watches WHERE workspace_id = ?", ws.id).map((r) => r.c);
  const dispatchTaskIds = all<{ t: string }>(db, "SELECT d.fo_task_id AS t FROM dispatches d JOIN documents doc ON doc.id = d.document_id WHERE doc.workspace_id = ?", ws.id).map((r) => r.t);
  const followTaskIds = conversationIds.length
    ? all<{ id: string }>(db, `SELECT id FROM fo_tasks WHERE kind = 'followup' AND conversation_id IN (${conversationIds.map(() => "?").join(",")})`, ...conversationIds).map((r) => r.id)
    : [];
  const taskIds = [...dispatchTaskIds, ...followTaskIds];
  const tasks = new Map(taskIds.map((id) => [id, getTask(db, id)!]));
  const turns: TurnView[] = taskIds.length
    ? all<FoTurnRow>(db, `SELECT * FROM fo_turns WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY id`, ...taskIds).map((t) => ({
        at: t.at,
        kind: tasks.get(t.task_id)!.kind,
        mode: tasks.get(t.task_id)!.mode,
        direction: t.direction,
        tool: t.tool,
        status: t.status,
        text: t.text,
      }))
    : [];

  // Only this workspace's notes, in the current Fo mode (a mock rehearsal's notes don't show here).
  const notifications = all<FoTaskRow>(db, "SELECT * FROM fo_tasks WHERE kind = 'notify' AND mode = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 10", integrations.fo.mode, ws.created_at).map((t) => ({
    taskId: t.id,
    purpose: notifyPurpose(ctx, t.id),
    planId: notifyPlanId(ctx, t.id),
    reply: (() => {
      const r = replyState(ctx, t.id);
      if (!r) return null;
      // Waiting on a proposal that has since changed (you edited it, or it was applied): the answer
      // would be refused, so it isn't shown as waiting for you, even before Kiki's next check.
      const plan = r.status === "waiting" ? one<PlanRow>(db, "SELECT status, content_hash FROM plans WHERE id = ?", r.planId) : null;
      const status = r.status === "waiting" && (!plan || plan.status !== "proposed" || plan.content_hash !== r.contentHash) ? ("stale" as const) : r.status;
      return { status, text: r.text, source: r.source, ...(r.clarification ? { clarification: r.clarification } : {}), ...(r.revision ? { revision: r.revision } : {}) };
    })(),
    mode: t.mode,
    state: t.state,
    outcome: t.state === "complete" ? notifyOutcome(t.final_response) : null,
    text: notifyText(ctx, t.id),
    progress: t.progress,
    question: t.question,
    failureDetail: t.failure_detail,
    finalResponse: t.final_response,
    pollPaused: Boolean(t.poll_paused),
    pollError: t.poll_error,
    createdAt: t.created_at,
  }));
  const base: Omit<AppView, "kiki"> = {
    notifications,
    integrations,
    settings: { userName: getUserName(db) },
    lessons: lessonsView(db, ws.id),
    workspace: {
      name: ws.name,
      origin: ws.origin,
      mode: ws.mode,
      link: ws.mode === "live" ? `https://drive.google.com/drive/folders/${ws.root_file_id}` : null,
      lastInventoryAt: ws.last_inventory_at,
    },
    inventory: {
      status: lastRun ? lastRun.status : "never",
      lastError: lastRun?.error ?? null,
      files: fileViews,
      reading: [...docsByFile.values()].filter((d) => (d.read_status === "pending" || d.read_status === "reading") && fileById.has(d.file_id)).length,
    },
    plans: planViews,
    index,
    attention: attentionItems(ctx, ws.id).map((i) => ({
      key: i.key,
      kind: i.kind,
      project: i.project,
      title: i.title,
      detail: i.detail,
      evidence: i.evidence,
      // Offer "ask" only where the index would (a quote not already being asked about).
      askDocId: i.askDocId && index.some((p) => p.rows.some((r) => r.docId === i.askDocId && r.canAsk)) ? i.askDocId : null,
      copy: i.request ? { documentId: i.request.documentId, reference: i.request.reference, issuer: i.request.issuer, asked: copyAsked(i.request.reference) } : null,
    })),
    outreach,
    updates,
    activity: {
      events: all<EventRow>(db, "SELECT * FROM events WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY id DESC LIMIT 200", ws.id).map((e) => ({ at: e.at, kind: e.kind, message: e.message })),
      turns,
    },
    busy: {
      inventory: jobsBusy(`inventory:${ws.id}`),
      reading: jobsBusy(`read:${ws.id}`),
      executing: jobsBusy("execute:"),
      interpreting: jobsBusy("outcome:"),
    },
  };
  void join;
  return { ...base, kiki: deriveKiki(base) };
}
