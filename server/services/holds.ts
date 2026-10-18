import { all, kvGet, kvSet, one, type Db, type DispatchRow, type DocumentRow, type FileRow, type OutcomeRow, type WatchRow } from "../db.ts";
import type { Outcome } from "../domain/outcome.ts";
import { findRevisionCandidates, type Candidate, type VersionDoc } from "../domain/reconcile.ts";
import { docFacts } from "./workspace.ts";

/** Read quotes that are in the folder right now. */
export function versionDocs(db: Db, wsId: string): VersionDoc[] {
  const files = new Map(all<FileRow>(db, "SELECT * FROM files WHERE workspace_id = ? AND present = 1", wsId).map((f) => [f.file_id, f]));
  return all<DocumentRow>(db, "SELECT * FROM documents WHERE workspace_id = ? AND read_status = 'read' AND doc_type = 'quote'", wsId)
    .filter((d) => files.has(d.file_id))
    .map((d) => ({ docId: d.id, fileId: d.file_id, name: files.get(d.file_id)!.name, facts: docFacts(d)!, createdTime: files.get(d.file_id)!.created_time, versionStatus: d.version_status }));
}

const rejectedKey = (outcomeId: string) => `outcome.rejected.${outcomeId}`;

/** Documents the user said aren't the revised quote. Kiki doesn't offer them again. */
export function rejectedCandidates(db: Db, outcomeId: string): Set<string> {
  return new Set(JSON.parse(kvGet(db, rejectedKey(outcomeId)) ?? "[]") as string[]);
}

export function rejectCandidates(db: Db, outcomeId: string, docIds: string[]): void {
  kvSet(db, rejectedKey(outcomeId), JSON.stringify([...new Set([...rejectedCandidates(db, outcomeId), ...docIds])]));
}

/** The contractor's answer means a newer version of the quote exists (or the one asked about isn't final). */
export function expectsRevision(o: OutcomeRow): boolean {
  if (!o.interpretation_json) return false;
  const i = JSON.parse(o.interpretation_json) as Outcome;
  return i.relevant && (i.points_to_newer_version || i.asked_document_is_final === "no");
}

export function revisionCandidates(db: Db, o: OutcomeRow, docs: VersionDoc[] = versionDocs(db, workspaceOf(db, o))): Candidate[] {
  const w = one<WatchRow>(db, "SELECT * FROM watches WHERE id = ?", o.watch_id)!;
  const d = one<DispatchRow>(db, "SELECT * FROM dispatches WHERE id = ?", w.dispatch_id)!;
  const asked = docs.find((x) => x.docId === d.document_id);
  if (!asked) return [];
  const rejected = rejectedCandidates(db, o.id);
  return findRevisionCandidates(asked, docs, d.created_at).filter((c) => !rejected.has(c.docId));
}

function workspaceOf(db: Db, o: OutcomeRow): string {
  return one<WatchRow>(db, "SELECT * FROM watches WHERE id = ?", o.watch_id)!.workspace_id;
}

/** Updates Kiki is working on (or asking about) that are waiting for a revised quote. */
export function waitingForRevision(db: Db, wsId: string): { outcome: OutcomeRow; candidates: Candidate[] }[] {
  const open = all<OutcomeRow>(
    db,
    "SELECT o.* FROM outcomes o JOIN watches w ON w.id = o.watch_id WHERE w.workspace_id = ? AND o.status IN ('interpreting', 'needs_clarification')",
    wsId,
  ).filter(expectsRevision);
  if (!open.length) return [];
  const docs = versionDocs(db, wsId);
  return open.map((outcome) => ({ outcome, candidates: revisionCandidates(db, outcome, docs) }));
}

/**
 * While Kiki is following up on a quote, a quote that could be its revision is held for that
 * follow-up (filed as the current version, with the old one superseded) instead of being filed
 * as an ordinary new document.
 */
export function heldFileIds(db: Db, wsId: string): Set<string> {
  return new Set(waitingForRevision(db, wsId).flatMap((x) => x.candidates.map((c) => c.fileId)));
}
