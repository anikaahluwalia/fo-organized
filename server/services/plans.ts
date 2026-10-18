import { randomUUID } from "node:crypto";
import {
  all,
  isUniqueViolation,
  logEvent,
  now,
  one,
  run,
  tx,
  type ChangeLogRow,
  type Db,
  type DocumentRow,
  type FileRow,
  type PlanKind,
  type PlanOpRow,
  type PlanRow,
  type ProjectRow,
  type WorkspaceRow,
} from "../db.ts";
import { sanitizeName } from "../domain/naming.ts";
import { buildOrganizePlan, buildUndoPlan, parseRef, planHash, refKey, type PlanDoc, type PlanDraft, type PlanFile, type PlannedOp, type UndoSource } from "../domain/plan.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { Ctx } from "./context.ts";
import { docFacts, requireWorkspace } from "./workspace.ts";
import { heldFileIds } from "./holds.ts";
import { inDuplicatesFolder } from "../domain/duplicates.ts";

export function getPlan(db: Db, id: string): PlanRow {
  const plan = one<PlanRow>(db, "SELECT * FROM plans WHERE id = ?", id);
  if (!plan) throw notFound("That plan doesn't exist.");
  return plan;
}

export function planOps(db: Db, planId: string): PlanOpRow[] {
  return all<PlanOpRow>(db, "SELECT * FROM plan_ops WHERE plan_id = ? ORDER BY seq", planId);
}

export function planFiles(db: Db, wsId: string): PlanFile[] {
  return all<FileRow>(db, "SELECT * FROM files WHERE workspace_id = ? AND present = 1", wsId).map((f) => ({
    fileId: f.file_id,
    name: f.name,
    mimeType: f.mime_type,
    parentId: f.parent_id,
    path: f.path,
    version: f.version,
    size: f.size,
    createdTime: f.created_time,
    isFolder: Boolean(f.is_folder),
    isShortcut: Boolean(f.is_shortcut),
    canRename: Boolean(f.can_rename),
    canMove: Boolean(f.can_move),
  }));
}

export function planDoc(d: DocumentRow): PlanDoc {
  return { docId: d.id, fileId: d.file_id, facts: docFacts(d), readStatus: d.read_status, readError: d.read_error, versionStatus: d.version_status, acceptedAt: d.accepted_at };
}

export function indexFiles(db: Db, wsId: string): Record<string, { fileId: string; version: string | null } | null> {
  const out: Record<string, { fileId: string; version: string | null } | null> = {};
  for (const p of all<ProjectRow>(db, "SELECT * FROM projects WHERE workspace_id = ?", wsId)) {
    const present = p.index_file_id ? one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM files WHERE workspace_id = ? AND file_id = ? AND present = 1", wsId, p.index_file_id)!.n : 0;
    out[p.name] = p.index_file_id && present ? { fileId: p.index_file_id, version: p.index_file_version } : null;
  }
  return out;
}

function insertOps(db: Db, planId: string, ops: PlannedOp[], excluded: Set<number> = new Set()): void {
  for (const o of ops) {
    run(
      db,
      `INSERT INTO plan_ops (id, plan_id, seq, kind, file_id, doc_id, folder_path, parent_ref, new_name, pre_name, pre_parent_id, pre_version, pre_path, new_path,
                             pre_status, target_status, target_supersedes_id, reason, evidence_json, depends_on, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      planId,
      o.seq,
      o.kind,
      o.fileId,
      o.docId,
      o.folderPath,
      refKey(o.parentRef),
      o.newName,
      o.pre?.name ?? null,
      o.pre?.parentId ?? null,
      o.pre?.version ?? null,
      o.pre?.path ?? null,
      o.newPath,
      o.preStatus,
      o.targetStatus,
      o.targetSupersedesId,
      o.reason,
      o.evidence === null || o.evidence === undefined ? null : JSON.stringify(o.evidence),
      JSON.stringify(o.dependsOn),
      excluded.has(o.seq) ? "excluded" : "pending",
    );
  }
}

/** Ops as stored, turned back into the planner's shape (used for revisions and hashing). */
export function toPlanned(rows: PlanOpRow[]): PlannedOp[] {
  return rows.map((r) => ({
    seq: r.seq,
    kind: r.kind,
    fileId: r.file_id,
    docId: r.doc_id,
    folderPath: r.folder_path,
    parentRef: parseRef(r.parent_ref),
    newName: r.new_name,
    pre: r.pre_name !== null || r.pre_parent_id !== null || r.pre_version !== null ? { name: r.pre_name ?? "", parentId: r.pre_parent_id, version: r.pre_version, path: r.pre_path ?? "" } : null,
    newPath: r.new_path,
    preStatus: r.pre_status,
    targetStatus: r.target_status,
    targetSupersedesId: r.target_supersedes_id,
    reason: r.reason,
    evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
    dependsOn: JSON.parse(r.depends_on ?? "[]") as number[],
  }));
}

function hashWithExclusions(ops: PlannedOp[], excluded: Set<number>): string {
  return planHash(ops.map((o) => (excluded.has(o.seq) ? { ...o, kind: o.kind, reason: "excluded", newName: `excluded:${o.newName}` } : o)));
}

/**
 * Stores a proposal. If an open proposal in the same series has exactly the same operations, it
 * is returned unchanged: replaying the same input creates nothing new. Otherwise the open
 * proposal is superseded (its approval, if any, no longer applies) and a new version is added.
 */
export function savePlanVersion(
  db: Db,
  ws: WorkspaceRow,
  input: { kind: PlanKind; seriesId: string; title: string; summary: string; draft: PlanDraft; details: unknown; source: unknown; excluded?: Set<number> },
): { plan: PlanRow; created: boolean } {
  const excluded = input.excluded ?? new Set<number>();
  const hash = hashWithExclusions(input.draft.ops, excluded);
  return tx(db, () => {
    const open = one<PlanRow>(db, "SELECT * FROM plans WHERE series_id = ? AND status IN ('proposed', 'approved', 'executing')", input.seriesId);
    if (open && open.content_hash === hash) return { plan: open, created: false };
    if (open && open.status !== "proposed") throw conflict("This plan is already approved or running. Wait for it to finish.");
    if (open) run(db, "UPDATE plans SET status = 'superseded', finished_at = ? WHERE id = ?", now(), open.id);
    const version = (one<{ v: number | null }>(db, "SELECT MAX(version) AS v FROM plans WHERE series_id = ?", input.seriesId)?.v ?? 0) + 1;
    const id = randomUUID();
    run(
      db,
      `INSERT INTO plans (id, workspace_id, series_id, version, kind, status, title, summary, content_hash, details_json, source_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`,
      id,
      ws.id,
      input.seriesId,
      version,
      input.kind,
      input.title,
      input.summary,
      hash,
      JSON.stringify(input.details ?? null),
      JSON.stringify(input.source ?? null),
      now(),
    );
    insertOps(db, id, input.draft.ops, excluded);
    logEvent(db, ws.id, "plan", `Kiki proposed "${input.title}" (version ${version}). Nothing changes in Drive until you approve it.`);
    return { plan: one<PlanRow>(db, "SELECT * FROM plans WHERE id = ?", id)!, created: true };
  });
}

function countBy(ops: PlannedOp[], kind: string): number {
  return ops.filter((o) => o.kind === kind).length;
}

function pendingReads(db: Db, wsId: string): number {
  return one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM documents d JOIN files f ON f.workspace_id = d.workspace_id AND f.file_id = d.file_id
     WHERE d.workspace_id = ? AND d.read_status IN ('pending', 'reading') AND f.present = 1`,
    wsId,
  )!.n;
}

function organizeDraft(db: Db, ws: WorkspaceRow, places: Map<string, string> = new Map()): PlanDraft {
  // So are quotes that could be the revision Kiki is following up on.
  const held = heldFileIds(db, ws.id);
  // Files a pending quote update will move are that plan's business, not this one's.
  const reserved = new Set(
    all<{ file_id: string }>(
      db,
      "SELECT o.file_id FROM plan_ops o JOIN plans p ON p.id = o.plan_id WHERE p.workspace_id = ? AND p.kind = 'version_update' AND p.status IN ('proposed', 'approved', 'executing') AND o.file_id IS NOT NULL",
      ws.id,
    ).map((r) => r.file_id),
  );
  // A filing the user undid isn't proposed again unless the file has changed since.
  const files = planFiles(db, ws.id);
  const version = new Map(files.map((f) => [f.fileId, f.version]));
  const undone = new Set(
    all<{ file_id: string; result_json: string | null }>(
      db,
      "SELECT o.file_id, o.result_json FROM plan_ops o JOIN plans p ON p.id = o.plan_id WHERE p.workspace_id = ? AND p.kind = 'undo' AND o.kind = 'move_rename' AND o.state = 'verified'",
      ws.id,
    )
      .filter((r) => r.result_json && (JSON.parse(r.result_json) as { version?: string }).version === version.get(r.file_id))
      .map((r) => r.file_id),
  );
  const docs = all<DocumentRow>(db, "SELECT * FROM documents WHERE workspace_id = ?", ws.id)
    .filter((d) => !reserved.has(d.file_id) && !held.has(d.file_id))
    .map(planDoc);
  return buildOrganizePlan({ rootId: ws.root_file_id, files, docs, indexFiles: indexFiles(db, ws.id), undone, places });
}

/** What an organizing plan would do, counting only the steps that will run. */
function organizeSummary(ops: PlannedOp[], excluded: Set<number>): { moves: number; copies: number; summary: string } {
  const live = ops.filter((o) => !excluded.has(o.seq));
  const folders = countBy(live, "create_folder");
  const copies = live.filter((o) => o.kind === "move_rename" && o.newPath !== null && inDuplicatesFolder(o.newPath)).length;
  const moves = countBy(live, "move_rename") - copies;
  const parts = [
    folders ? `create ${folders} folder${folders === 1 ? "" : "s"}` : null,
    moves ? `move or rename ${moves} file${moves === 1 ? "" : "s"}` : null,
    copies ? `set aside ${copies} exact cop${copies === 1 ? "y" : "ies"}` : null,
    countBy(live, "write_index") ? "update the project index" : null,
  ].filter(Boolean);
  return { moves, copies, summary: parts.length ? `Kiki would ${parts.join(", ")}.` : "Kiki would change nothing." };
}

/** What an organizing plan does, for any kind of workspace. */
function organizeTitle(workspace: string, first: boolean, moves: number, copies: number): string {
  if (first) return `Organize "${workspace}"`;
  if (moves > 0) return moves === 1 ? "File the new document" : "File the new documents";
  if (copies > 0) return `Set aside ${copies === 1 ? "a duplicate copy" : "duplicate copies"}`;
  return "Update the index";
}

/** Edits the user made to a proposal, by file, so a fresh version of it keeps them. */
export type Edits = Record<string, { newName?: string; exclude?: boolean; keepName?: boolean; place?: string }>;

/** A name the user typed keeps the file's extension when they leave it off. */
function withExtension(typed: string, current: string | null): string {
  const ext = /\.[A-Za-z0-9]{2,5}$/.exec(current ?? "")?.[0];
  return ext && !typed.toLowerCase().endsWith(ext.toLowerCase()) ? `${typed}${ext}` : typed;
}

/** A folder or index that only served skipped moves is skipped too: nothing would go there. */
function settleExclusions(ops: PlannedOp[], excluded: Set<number>): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of ops) {
      if (excluded.has(o.seq) || (o.kind !== "create_folder" && o.kind !== "write_index")) continue;
      const users = o.kind === "create_folder" ? ops.filter((d) => d.dependsOn.includes(o.seq)) : ops.filter((d) => o.dependsOn.includes(d.seq) && d.kind === "move_rename");
      if (users.length > 0 && users.every((d) => excluded.has(d.seq))) (excluded.add(o.seq), (grew = true));
    }
  }
}

/** Re-checks an open organizing proposal against the current state: withdraw it if nothing is left to do. */
export function refreshOrganizeProposal(ctx: Ctx): void {
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE active = 1");
  if (!ws) return;
  const open = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE series_id = ? AND status = 'proposed'", `organize:${ws.id}`);
  if (!open) return;
  const draft = organizeDraft(ctx.db, ws);
  if (!draft.ops.some((o) => o.kind === "move_rename")) {
    run(ctx.db, "UPDATE plans SET status = 'superseded', finished_at = ? WHERE id = ?", now(), open.id);
    logEvent(ctx.db, ws.id, "plan", `Kiki withdrew "${open.title}": there's nothing left in it to do.`);
    return;
  }
  saveOrganize(ctx.db, ws, draft);
}

/**
 * Saves Kiki's draft as the organizing proposal, with the user's edits on it: the ones already on
 * the open proposal, plus any just asked for. Kiki's draft is the one without edits; when it hasn't
 * changed since the user's edits and nothing new is asked, their version stays as it is.
 */
function saveOrganize(db: Db, ws: WorkspaceRow, kikiDraft: PlanDraft, requested?: Edits): { plan: PlanRow; created: boolean } {
  const seriesId = `organize:${ws.id}`;
  // You edited the proposal and nothing in the folder changed since: keep your version.
  const open = one<PlanRow>(db, "SELECT * FROM plans WHERE series_id = ? AND status = 'proposed'", seriesId);
  const openDetails = open?.details_json ? (JSON.parse(open.details_json) as { revisedFrom?: string; edits?: Edits } | null) : null;
  const kikiHash = hashWithExclusions(kikiDraft.ops, new Set());
  if (!requested && open && openDetails?.revisedFrom === kikiHash) return { plan: open, created: false };
  // Kiki's draft, with your edits carried over to the files they were about.
  const edits: Edits = { ...(openDetails?.edits ?? {}) };
  for (const [fileId, e] of Object.entries(requested ?? {})) edits[fileId] = { ...edits[fileId], ...e };
  const places = new Map(Object.entries(edits).flatMap(([fileId, e]) => (e.place ? [[fileId, e.place] as [string, string]] : [])));
  const draft = places.size ? organizeDraft(db, ws, places) : kikiDraft;
  const excluded = new Set<number>();
  for (const op of draft.ops) {
    const e = op.kind === "move_rename" && op.fileId ? edits[op.fileId] : undefined;
    if (!e) continue;
    if (e.keepName && op.pre && !e.newName) {
      op.newName = op.pre.name;
      op.reason = `${op.reason} You chose to keep its name.`;
    }
    if (e.newName) {
      op.newName = withExtension(e.newName, op.newName);
      op.reason = `${op.reason} You chose this name.`;
    }
    if (e.exclude) excluded.add(op.seq);
  }
  settleExclusions(draft.ops, excluded);
  const edited = Object.keys(edits).some((fileId) => draft.ops.some((o) => o.fileId === fileId));
  const before = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM plans WHERE series_id = ? AND status = 'applied'", seriesId)!.n;
  const { moves, copies, summary } = organizeSummary(draft.ops, excluded);
  return savePlanVersion(db, ws, {
    kind: "organize",
    seriesId,
    title: organizeTitle(ws.name, before === 0, moves, copies),
    summary,
    draft,
    details: { notes: draft.notes, ...(edited ? { edits, revisedFrom: kikiHash } : {}) },
    source: null,
    excluded,
  });
}

/**
 * Changes the open organizing proposal the way the user asked (through Fo, in their own words):
 * the result is a new version that needs its own decision. Returns it, and whether anything changed.
 */
export function adjustOrganize(ctx: Ctx, planId: string, changes: Edits): { planId: string; changed: boolean } {
  const plan = getPlan(ctx.db, planId);
  if (plan.kind !== "organize" || plan.status !== "proposed") throw conflict("Only an open organizing proposal can be changed this way.", "stale_plan");
  const ws = requireWorkspace(ctx.db);
  if (plan.workspace_id !== ws.id) throw conflict("That proposal belongs to a folder Kiki isn't working on now.", "stale_plan");
  const { plan: next, created } = saveOrganize(ctx.db, ws, organizeDraft(ctx.db, ws), changes);
  return { planId: next.id, changed: created };
}

/** Proposes the organizing changes the latest inventory calls for. Read-only until approved. */
export function proposeOrganize(ctx: Ctx): { planId: string | null; created: boolean; message: string } {
  const ws = requireWorkspace(ctx.db);
  if (!ws.last_inventory_at) throw conflict("Kiki hasn't looked through the workspace yet.");
  if (pendingReads(ctx.db, ws.id) > 0) throw conflict("Kiki is still reading some documents. Try again in a moment.");
  const draft = organizeDraft(ctx.db, ws);
  const seriesId = `organize:${ws.id}`;
  if (draft.ops.length === 0) {
    const open = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE series_id = ? AND status = 'proposed'", seriesId);
    if (open) run(ctx.db, "UPDATE plans SET status = 'superseded', finished_at = ? WHERE id = ?", now(), open.id);
    logEvent(ctx.db, ws.id, "plan", "Kiki checked the workspace: everything she can place is already organized.");
    return { planId: null, created: false, message: "Everything Kiki can place is already organized. Nothing to change." };
  }
  const { plan, created } = saveOrganize(ctx.db, ws, draft);
  return { planId: plan.id, created, message: created ? "Kiki proposed a plan." : "This plan is unchanged from the one already proposed." };
}

/**
 * Called after Kiki reads new documents: if something now needs filing, she prepares the
 * proposal herself. It still changes nothing until approved, and a proposal the user set aside
 * isn't re-proposed unless something changes.
 */
export function autoPropose(ctx: Ctx): { plan: PlanRow; created: boolean } | null {
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE active = 1");
  if (!ws?.last_inventory_at || pendingReads(ctx.db, ws.id) > 0) return null;
  const seriesId = `organize:${ws.id}`;
  if (one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE series_id = ? AND status IN ('approved', 'executing')", seriesId)) return null;
  const draft = organizeDraft(ctx.db, ws);
  if (!draft.ops.some((o) => o.kind === "move_rename")) {
    refreshOrganizeProposal(ctx);
    return null;
  }
  const hash = hashWithExclusions(draft.ops, new Set());
  // Don't re-propose something the user set aside, or that already failed: they choose to retry.
  if (one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE series_id = ? AND status IN ('discarded', 'failed', 'partial', 'stale') AND content_hash = ?", seriesId, hash)) return null;
  // (What the user undid is already left out of the draft, file by file.)
  return saveOrganize(ctx.db, ws, draft);
}

/** Rename or exclude steps. The result is a new version; any approval of the old one no longer applies. */
export function revisePlan(ctx: Ctx, planId: string, edits: { seq: number; newName?: string; exclude?: boolean }[]): string {
  const plan = getPlan(ctx.db, planId);
  if (plan.status !== "proposed") throw conflict("Only a proposed plan can be changed.", "stale_plan");
  const ws = requireWorkspace(ctx.db);
  const rows = planOps(ctx.db, planId);
  const ops = toPlanned(rows);
  const excluded = new Set(rows.filter((r) => r.state === "excluded").map((r) => r.seq));
  for (const edit of edits) {
    const op = ops.find((o) => o.seq === edit.seq);
    if (!op) throw badRequest("That step isn't in this plan.");
    if (edit.exclude === true) excluded.add(op.seq);
    if (edit.exclude === false) excluded.delete(op.seq);
    if (edit.newName !== undefined) {
      if (op.kind !== "move_rename") throw badRequest("Only file names can be edited.");
      const name = sanitizeName(edit.newName);
      if (!name) throw badRequest("The name can't be empty.");
      const ext = /\.[A-Za-z0-9]{2,5}$/.exec(op.newName ?? "")?.[0];
      op.newName = ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? `${name}${ext}` : name;
      op.reason = `${op.reason} You chose this name.`;
    }
  }
  // Excluding a folder excludes everything that depends on it. The index only waits for the
  // moves (it lists what's verified), so it goes only with the folder it's written in.
  const structural = (o: PlannedOp) => (o.kind === "write_index" ? o.dependsOn.filter((d) => o.parentRef !== null && "op" in o.parentRef && o.parentRef.op === d) : o.dependsOn);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of ops) if (!excluded.has(o.seq) && structural(o).some((d) => excluded.has(d))) (excluded.add(o.seq), (grew = true));
  }
  // A name you typed can't land on a name already used in that folder.
  const edited = new Set(edits.filter((e) => e.newName !== undefined).map((e) => e.seq));
  if (edited.size) {
    const moves = ops.filter((o) => o.kind === "move_rename" && !excluded.has(o.seq));
    const moving = new Set(moves.map((o) => o.fileId));
    const key = (path: string | null, name: string | null) => `${path ?? ""}/${(name ?? "").toLowerCase()}`;
    const staying = new Set(planFiles(ctx.db, ws.id).filter((f) => !moving.has(f.fileId)).map((f) => key(f.path, f.name)));
    for (const op of moves.filter((o) => edited.has(o.seq))) {
      const k = key(op.newPath, op.newName);
      if (staying.has(k) || moves.some((o) => o !== op && key(o.newPath, o.newName) === k)) {
        throw badRequest(`"${op.newName}" is already used in ${op.newPath || "the top level"}. Choose another name.`);
      }
    }
  }
  const prior = plan.details_json ? JSON.parse(plan.details_json) : null;
  // Remember which of Kiki's drafts this edit started from, so her next look doesn't undo it, and
  // the edits themselves by file, so a fresh draft after a real change keeps them.
  const byFile: Edits = { ...(prior?.edits ?? {}) };
  for (const edit of edits) {
    const op = ops.find((o) => o.seq === edit.seq);
    if (!op?.fileId || op.kind !== "move_rename") continue;
    byFile[op.fileId] = { ...byFile[op.fileId], ...(edit.newName !== undefined ? { newName: op.newName ?? undefined } : {}), ...(edit.exclude !== undefined ? { exclude: edit.exclude } : {}) };
  }
  const details = plan.kind === "organize" ? { ...(prior ?? {}), edits: byFile, revisedFrom: prior?.revisedFrom ?? plan.content_hash } : prior;
  const { plan: next } = savePlanVersion(ctx.db, ws, {
    kind: plan.kind,
    seriesId: plan.series_id,
    title: plan.title,
    summary: plan.kind === "organize" ? organizeSummary(ops, excluded).summary : plan.summary,
    draft: { ops, notes: details?.notes ?? [] },
    details,
    source: plan.source_json ? JSON.parse(plan.source_json) : null,
    excluded,
  });
  return next.id;
}

/**
 * Approval binds to one plan version and its hash. Repeated clicks resolve to the same approval;
 * an approval of a superseded version is refused.
 */
export function approvePlan(ctx: Ctx, planId: string, input: { contentHash?: string; clientRequestId?: string }): { planId: string; created: boolean } {
  const clientRequestId = input.clientRequestId ?? "";
  if (!clientRequestId || clientRequestId.length > 100) throw badRequest("Missing request id.");
  const result = (() => {
    try {
      return tx(ctx.db, () => {
        const same = one<{ plan_id: string }>(ctx.db, "SELECT plan_id FROM plan_approvals WHERE client_request_id = ?", clientRequestId);
        if (same) return { planId: same.plan_id, created: false };
        const plan = getPlan(ctx.db, planId);
        const existing = one<{ id: string }>(ctx.db, "SELECT id FROM plan_approvals WHERE plan_id = ?", planId);
        if (existing) return { planId, created: false };
        if (plan.status !== "proposed") throw conflict("This plan changed after you reviewed it. Review the latest version.", "stale_plan");
        if (input.contentHash !== plan.content_hash) throw conflict("What you approved doesn't match the saved plan. Review it again.", "hash_mismatch");
        const runnable = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM plan_ops WHERE plan_id = ? AND state <> 'excluded'", planId)!.n;
        if (runnable === 0) throw badRequest("Every step is excluded, so there's nothing to approve.");
        run(ctx.db, "INSERT INTO plan_approvals (id, plan_id, content_hash, client_request_id, approved_at) VALUES (?, ?, ?, ?, ?)", randomUUID(), planId, plan.content_hash, clientRequestId, now());
        run(ctx.db, "UPDATE plans SET status = 'approved', approved_at = ? WHERE id = ?", now(), planId);
        logEvent(ctx.db, plan.workspace_id, "approved", `You approved "${plan.title}" (version ${plan.version}).`);
        return { planId, created: true };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return { planId, created: false };
    }
  })();
  ctx.jobs.enqueue("execute_plan", `execute:${result.planId}`, { planId: result.planId });
  return result;
}

export function discardPlan(ctx: Ctx, planId: string): void {
  const plan = getPlan(ctx.db, planId);
  if (plan.status !== "proposed") throw conflict("Only a proposed plan can be set aside.");
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE plans SET status = 'discarded', finished_at = ? WHERE id = ? AND status = 'proposed'", now(), planId);
    logEvent(ctx.db, plan.workspace_id, "plan", `You set aside "${plan.title}". Nothing in Drive changed.`);
  });
}

/** Re-queues an approved plan after a stop (for example, an expired sign-in). Done steps are skipped. */
export function resumePlan(ctx: Ctx, planId: string): void {
  const plan = getPlan(ctx.db, planId);
  if (!["approved", "executing", "partial", "failed"].includes(plan.status)) throw conflict("This plan can't be resumed.");
  const retryable = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM plan_ops WHERE plan_id = ? AND state IN ('pending', 'uncertain', 'running', 'failed', 'skipped')", planId)!.n;
  if (!retryable) throw conflict("Nothing left to retry in this plan.");
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE plan_ops SET state = 'pending', error = NULL WHERE plan_id = ? AND state IN ('failed', 'skipped')", planId);
    // The index was written with what had worked; write it again after the retried steps.
    run(ctx.db, "UPDATE plan_ops SET state = 'pending', error = NULL WHERE plan_id = ? AND kind = 'write_index' AND state = 'verified'", planId);
    run(ctx.db, "UPDATE plans SET status = 'approved', finished_at = NULL WHERE id = ?", planId);
    logEvent(ctx.db, plan.workspace_id, "plan", `You asked Kiki to retry the unfinished steps of "${plan.title}". Finished steps won't run again.`);
  });
  ctx.jobs.enqueue("execute_plan", `execute:${planId}`, { planId });
}

/** Proposes reversing a plan's verified changes. It runs only after its own approval. */
export function proposeUndo(ctx: Ctx, planId: string): string {
  const plan = getPlan(ctx.db, planId);
  if (!["applied", "partial", "stale", "failed"].includes(plan.status)) throw conflict("Only a plan that changed something can be undone.");
  const ws = requireWorkspace(ctx.db);
  const rows = planOps(ctx.db, planId);
  const log = new Map(all<ChangeLogRow>(ctx.db, "SELECT * FROM change_log WHERE plan_op_id IN (SELECT id FROM plan_ops WHERE plan_id = ?) AND undone_by_op_id IS NULL", planId).map((c) => [c.plan_op_id, c]));
  const files = new Map(all<FileRow>(ctx.db, "SELECT * FROM files WHERE workspace_id = ?", ws.id).map((f) => [f.file_id, f]));
  const changes: UndoSource[] = [];
  for (const r of rows) {
    if (r.state !== "verified") continue;
    if (r.kind === "move_rename") {
      const c = log.get(r.id);
      if (!c) continue;
      changes.push({
        opSeq: r.seq,
        kind: "move_rename",
        fileId: c.file_id,
        docId: r.doc_id,
        beforeName: c.before_name,
        beforeParentId: c.before_parent_id,
        beforePath: r.pre_path,
        afterName: c.after_name,
        afterParentId: c.after_parent_id,
        afterVersion: c.after_version,
        afterPath: files.get(c.file_id)?.path ?? r.new_path,
        statusBefore: null,
        supersedesBefore: null,
        statusAfter: null,
      });
    } else if (r.kind === "set_status" && r.result_json) {
      const result = JSON.parse(r.result_json) as { previousStatus: string | null; previousSupersedes: string | null };
      changes.push({
        opSeq: r.seq,
        kind: "set_status",
        fileId: null,
        docId: r.doc_id,
        beforeName: null,
        beforeParentId: null,
        beforePath: null,
        afterName: null,
        afterParentId: null,
        afterVersion: null,
        afterPath: null,
        statusBefore: result.previousStatus,
        supersedesBefore: result.previousSupersedes,
        statusAfter: r.target_status,
      });
    }
  }
  if (changes.length === 0) throw conflict("There are no verified changes left to undo.");
  const project = rows.find((r) => r.kind === "write_index")?.folder_path?.split("/")[1] ?? null;
  const idx = project ? (indexFiles(ctx.db, ws.id)[project] ?? null) : null;
  const draft = buildUndoPlan({ project, changes, indexFile: idx, rootId: ws.root_file_id, files: planFiles(ctx.db, ws.id) });
  const { plan: undo } = savePlanVersion(ctx.db, ws, {
    kind: "undo",
    seriesId: `undo:${planId}`,
    title: `Undo "${plan.title}"`,
    summary: `Kiki would put back ${changes.filter((c) => c.kind === "move_rename").length} file(s) and restore index statuses where nothing changed since. Folders she created stay; nothing is deleted.`,
    draft,
    details: { notes: [], undoOf: planId },
    source: { undoOf: planId },
  });
  return undo.id;
}
