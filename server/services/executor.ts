import { logEvent, now, one, run, tx, type DocumentRow, type PlanOpRow, type PlanRow, type ProjectRow, type WorkspaceRow } from "../db.ts";
import { CATEGORY } from "../domain/naming.ts";
import { changeToken, DriveError, FOLDER_MIME, SHORTCUT_MIME, type DriveFile } from "../google/types.ts";
import type { Ctx } from "./context.ts";
import { buildIndexCsv } from "./indexfile.ts";
import { planOps } from "./plans.ts";
import { ensureProject, recordFile } from "./workspace.ts";

/** Thrown when a file changed since preview: the plan stops and the proposal needs a refresh. */
class StopPlan extends Error {}

const DONE = new Set(["verified", "excluded", "skipped", "failed", "stale"]);
const dirname = (p: string | null) => (p && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function describeDrift(op: PlanOpRow, live: DriveFile): string {
  const bits: string[] = [];
  if (live.name !== op.pre_name) bits.push(`it was renamed to "${live.name}"`);
  if ((live.parents[0] ?? null) !== op.pre_parent_id) bits.push("it was moved");
  if (!bits.length) bits.push("it was edited");
  return `"${op.pre_name}" changed since you previewed this plan (${bits.join(" and ")}). Kiki stopped instead of acting on old information. Refresh the proposal.`;
}

class Execution {
  private readonly ctx: Ctx;
  private readonly ws: WorkspaceRow;
  private readonly plan: PlanRow;
  /** Folder IDs proven (live) to sit inside the workspace during this run. */
  private readonly inside = new Set<string>();

  constructor(ctx: Ctx, ws: WorkspaceRow, plan: PlanRow) {
    this.ctx = ctx;
    this.ws = ws;
    this.plan = plan;
    this.inside.add(ws.root_file_id);
  }

  private op(id: string): PlanOpRow {
    return one<PlanOpRow>(this.ctx.db, "SELECT * FROM plan_ops WHERE id = ?", id)!;
  }

  private set(op: PlanOpRow, state: PlanOpRow["state"], fields: { error?: string | null; result?: unknown } = {}): void {
    const done = DONE.has(state);
    run(
      this.ctx.db,
      `UPDATE plan_ops SET state = ?, error = COALESCE(?, error), result_json = COALESCE(?, result_json), finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      state,
      fields.error ?? null,
      fields.result === undefined ? null : JSON.stringify(fields.result),
      done ? 1 : 0,
      now(),
      op.id,
    );
  }

  private markRunning(op: PlanOpRow): void {
    run(this.ctx.db, "UPDATE plan_ops SET state = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), error = NULL WHERE id = ?", now(), op.id);
  }

  private async tryGet(id: string): Promise<DriveFile | null> {
    try {
      const f = await this.ctx.drive.getFile(id);
      return f.trashed ? null : f;
    } catch (err) {
      if (err instanceof DriveError && err.kind === "not_found") return null;
      throw err;
    }
  }

  /** Walks a folder's parents (live) up to the workspace root. Anything else is out of bounds. */
  private async assertInside(folderId: string | null): Promise<void> {
    if (!folderId) throw new Error("The file has no parent folder, so it isn't inside the workspace.");
    const chain: string[] = [];
    let id: string | undefined = folderId;
    for (let depth = 0; id && depth < 50; depth++) {
      if (this.inside.has(id)) {
        for (const c of chain) this.inside.add(c);
        return;
      }
      chain.push(id);
      const f = await this.tryGet(id);
      if (!f || f.mimeType === SHORTCUT_MIME) break;
      if (this.ws.drive_id && f.driveId !== this.ws.drive_id) break;
      id = f.parents[0];
    }
    throw new Error("That location is outside the workspace folder, so Kiki won't touch it.");
  }

  private async resolveParent(op: PlanOpRow): Promise<string> {
    const ref = op.parent_ref ?? "";
    if (ref.startsWith("op:")) {
      const seq = Number(ref.slice(3));
      const dep = one<PlanOpRow>(this.ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND seq = ?", op.plan_id, seq);
      const folderId = dep?.state === "verified" && dep.result_json ? (JSON.parse(dep.result_json) as { folderId?: string }).folderId : undefined;
      if (!folderId) throw new Error(`The folder from step ${seq} isn't there.`);
      // Made by this run: already known to be inside. Made by an earlier run (a resume or a
      // restart): someone may have moved it out of the workspace since, so walk up to the root.
      await this.assertInside(folderId);
      return folderId;
    }
    const id = ref.startsWith("file:") ? ref.slice(5) : ref;
    await this.assertInside(id);
    return id;
  }

  async run(): Promise<void> {
    for (const row of planOps(this.ctx.db, this.plan.id)) {
      const op = this.op(row.id);
      if (DONE.has(op.state)) continue;
      const deps = JSON.parse(op.depends_on ?? "[]") as number[];
      const depRows = deps.map((seq) => one<PlanOpRow>(this.ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND seq = ?", op.plan_id, seq)).filter((d): d is PlanOpRow => Boolean(d));
      // The index is built from verified state, so one failed move doesn't hold it back (the CSV
      // shows the moves that did happen); it needs its folder, and at least one change to show.
      const blocks = (d: PlanOpRow) => op.kind !== "write_index" || d.kind === "create_folder";
      const blocked = depRows.find((d) => d.state !== "verified" && blocks(d));
      if (blocked) {
        this.set(op, "skipped", { error: `Didn't run because step ${blocked.seq} didn't complete.` });
        continue;
      }
      const changes = depRows.filter((d) => d.kind !== "create_folder");
      if (op.kind === "write_index" && changes.length > 0 && !changes.some((d) => d.state === "verified")) {
        this.set(op, "skipped", { error: "Nothing in this plan changed, so the index didn't need rewriting." });
        continue;
      }
      try {
        if (op.kind === "create_folder") await this.createFolder(op);
        else if (op.kind === "move_rename") await this.moveRename(op);
        else if (op.kind === "set_status") this.setStatus(op);
        else if (op.kind === "write_index") await this.writeIndex(op);
      } catch (err) {
        if (err instanceof StopPlan) {
          for (const rest of planOps(this.ctx.db, this.plan.id)) {
            if (rest.state === "pending") this.set(rest, "skipped", { error: "Not started: the plan stopped because a file changed since preview." });
          }
          return;
        }
        if (err instanceof DriveError && (err.retryable || err.kind === "auth")) throw err;
        const current = this.op(op.id);
        if (current.state === "running") this.set(current, "failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async createFolder(op: PlanOpRow): Promise<void> {
    this.markRunning(op);
    const parentId = await this.resolveParent(op);
    const name = op.new_name!;
    let generated = op.generated_id;
    if (!generated) {
      generated = (await this.ctx.drive.generateIds(1))[0]!;
      run(this.ctx.db, "UPDATE plan_ops SET generated_id = ? WHERE id = ?", generated, op.id);
    }
    // A previous attempt may have created it already (same pre-generated ID), or the folder may exist.
    let folder = await this.tryGet(generated);
    let adopted = folder !== null;
    if (!folder) {
      const existing = (await this.ctx.drive.findChildFolders(parentId, name, this.ws.drive_id)).sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
      if (existing[0]) {
        folder = existing[0];
        adopted = true;
      }
    }
    if (!folder) {
      try {
        folder = await this.ctx.drive.createFolder({ id: generated, name, parentId });
      } catch (err) {
        if (err instanceof DriveError && (err.kind === "conflict" || err.delivery === "unknown")) {
          folder = await this.tryGet(generated);
          if (!folder) {
            this.set(op, "uncertain", { error: err.message });
            throw err;
          }
        } else throw err;
      }
    }
    const check = await this.ctx.drive.getFile(folder.id);
    if (check.mimeType !== FOLDER_MIME || check.parents[0] !== parentId || check.name !== name) {
      this.set(op, "failed", { error: `Drive shows a different result for the "${name}" folder.` });
      return;
    }
    this.inside.add(check.id);
    tx(this.ctx.db, () => {
      this.set(op, "verified", { result: { folderId: check.id, adopted } });
      recordFile(this.ctx.db, this.ws.id, check, dirname(op.folder_path), adopted && check.id !== generated ? null : "created_by_kiki");
      run(
        this.ctx.db,
        "INSERT OR IGNORE INTO change_log (workspace_id, plan_op_id, file_id, kind, after_name, after_parent_id, after_version, applied_at) VALUES (?, ?, ?, 'create_folder', ?, ?, ?, ?)",
        this.ws.id,
        op.id,
        check.id,
        check.name,
        parentId,
        changeToken(check),
        now(),
      );
    });
  }

  private async moveRename(op: PlanOpRow): Promise<void> {
    this.markRunning(op);
    const destId = await this.resolveParent(op);
    const live = await this.tryGet(op.file_id!);
    if (!live) {
      this.set(op, "failed", { error: `"${op.pre_name}" is no longer in Drive.` });
      return;
    }
    // Already in the target state: a previous attempt went through.
    if (live.name === op.new_name && live.parents[0] === destId) return this.verify(op, live, destId);
    if (live.name !== op.pre_name || (live.parents[0] ?? null) !== op.pre_parent_id || changeToken(live) !== op.pre_version) {
      this.set(op, "stale", { error: describeDrift(op, live) });
      throw new StopPlan();
    }
    if (live.mimeType === SHORTCUT_MIME) {
      this.set(op, "failed", { error: "That's a shortcut; Kiki doesn't move shortcuts." });
      return;
    }
    if (this.ws.drive_id && live.driveId !== this.ws.drive_id) {
      this.set(op, "failed", { error: "That file is in a different shared drive, so Kiki won't move it." });
      return;
    }
    await this.assertInside(op.pre_parent_id);
    const change: { name?: string; addParent?: string; removeParent?: string } = {};
    if (live.name !== op.new_name) {
      if (!live.capabilities.canRename) return this.set(op, "failed", { error: "Drive says you can't rename this file." });
      change.name = op.new_name!;
    }
    if (live.parents[0] !== destId) {
      if (!live.capabilities.canMove) return this.set(op, "failed", { error: "Drive says you can't move this file." });
      change.addParent = destId;
      change.removeParent = live.parents[0];
    }
    try {
      await this.ctx.drive.update(op.file_id!, change);
    } catch (err) {
      if (err instanceof DriveError && err.delivery === "unknown") {
        // The change may or may not have happened. Read the file back to find out.
        this.set(op, "uncertain", { error: err.message });
        const after = await this.tryGet(op.file_id!);
        if (after && after.name === op.new_name && after.parents[0] === destId) return this.verify(op, after, destId);
        if (after && after.name === op.pre_name && after.parents[0] === op.pre_parent_id) run(this.ctx.db, "UPDATE plan_ops SET state = 'pending' WHERE id = ?", op.id);
        throw err;
      }
      throw err;
    }
    this.verify(op, await this.ctx.drive.getFile(op.file_id!), destId);
  }

  private verify(op: PlanOpRow, after: DriveFile, destId: string): void {
    if (after.name !== op.new_name || after.parents[0] !== destId) {
      this.set(op, "failed", { error: `Drive reports a different result: the file is named "${after.name}".` });
      return;
    }
    tx(this.ctx.db, () => {
      this.set(op, "verified", { result: { name: after.name, parentId: destId, version: changeToken(after) } });
      // Confirmed by reading Drive back: an earlier "didn't answer in time" is no longer an error.
      run(this.ctx.db, "UPDATE plan_ops SET error = NULL WHERE id = ?", op.id);
      this.recordProject(op);
      run(
        this.ctx.db,
        `INSERT OR IGNORE INTO change_log (workspace_id, plan_op_id, file_id, kind, before_name, before_parent_id, after_name, after_parent_id, after_version, applied_at)
         VALUES (?, ?, ?, 'move_rename', ?, ?, ?, ?, ?, ?)`,
        this.ws.id,
        op.id,
        after.id,
        op.pre_name,
        op.pre_parent_id,
        after.name,
        destId,
        changeToken(after),
        now(),
      );
      recordFile(this.ctx.db, this.ws.id, after, op.new_path ?? "", null);
      if (this.plan.kind === "undo") {
        run(
          this.ctx.db,
          `UPDATE change_log SET undone_by_op_id = ? WHERE file_id = ? AND undone_by_op_id IS NULL AND kind = 'move_rename' AND plan_op_id IN
             (SELECT id FROM plan_ops WHERE plan_id = (SELECT json_extract(source_json, '$.undoOf') FROM plans WHERE id = ?))`,
          op.id,
          after.id,
          this.plan.id,
        );
      }
    });
  }

  /**
   * A document filed into a project folder belongs to that project, so the index lists it: also
   * when its text spells the project differently ("CS245" filed into "CS 245") or names none
   * (placed by its title or its supplier). Moved back out by an undo, it only keeps a project its
   * own text names.
   */
  private recordProject(op: PlanOpRow): void {
    if (!op.doc_id) return;
    const [category, project] = (op.new_path ?? "").split("/");
    if (this.plan.kind !== "undo" && (category === CATEGORY || category === "Renovations") && project) {
      run(this.ctx.db, "UPDATE documents SET project_id = ?, updated_at = ? WHERE id = ?", ensureProject(this.ctx.db, this.ws.id, project).id, now(), op.doc_id);
    } else if (this.plan.kind === "undo" && category !== CATEGORY && category !== "Renovations") {
      run(this.ctx.db, "UPDATE documents SET project_id = NULL, updated_at = ? WHERE id = ? AND json_extract(facts_json, '$.project.value') IS NULL", now(), op.doc_id);
    }
  }

  private setStatus(op: PlanOpRow): void {
    const doc = one<DocumentRow>(this.ctx.db, "SELECT * FROM documents WHERE id = ?", op.doc_id!);
    if (!doc) return this.set(op, "failed", { error: "That document is no longer in the index." });
    if ((doc.version_status ?? null) !== (op.pre_status ?? null)) {
      this.set(op, "stale", { error: "The index changed since this was proposed, so Kiki didn't overwrite it. Refresh the proposal." });
      throw new StopPlan();
    }
    const supersedes = this.plan.kind === "undo" ? op.target_supersedes_id : op.target_status === "current" ? op.target_supersedes_id : doc.supersedes_id;
    tx(this.ctx.db, () => {
      run(this.ctx.db, "UPDATE documents SET version_status = ?, supersedes_id = ?, updated_at = ? WHERE id = ?", op.target_status, supersedes, now(), doc.id);
      run(
        this.ctx.db,
        "INSERT INTO version_events (document_id, kind, detail, evidence_json, plan_id, at) VALUES (?, ?, ?, ?, ?, ?)",
        doc.id,
        `status:${op.target_status}`,
        op.reason,
        op.evidence_json,
        this.plan.id,
        now(),
      );
      this.set(op, "verified", { result: { previousStatus: doc.version_status, previousSupersedes: doc.supersedes_id } });
    });
  }

  private async writeIndex(op: PlanOpRow): Promise<void> {
    this.markRunning(op);
    const projectName = (op.folder_path ?? "").split("/")[1] ?? "";
    const project = one<ProjectRow>(this.ctx.db, "SELECT * FROM projects WHERE workspace_id = ? AND name = ? ORDER BY created_at, id LIMIT 1", this.ws.id, projectName);
    if (!project) return this.set(op, "failed", { error: "That project isn't in the index." });
    const parentId = await this.resolveParent(op);
    const csv = buildIndexCsv(this.ctx.db, project, now());
    let file: DriveFile | null = op.file_id ? await this.tryGet(op.file_id) : null;
    if (file) {
      if (changeToken(file) !== op.pre_version && changeToken(file) !== project.index_file_version) {
        this.set(op, "failed", { error: "Someone edited the index file since Kiki last wrote it, so she didn't overwrite it." });
        return;
      }
      file = await this.ctx.drive.updateContent(file.id, "text/csv", csv);
    } else {
      let generated = op.generated_id;
      if (!generated) {
        generated = (await this.ctx.drive.generateIds(1))[0]!;
        run(this.ctx.db, "UPDATE plan_ops SET generated_id = ? WHERE id = ?", generated, op.id);
      }
      file = await this.tryGet(generated);
      if (!file) {
        try {
          file = await this.ctx.drive.createFile({ id: generated, name: op.new_name!, parentId, mimeType: "text/csv", content: csv });
        } catch (err) {
          if (err instanceof DriveError && (err.kind === "conflict" || err.delivery === "unknown")) file = await this.tryGet(generated);
          if (!file) throw err;
        }
      }
      file = await this.ctx.drive.updateContent(file.id, "text/csv", csv);
    }
    const check = await this.ctx.drive.getFile(file.id);
    const content = await this.ctx.drive.readContent(check, 2_000_000);
    if (check.parents[0] !== parentId || content.kind !== "text" || content.text.trim() !== csv.trim()) {
      this.set(op, "failed", { error: "Drive shows different index contents than Kiki wrote." });
      return;
    }
    tx(this.ctx.db, () => {
      run(this.ctx.db, "UPDATE projects SET index_file_id = ?, index_file_version = ? WHERE id = ?", check.id, changeToken(check), project.id);
      recordFile(this.ctx.db, this.ws.id, check, op.folder_path ?? "", "created_by_kiki");
      this.set(op, "verified", { result: { fileId: check.id, version: changeToken(check), rows: csv.split("\r\n").length - 3 } });
    });
  }
}

/**
 * Runs an approved plan. Each step is checked against its preview, applied, then read back; the
 * plan's final status reports exactly what was applied and verified.
 */
export async function executePlan(ctx: Ctx, planId: string, attempt = 1): Promise<void> {
  let plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", planId);
  if (!plan || !["approved", "executing"].includes(plan.status)) return;
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", plan.workspace_id)!;
  try {
    run(ctx.db, "UPDATE plans SET status = 'executing' WHERE id = ? AND status IN ('approved', 'executing')", planId);
  } catch (err) {
    throw new DriveError("Another plan is still running in this workspace.", "rate_limit", { delivery: "not_sent" });
  }
  plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", planId)!;
  try {
    await new Execution(ctx, ws, plan).run();
  } catch (err) {
    if (err instanceof DriveError && err.retryable && attempt < 3) throw err; // the job retries with backoff
    const reason = err instanceof DriveError && err.kind === "auth" ? "Google sign-in expired. Reconnect Google Drive, then retry the unfinished steps." : `Paused: ${err instanceof Error ? err.message : String(err)}`;
    run(ctx.db, "UPDATE plan_ops SET state = 'uncertain', error = ? WHERE plan_id = ? AND state = 'running'", reason, planId);
    logEvent(ctx.db, ws.id, "plan", reason);
  }
  finalize(ctx, planId);
  ctx.jobs.enqueue("inventory", `inventory:${ws.id}`, { workspaceId: ws.id }, 1);
}

function finalize(ctx: Ctx, planId: string): void {
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", planId)!;
  const ops = planOps(ctx.db, planId).filter((o) => o.state !== "excluded");
  const verified = ops.filter((o) => o.state === "verified").length;
  const stale = ops.some((o) => o.state === "stale");
  const status = stale ? "stale" : verified === ops.length ? "applied" : verified > 0 ? "partial" : "failed";
  const unfinished = ops.length - verified;
  const message =
    status === "applied"
      ? `"${plan.title}": all ${ops.length} step${ops.length === 1 ? "" : "s"} applied and verified in Drive.`
      : status === "stale"
        ? `"${plan.title}" stopped because something changed since preview. ${verified} step${verified === 1 ? " was" : "s were"} applied and verified; ${unfinished} didn't run.`
        : `"${plan.title}": ${verified} of ${ops.length} steps applied and verified; ${unfinished} didn't finish. Nothing is reported as done unless Drive confirms it.`;
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE plans SET status = ?, finished_at = ? WHERE id = ?", status, now(), planId);
    if (status === "applied" && plan.kind === "version_update") {
      run(ctx.db, "UPDATE outcomes SET status = 'resolved', updated_at = ? WHERE plan_series_id = ?", now(), plan.series_id);
      // The question this conversation was for is answered and applied: stop following it.
      run(ctx.db, "UPDATE watches SET state = 'closed' WHERE id IN (SELECT watch_id FROM outcomes WHERE plan_series_id = ?)", plan.series_id);
    }
    logEvent(ctx.db, plan.workspace_id, status === "applied" ? "verified" : "plan_incomplete", message);
  });
}
