import { createHash, randomUUID } from "node:crypto";
import {
  all,
  logEvent,
  now,
  one,
  run,
  tx,
  type DispatchRow,
  type DocumentRow,
  type FileRow,
  type ObservedTurnRow,
  type OutcomeRow,
  type OutreachVersionRow,
  type WatchRow,
  type WorkspaceRow,
} from "../db.ts";
import { describeQuote } from "../domain/outreach.ts";
import { sourceLabel, type Outcome } from "../domain/outcome.ts";
import { buildConfirmCurrentPlan, buildVersionUpdatePlan } from "../domain/plan.ts";
import { diffQuotes, findRevisionCandidates, money, type Candidate, type VersionDoc } from "../domain/reconcile.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { ReadError } from "../extractor.ts";
import { insertTask } from "../fo/engine.ts";
import { buildFollowUpMessage } from "../domain/outreach.ts";
import { FoCallError, type FoTurn } from "../fo/types.ts";
import type { Ctx } from "./context.ts";
import { indexFiles, planDoc, planFiles, refreshOrganizeProposal, savePlanVersion } from "./plans.ts";
import { docFacts, runInventory, runReading } from "./workspace.ts";

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

export function turnKey(t: { role: string; text: string; at?: string | null; runId?: string }): string {
  if (t.runId) return `run:${t.runId}:${t.role}`;
  return createHash("sha256").update(`${t.role}\u0000${t.at ?? ""}\u0000${normalize(t.text)}`).digest("hex");
}

function getWatch(ctx: Ctx, id: string): WatchRow {
  const w = one<WatchRow>(ctx.db, "SELECT * FROM watches WHERE id = ?", id);
  if (!w) throw notFound("That conversation isn't being followed.");
  return w;
}

function getOutcome(ctx: Ctx, id: string): OutcomeRow {
  const o = one<OutcomeRow>(ctx.db, "SELECT * FROM outcomes WHERE id = ?", id);
  if (!o) throw notFound("That update doesn't exist.");
  return o;
}

function newOutcome(ctx: Ctx, watchId: string, turnId: number): string {
  const id = randomUUID();
  run(ctx.db, "INSERT OR IGNORE INTO outcomes (id, watch_id, turn_id, status, created_at, updated_at) VALUES (?, ?, ?, 'interpreting', ?, ?)", id, watchId, turnId, now(), now());
  return one<{ id: string }>(ctx.db, "SELECT id FROM outcomes WHERE turn_id = ?", turnId)!.id;
}

/**
 * Reads the mapped Fo conversation (read-only) and records turns Kiki hasn't seen. Repeated
 * polling can't create duplicates: each turn is stored once under its key, and only new turns
 * from Fo become outcomes to interpret. Kiki's own messages are context, not news.
 */
export async function checkWatch(ctx: Ctx, watchId: string): Promise<{ newTurns: number }> {
  const w = getWatch(ctx, watchId);
  if (w.state !== "watching") return { newTurns: 0 };
  let turns: FoTurn[];
  try {
    turns = await ctx.fo.getConversation(w.conversation_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pause = err instanceof FoCallError && err.kind === "not_connected";
    run(ctx.db, "UPDATE watches SET last_error = ?, state = CASE WHEN ? THEN 'paused' ELSE state END, last_checked_at = ? WHERE id = ?", message, pause ? 1 : 0, now(), w.id);
    return { newTurns: 0 };
  }
  const d = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE id = ?", w.dispatch_id)!;
  const known = new Set(all<{ text: string | null }>(ctx.db, "SELECT text FROM fo_turns WHERE task_id = ?", d.fo_task_id).map((r) => normalize(r.text ?? "")));
  const outcomeIds: string[] = [];
  tx(ctx.db, () => {
    for (const t of turns) {
      const baseline = t.role === "user" || known.has(normalize(t.text)) ? 1 : 0;
      const inserted = run(
        ctx.db,
        "INSERT OR IGNORE INTO observed_turns (watch_id, turn_key, role, text, at, source, baseline, observed_at) VALUES (?, ?, ?, ?, ?, 'fo_conversation', ?, ?)",
        w.id,
        turnKey(t),
        t.role,
        t.text,
        t.at ?? null,
        baseline,
        now(),
      );
      if (inserted && !baseline && t.role === "assistant") {
        const turn = one<ObservedTurnRow>(ctx.db, "SELECT * FROM observed_turns WHERE watch_id = ? AND turn_key = ?", w.id, turnKey(t))!;
        outcomeIds.push(newOutcome(ctx, w.id, turn.id));
      }
    }
    run(ctx.db, "UPDATE watches SET checks = checks + 1, last_checked_at = ?, last_error = NULL WHERE id = ?", now(), w.id);
    if (outcomeIds.length) logEvent(ctx.db, w.workspace_id, "fo_update", `Kiki picked up ${outcomeIds.length} new message${outcomeIds.length === 1 ? "" : "s"} from the Fo conversation.`);
  });
  for (const id of outcomeIds) ctx.jobs.enqueue("outcome", `outcome:${id}`, { outcomeId: id });
  return { newTurns: outcomeIds.length };
}

/** If the reply reached the user some other way, they can paste it. It's labelled as pasted. */
export function pasteReply(ctx: Ctx, watchId: string, text: string): string {
  const w = getWatch(ctx, watchId);
  const clean = (text ?? "").trim();
  if (!clean) throw badRequest("Paste the reply first.");
  if (clean.length > 4000) throw badRequest("That's too long.");
  const id = tx(ctx.db, () => {
    run(
      ctx.db,
      "INSERT OR IGNORE INTO observed_turns (watch_id, turn_key, role, text, at, source, baseline, observed_at) VALUES (?, ?, 'pasted', ?, NULL, 'pasted_by_user', 0, ?)",
      w.id,
      turnKey({ role: "pasted", text: clean }),
      clean,
      now(),
    );
    const turn = one<ObservedTurnRow>(ctx.db, "SELECT * FROM observed_turns WHERE watch_id = ? AND turn_key = ?", w.id, turnKey({ role: "pasted", text: clean }))!;
    logEvent(ctx.db, w.workspace_id, "pasted", "You pasted the contractor's reply into Kiki.");
    return newOutcome(ctx, w.id, turn.id);
  });
  ctx.jobs.enqueue("outcome", `outcome:${id}`, { outcomeId: id });
  return id;
}

interface OutcomeContextRows {
  o: OutcomeRow;
  turn: ObservedTurnRow;
  w: WatchRow;
  d: DispatchRow;
  v: OutreachVersionRow;
  asked: DocumentRow;
  ws: WorkspaceRow;
}

function load(ctx: Ctx, outcomeId: string): OutcomeContextRows {
  const o = getOutcome(ctx, outcomeId);
  const turn = one<ObservedTurnRow>(ctx.db, "SELECT * FROM observed_turns WHERE id = ?", o.turn_id)!;
  const w = getWatch(ctx, o.watch_id);
  const d = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE id = ?", w.dispatch_id)!;
  const v = one<OutreachVersionRow>(ctx.db, "SELECT * FROM outreach_versions WHERE id = ?", d.version_id)!;
  const asked = one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", d.document_id)!;
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", w.workspace_id)!;
  return { o, turn, w, d, v, asked, ws };
}

function setOutcome(ctx: Ctx, id: string, fields: { status: OutcomeRow["status"]; question?: string | null; candidates?: Candidate[] | null; chosen?: string | null; series?: string | null; error?: string | null }): void {
  run(
    ctx.db,
    "UPDATE outcomes SET status = ?, question = ?, candidates_json = ?, chosen_document_id = COALESCE(?, chosen_document_id), plan_series_id = COALESCE(?, plan_series_id), error = ?, updated_at = ? WHERE id = ?",
    fields.status,
    fields.question ?? null,
    fields.candidates ? JSON.stringify(fields.candidates) : null,
    fields.chosen ?? null,
    fields.series ?? null,
    fields.error ?? null,
    now(),
    id,
  );
}

/** Interprets one new turn and turns it into a reviewed proposal or a question for the user. */
export async function runOutcome(ctx: Ctx, outcomeId: string): Promise<void> {
  const rows = load(ctx, outcomeId);
  const { o, turn, v, asked } = rows;
  if (o.status !== "interpreting") return;
  let interp: Outcome;
  if (o.interpretation_json) interp = JSON.parse(o.interpretation_json) as Outcome;
  else {
    const facts = docFacts(asked);
    try {
      interp = await ctx.reader.interpret({
        contractorName: v.recipient_name,
        askedDocument: facts
          ? `${facts.issuer.value ?? "Contractor"} ${describeQuote({ issuer: facts.issuer.value, reference: facts.reference.value, date: facts.date.value, total: facts.total.value === null ? null : money(facts.total.value) })}`
          : "the quote",
        message: turn.text,
        source: turn.source,
      });
    } catch (err) {
      if (err instanceof ReadError) {
        setOutcome(ctx, o.id, { status: "failed", error: err.message });
        return;
      }
      throw err;
    }
    run(ctx.db, "UPDATE outcomes SET interpretation_json = ?, interpreter_mode = ?, updated_at = ? WHERE id = ?", JSON.stringify(interp), ctx.reader.mode, now(), o.id);
    if (interp.requests_to_ignore.length) {
      logEvent(ctx.db, rows.ws.id, "ignored", `The message also asked for things Kiki won't act on by herself: ${interp.requests_to_ignore.join("; ")}.`);
    }
  }

  if (interp.source_kind === "fo_question" || (interp.question_for_user && !interp.relevant)) {
    setOutcome(ctx, o.id, { status: "needs_clarification", question: interp.question_for_user ?? turn.text });
  } else if (!interp.relevant) {
    setOutcome(ctx, o.id, { status: "no_outcome" });
  } else if (interp.points_to_newer_version || interp.asked_document_is_final === "no") {
    await reconcileOutcome(ctx, o.id);
  } else if (interp.asked_document_is_final === "yes") {
    proposeConfirmCurrent(ctx, o.id, interp);
  } else {
    setOutcome(ctx, o.id, { status: "needs_clarification", question: "The message doesn't say clearly whether this is the final quote. You can ask Fo to check with the contractor." });
  }
}

function versionDocs(ctx: Ctx, wsId: string): VersionDoc[] {
  const files = new Map(all<FileRow>(ctx.db, "SELECT * FROM files WHERE workspace_id = ? AND present = 1", wsId).map((f) => [f.file_id, f]));
  return all<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE workspace_id = ? AND read_status = 'read' AND doc_type = 'quote'", wsId)
    .filter((d) => files.has(d.file_id))
    .map((d) => ({ docId: d.id, fileId: d.file_id, name: files.get(d.file_id)!.name, facts: docFacts(d)!, createdTime: files.get(d.file_id)!.created_time, versionStatus: d.version_status }));
}

/** Finds the revised quote in the workspace. One match: propose. None or several: ask. */
export async function reconcileOutcome(ctx: Ctx, outcomeId: string): Promise<void> {
  const { ws, d, asked, v } = load(ctx, outcomeId);
  // The revised quote may have just arrived: refresh what Kiki knows first (read-only).
  await runInventory(ctx, ws.id);
  await runReading(ctx, ws.id);
  const docs = versionDocs(ctx, ws.id);
  const askedDoc = docs.find((x) => x.docId === asked.id);
  if (!askedDoc) {
    setOutcome(ctx, outcomeId, { status: "needs_clarification", question: "The quote Fo asked about isn't in the workspace anymore, so Kiki can't link a revision to it." });
    return;
  }
  const candidates = findRevisionCandidates(askedDoc, docs, d.created_at);
  if (candidates.length === 1) {
    proposeVersionUpdate(ctx, outcomeId, candidates[0]!.docId, candidates);
  } else if (candidates.length === 0) {
    setOutcome(ctx, outcomeId, {
      status: "needs_clarification",
      question: `Kiki couldn't find the revised quote in the workspace yet. Fo mentioning it doesn't give Kiki access to it: save the attachment from ${v.recipient_name}'s email into the workspace folder, then press "Check again".`,
      candidates: [],
    });
  } else {
    setOutcome(ctx, outcomeId, {
      status: "needs_clarification",
      question: `${candidates.length} documents could be the revised quote. Which one did ${v.recipient_name} mean? Kiki won't guess.`,
      candidates,
    });
  }
}

function sourceOf(ctx: Ctx, outcomeId: string): { interp: Outcome; label: string; statement: string; turn: ObservedTurnRow } {
  const { o, turn } = load(ctx, outcomeId);
  const interp = JSON.parse(o.interpretation_json!) as Outcome;
  return { interp, turn, label: sourceLabel(interp, turn.source), statement: interp.verbatim_quote ?? interp.statement ?? turn.text };
}

export function proposeVersionUpdate(ctx: Ctx, outcomeId: string, chosenDocId: string, candidates: Candidate[]): void {
  const { ws, asked } = load(ctx, outcomeId);
  const chosen = one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", chosenDocId);
  if (!chosen?.facts_json || !asked.facts_json) throw conflict("Both quotes need to be read first.");
  const { interp, turn, label, statement } = sourceOf(ctx, outcomeId);
  const oldFacts = docFacts(asked)!;
  const newFacts = docFacts(chosen)!;
  const project = oldFacts.project.value ?? newFacts.project.value ?? "Renovation";
  const diff = diffQuotes(oldFacts, newFacts);
  const current = all<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE workspace_id = ? AND version_status = 'current' AND doc_type = 'quote'", ws.id).filter(
    (d) => d.id !== asked.id && d.id !== chosen.id && docFacts(d)?.issuer.value === oldFacts.issuer.value,
  );
  const evidence = {
    source: label,
    sourceKind: turn.source === "pasted_by_user" ? "pasted_by_user" : interp.source_kind,
    statement,
    interpreter: ctx.reader.mode,
    candidateReasons: candidates.find((c) => c.docId === chosenDocId)?.reasons ?? [],
    diff,
  };
  const draft = buildVersionUpdatePlan({
    rootId: ws.root_file_id,
    files: planFiles(ctx.db, ws.id),
    project,
    oldDoc: planDoc(asked),
    newDoc: planDoc(chosen),
    indexFile: indexFiles(ctx.db, ws.id)[project] ?? null,
    evidence,
    sourceLabel: label,
    statement,
  });
  const seriesId = `version:${outcomeId}`;
  savePlanVersion(ctx.db, ws, {
    kind: "version_update",
    seriesId,
    title: `Update the current ${project.toLowerCase()} quote`,
    summary: `File ${newFacts.reference.value ?? "the new quote"} as current and keep ${oldFacts.reference.value ?? "the old one"} as superseded.${diff.total?.delta ? ` The total changes by ${diff.total.delta > 0 ? "+" : ""}${money(diff.total.delta)}.` : ""}`,
    draft,
    details: {
      notes: draft.notes,
      diff,
      evidence,
      conflict: current.length ? `The index already lists another ${oldFacts.issuer.value ?? ""} quote as current; this would change that.` : null,
      oldDocumentId: asked.id,
      newDocumentId: chosen.id,
    },
    source: { outcomeId },
  });
  setOutcome(ctx, outcomeId, { status: "proposed", chosen: chosenDocId, series: seriesId, candidates });
  // The regular organizing pass may have proposed filing the same file; this update now owns it.
  refreshOrganizeProposal(ctx);
}

function proposeConfirmCurrent(ctx: Ctx, outcomeId: string, interp: Outcome): void {
  const { ws, asked } = load(ctx, outcomeId);
  const facts = docFacts(asked)!;
  const { label, statement } = sourceOf(ctx, outcomeId);
  const project = facts.project.value ?? "Renovation";
  const draft = buildConfirmCurrentPlan({
    rootId: ws.root_file_id,
    files: planFiles(ctx.db, ws.id),
    project,
    doc: planDoc(asked),
    indexFile: indexFiles(ctx.db, ws.id)[project] ?? null,
    evidence: { source: label, statement, interpreter: ctx.reader.mode, sourceKind: interp.source_kind },
    sourceLabel: label,
    statement,
  });
  const seriesId = `version:${outcomeId}`;
  savePlanVersion(ctx.db, ws, {
    kind: "version_update",
    seriesId,
    title: `Mark ${facts.reference.value ?? "the quote"} as the current ${project.toLowerCase()} quote`,
    summary: "The contractor says this quote is final. Recording it as current doesn't accept its price.",
    draft,
    details: { notes: [], evidence: { source: label, statement }, oldDocumentId: asked.id, newDocumentId: asked.id },
    source: { outcomeId },
  });
  setOutcome(ctx, outcomeId, { status: "proposed", chosen: asked.id, series: seriesId });
}

/** The user picks which candidate is the revised quote (or none of them). */
export function resolveOutcome(ctx: Ctx, outcomeId: string, documentId: string | null): void {
  const o = getOutcome(ctx, outcomeId);
  if (o.status !== "needs_clarification") throw conflict("This update doesn't need a choice right now.");
  const candidates = o.candidates_json ? (JSON.parse(o.candidates_json) as Candidate[]) : [];
  if (documentId === null) {
    setOutcome(ctx, outcomeId, {
      status: "needs_clarification",
      question: "Okay. Save the right file into the workspace folder, then press \"Check again\".",
      candidates: [],
    });
    logEvent(ctx.db, one<WatchRow>(ctx.db, "SELECT * FROM watches WHERE id = ?", o.watch_id)!.workspace_id, "clarified", "You said none of the candidates is the revised quote.");
    return;
  }
  if (!candidates.some((c) => c.docId === documentId)) throw badRequest("Choose one of the documents Kiki listed.");
  proposeVersionUpdate(ctx, outcomeId, documentId, candidates);
  logEvent(ctx.db, one<WatchRow>(ctx.db, "SELECT * FROM watches WHERE id = ?", o.watch_id)!.workspace_id, "clarified", "You chose which document is the revised quote. Kiki prepared the update for your approval.");
}

/** Looks for the revised quote again (for example, after the user saved the attachment). */
export function recheckOutcome(ctx: Ctx, outcomeId: string): void {
  const o = getOutcome(ctx, outcomeId);
  if (o.status !== "needs_clarification" && o.status !== "failed") throw conflict("Nothing to check again.");
  run(ctx.db, "UPDATE outcomes SET status = 'interpreting', error = NULL, updated_at = ? WHERE id = ?", now(), outcomeId);
  ctx.jobs.enqueue("outcome", `outcome:${outcomeId}`, { outcomeId });
}

export function dismissOutcome(ctx: Ctx, outcomeId: string): void {
  const o = getOutcome(ctx, outcomeId);
  if (o.status === "resolved") throw conflict("This update was already applied.");
  setOutcome(ctx, outcomeId, { status: "dismissed" });
}

/** Asks Fo something in the mapped conversation (never into a working turn). */
export async function followUp(ctx: Ctx, watchId: string, text: string): Promise<void> {
  const w = getWatch(ctx, watchId);
  const clean = (text ?? "").trim();
  if (!clean) throw badRequest("Write something for Fo.");
  if (clean.length > 2000) throw badRequest("That's too long.");
  const d = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE id = ?", w.dispatch_id)!;
  const taskId = insertTask(ctx.db, "followup", ctx.engine.mode);
  logEvent(ctx.db, w.workspace_id, "fo_followup", "You asked Fo a follow-up question in the same conversation.");
  await ctx.engine.startInConversation(taskId, w.conversation_id, buildFollowUpMessage(clean, d.reference));
  ctx.jobs.enqueue("watch", `watch:${w.id}`, { watchId: w.id }, 2);
}

export function setWatching(ctx: Ctx, watchId: string, watching: boolean): void {
  const w = getWatch(ctx, watchId);
  run(ctx.db, "UPDATE watches SET state = ?, last_error = NULL WHERE id = ?", watching ? "watching" : "closed", w.id);
  if (watching) ctx.jobs.enqueue("watch", `watch:${w.id}`, { watchId: w.id });
}

export async function watchJob(ctx: Ctx, watchId: string, intervalSeconds: number): Promise<{ rescheduleSeconds?: number } | void> {
  await checkWatch(ctx, watchId);
  const w = one<WatchRow>(ctx.db, "SELECT * FROM watches WHERE id = ?", watchId);
  return w?.state === "watching" ? { rescheduleSeconds: intervalSeconds } : undefined;
}
