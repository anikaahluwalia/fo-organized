import { randomUUID } from "node:crypto";
import { all, kvGet, kvSet, logEvent, now, one, run, tx, type Db, type DocumentRow, type FileOrigin, type FileRow, type ProjectRow, type WorkspaceRow } from "../db.ts";
import { DEMO_WORKSPACE_NAME, demoFileContent, MESSY_FOLDER, NEW_SUPPLIER_INVOICE, REVISED_QUOTE, SECOND_REVISION, type DemoDoc } from "../demo/renovation.ts";
import { FACTS_VERSION, toFacts, type DocFacts } from "../domain/documents.ts";
import { isSameCollection } from "../domain/collections.ts";
import { CATEGORY } from "../domain/naming.ts";
import { join } from "../domain/plan.ts";
import { badRequest, conflict } from "../errors.ts";
import { localText, ReadError } from "../extractor.ts";
import { changeToken, DriveError, FOLDER_MIME, SHORTCUT_MIME, type DriveFile } from "../google/types.ts";
import type { Ctx } from "./context.ts";

export function activeWorkspace(db: Db): WorkspaceRow | undefined {
  return one<WorkspaceRow>(db, "SELECT * FROM workspaces WHERE active = 1");
}

export function requireWorkspace(db: Db): WorkspaceRow {
  const ws = activeWorkspace(db);
  if (!ws) throw conflict("Choose a workspace folder first.");
  return ws;
}

export function parseFolderId(input: string): string | null {
  const s = input.trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1]!;
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}

function upsertFile(db: Db, wsId: string, f: DriveFile, path: string, origin: FileOrigin | null): void {
  const at = now();
  run(
    db,
    `INSERT INTO files (workspace_id, file_id, name, mime_type, parent_id, path, version, modified_time, created_time, size, is_folder, is_shortcut,
                        can_rename, can_move, can_add_children, web_link, origin, present, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (workspace_id, file_id) DO UPDATE SET
       name = excluded.name, mime_type = excluded.mime_type, parent_id = excluded.parent_id, path = excluded.path,
       version = excluded.version, modified_time = excluded.modified_time, size = excluded.size,
       can_rename = excluded.can_rename, can_move = excluded.can_move, can_add_children = excluded.can_add_children,
       web_link = excluded.web_link, present = 1, last_seen_at = excluded.last_seen_at`,
    wsId,
    f.id,
    f.name,
    f.mimeType,
    f.parents[0] ?? null,
    path,
    changeToken(f),
    f.modifiedTime,
    f.createdTime,
    f.size,
    f.mimeType === FOLDER_MIME ? 1 : 0,
    f.mimeType === SHORTCUT_MIME ? 1 : 0,
    f.capabilities.canRename ? 1 : 0,
    f.capabilities.canMove ? 1 : 0,
    f.capabilities.canAddChildren ? 1 : 0,
    f.webViewLink,
    origin ?? "found",
    at,
    at,
  );
}

/** Records a file Kiki (or the staged demo) just created or changed, with its verified metadata. */
export function recordFile(db: Db, wsId: string, f: DriveFile, path: string, origin: FileOrigin | null): void {
  upsertFile(db, wsId, f, path, origin);
  // Kiki's own files and folders aren't documents to read; everything else is.
  if (f.mimeType !== FOLDER_MIME && f.mimeType !== SHORTCUT_MIME && origin !== "created_by_kiki") ensureDocument(db, wsId, f);
}

function ensureDocument(db: Db, wsId: string, f: DriveFile): void {
  const existing = one<DocumentRow>(db, "SELECT * FROM documents WHERE workspace_id = ? AND file_id = ?", wsId, f.id);
  if (!existing) {
    run(db, "INSERT INTO documents (id, workspace_id, file_id, read_status, updated_at) VALUES (?, ?, ?, 'pending', ?)", randomUUID(), wsId, f.id, now());
  } else if (existing.read_status === "read" && existing.read_file_version && f.contentKey && existing.read_file_version !== f.contentKey) {
    // The content changed since Kiki read it: read it again.
    run(db, "UPDATE documents SET read_status = 'pending', updated_at = ? WHERE id = ?", now(), existing.id);
  }
}

export async function selectWorkspace(ctx: Ctx, input: string): Promise<WorkspaceRow> {
  const id = parseFolderId(input);
  if (!id) throw badRequest("Paste a Google Drive folder link (it contains /folders/).");
  let folder: DriveFile;
  try {
    folder = await ctx.drive.getFile(id);
  } catch (err) {
    if (err instanceof DriveError && err.kind === "not_found") throw badRequest("Kiki can't see that folder. Check the link, and that it's in the Drive you connected.");
    throw err;
  }
  if (folder.mimeType !== FOLDER_MIME) throw badRequest("That link is a file, not a folder.");
  if (folder.trashed) throw badRequest("That folder is in the trash.");
  if (folder.parents.length === 0 && !folder.driveId) throw badRequest("Choose a specific folder, not your whole Drive.");
  const ws = tx(ctx.db, () => {
    run(ctx.db, "UPDATE workspaces SET active = 0 WHERE active = 1");
    const wsId = randomUUID();
    run(
      ctx.db,
      "INSERT INTO workspaces (id, root_file_id, name, drive_id, mode, origin, active, created_at) VALUES (?, ?, ?, ?, ?, 'selected', 1, ?)",
      wsId,
      folder.id,
      folder.name,
      folder.driveId,
      ctx.drive.mode,
      now(),
    );
    logEvent(ctx.db, wsId, "workspace", `You chose "${folder.name}" as the workspace. Kiki will only organize files inside it.`);
    return one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", wsId)!;
  });
  ctx.jobs.enqueue("inventory", `inventory:${ws.id}`, { workspaceId: ws.id });
  return ws;
}

async function uploadDemoDocs(ctx: Ctx, ws: WorkspaceRow, docs: DemoDoc[]): Promise<string[]> {
  const present = new Set(all<{ name: string }>(ctx.db, "SELECT name FROM files WHERE workspace_id = ? AND present = 1", ws.id).map((r) => r.name));
  const live = await ctx.drive.listChildren(ws.root_file_id, ws.drive_id);
  for (const f of live) present.add(f.name);
  // Files Kiki already renamed and filed don't match by name any more, so remember what was uploaded.
  const uploadedKey = `demo.uploaded.${ws.id}`;
  const uploaded = new Set<string>(JSON.parse(kvGet(ctx.db, uploadedKey) ?? "[]") as string[]);
  const added: string[] = [];
  for (const doc of docs) {
    if (present.has(doc.fileName) || (doc.key !== "northside-invoice-2" && uploaded.has(doc.key))) continue;
    const f = await ctx.drive.createFile({ name: doc.fileName, parentId: ws.root_file_id, mimeType: doc.mimeType, content: demoFileContent(doc) });
    tx(ctx.db, () => recordFile(ctx.db, ws.id, f, "", "staged_demo"));
    uploaded.add(doc.key);
    kvSet(ctx.db, uploadedKey, JSON.stringify([...uploaded]));
    added.push(doc.fileName);
  }
  return added;
}

/**
 * Creates a dedicated demo folder in My Drive with synthetic renovation paperwork. Everything in
 * it is labelled "Staged demo file". Running it again only adds files that are missing.
 */
export async function createDemoWorkspace(ctx: Ctx): Promise<WorkspaceRow> {
  let ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE origin = 'staged_demo' AND mode = ? AND name = ? ORDER BY created_at DESC LIMIT 1", ctx.drive.mode, DEMO_WORKSPACE_NAME);
  if (ws) {
    try {
      const root = await ctx.drive.getFile(ws.root_file_id);
      if (root.trashed) ws = undefined; // in the trash: make a new one
    } catch (err) {
      if (!(err instanceof DriveError && err.kind === "not_found")) throw err;
      ws = undefined; // the folder was removed in Drive; make a new one
    }
  }
  if (!ws) {
    const folder = await ctx.drive.createFolder({ name: DEMO_WORKSPACE_NAME, parentId: "root" });
    ws = tx(ctx.db, () => {
      run(ctx.db, "UPDATE workspaces SET active = 0 WHERE active = 1");
      const wsId = randomUUID();
      run(ctx.db, "INSERT INTO workspaces (id, root_file_id, name, drive_id, mode, origin, active, created_at) VALUES (?, ?, ?, ?, ?, 'staged_demo', 1, ?)", wsId, folder.id, folder.name, folder.driveId, ctx.drive.mode, now());
      logEvent(ctx.db, wsId, "workspace", `Set up "${folder.name}" with the renovation paperwork.`);
      return one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", wsId)!;
    });
  } else {
    const current = ws;
    tx(ctx.db, () => {
      run(ctx.db, "UPDATE workspaces SET active = 0 WHERE active = 1");
      run(ctx.db, "UPDATE workspaces SET active = 1 WHERE id = ?", current.id);
    });
  }
  const added = await uploadDemoDocs(ctx, ws, MESSY_FOLDER);
  if (added.length) logEvent(ctx.db, ws.id, "staged", `Added ${added.length} file${added.length === 1 ? "" : "s"} to the folder.`);
  ctx.jobs.enqueue("inventory", `inventory:${ws.id}`, { workspaceId: ws.id });
  return ws;
}

/**
 * Demo step: drop the contractor's revised quote into the workspace, as if the email attachment
 * had been saved to Drive. "ambiguous" adds a second same-day revision.
 */
export async function stageRevisedQuote(ctx: Ctx, variant: "single" | "ambiguous" | "invoice"): Promise<string[]> {
  const ws = requireWorkspace(ctx.db);
  const docs = variant === "invoice" ? [NEW_SUPPLIER_INVOICE] : variant === "ambiguous" ? [REVISED_QUOTE, SECOND_REVISION] : [REVISED_QUOTE];
  const added = await uploadDemoDocs(ctx, ws, docs);
  if (added.length) logEvent(ctx.db, ws.id, "staged", `Added ${added.map((n) => `"${n}"`).join(" and ")} to the folder.`);
  ctx.jobs.enqueue("inventory", `inventory:${ws.id}`, { workspaceId: ws.id });
  return added;
}

/** Read-only walk of the workspace. Shortcuts are recorded but never followed. */
export async function runInventory(ctx: Ctx, wsId: string): Promise<{ seen: number; added: number; changed: number }> {
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", wsId);
  if (!ws) return { seen: 0, added: 0, changed: 0 };
  const runId = randomUUID();
  run(ctx.db, "INSERT INTO inventory_runs (id, workspace_id, started_at, status) VALUES (?, ?, ?, 'running')", runId, wsId, now());
  try {
    const root = await ctx.drive.getFile(ws.root_file_id);
    if (root.trashed || root.mimeType !== FOLDER_MIME) throw new Error("The workspace folder is gone or in the trash.");
    const found = new Map<string, { file: DriveFile; path: string }>();
    const queue: { id: string; path: string }[] = [{ id: root.id, path: "" }];
    while (queue.length) {
      const { id, path } = queue.shift()!;
      for (const child of await ctx.drive.listChildren(id, ws.drive_id)) {
        if (found.has(child.id)) continue;
        found.set(child.id, { file: child, path });
        if (child.mimeType === FOLDER_MIME) queue.push({ id: child.id, path: join(path, child.name) });
      }
      if (found.size > 5000) throw new Error("The workspace has more than 5,000 items. Choose a smaller folder for now.");
    }
    const before = new Map(all<FileRow>(ctx.db, "SELECT * FROM files WHERE workspace_id = ?", wsId).map((f) => [f.file_id, f]));
    let added = 0;
    let changed = 0;
    tx(ctx.db, () => {
      run(ctx.db, "UPDATE files SET present = 0 WHERE workspace_id = ?", wsId);
      for (const { file, path } of found.values()) {
        const prev = before.get(file.id);
        if (!prev) added++;
        else if (prev.name !== file.name || prev.path !== path || prev.version !== changeToken(file)) changed++;
        recordFile(ctx.db, wsId, file, path, prev?.origin ?? null);
      }
      run(ctx.db, "UPDATE inventory_runs SET status = 'done', finished_at = ?, files_seen = ?, new_files = ?, changed_files = ? WHERE id = ?", now(), found.size, added, changed, runId);
      run(ctx.db, "UPDATE workspaces SET last_inventory_at = ? WHERE id = ?", now(), wsId);
      if (added || changed || before.size === 0) {
        logEvent(ctx.db, wsId, "inventory", before.size === 0 ? `Kiki found ${found.size} items in the folder.` : `Kiki noticed ${added ? `${added} new` : ""}${added && changed ? " and " : ""}${changed ? `${changed} changed` : ""} item${added + changed === 1 ? "" : "s"}.`);
      }
      // Pick up a rename of the workspace folder itself.
      if (root.name !== ws.name) run(ctx.db, "UPDATE workspaces SET name = ? WHERE id = ?", root.name, wsId);
    });
    ctx.jobs.enqueue("read", `read:${wsId}`, { workspaceId: wsId });
    return { seen: found.size, added, changed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(ctx.db, "UPDATE inventory_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", now(), message, runId);
    throw err;
  }
}

/**
 * Adds the fields newer facts have to a document read earlier. Unchanged content keeps every
 * fact Kiki already had (so nothing gets renamed or moved); changed content is a normal re-read.
 */
async function upgradeFacts(ctx: Ctx, doc: DocumentRow): Promise<boolean> {
  const prior = docFacts(doc)!;
  const markDone = () =>
    run(ctx.db, "UPDATE documents SET facts_json = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...prior, refersTo: prior.refersTo ?? [], validUntil: prior.validUntil ?? null, version: FACTS_VERSION }), now(), doc.id);
  try {
    const file = await ctx.drive.getFile(doc.file_id);
    if (doc.read_file_version && file.contentKey && doc.read_file_version !== file.contentKey) {
      run(ctx.db, "UPDATE documents SET read_status = 'pending', updated_at = ? WHERE id = ?", now(), doc.id);
      return false;
    }
    const content = await ctx.drive.readContent(file, MAX_READ_BYTES);
    if (content.kind === "unsupported") {
      markDone();
      return false;
    }
    const fresh = toFacts(await ctx.reader.read(content, file.name), localText(content));
    run(
      ctx.db,
      "UPDATE documents SET facts_json = ?, updated_at = ? WHERE id = ?",
      // Only facts that don't decide names or folders: a background re-read never renames a filed document.
      JSON.stringify({ ...prior, title: prior.title, refersTo: fresh.refersTo ?? [], validUntil: fresh.validUntil ?? null, version: FACTS_VERSION } satisfies DocFacts),
      now(),
      doc.id,
    );
    return true;
  } catch (err) {
    // A document Kiki can't read again keeps what she knew; she doesn't keep retrying it. A
    // passing problem (rate limit, network) is retried later, so the new facts aren't lost.
    if ((err instanceof ReadError && !err.retryable) || (err instanceof DriveError && err.kind === "not_found")) {
      markDone();
      return false;
    }
    throw err;
  }
}

/**
 * The project a document's own text names. When that's a collection Kiki already keeps, spelled
 * differently ("CS245" for "CS 245"), it's that collection, so a new file shows in its index.
 */
export function projectNamed(db: Db, wsId: string, name: string): ProjectRow {
  const projects = all<ProjectRow>(db, "SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at, id", wsId);
  const same = (ps: ProjectRow[]) => ps.filter((p) => isSameCollection(p.name, name));
  const kept = same(projects.filter((p) => p.index_file_id));
  if (kept.length === 1) return kept[0]!;
  const exact = projects.find((p) => p.name === name);
  if (exact) return exact;
  const spelled = same(projects);
  return spelled.length === 1 ? spelled[0]! : ensureProject(db, wsId, name);
}

export function ensureProject(db: Db, wsId: string, name: string): ProjectRow {
  const existing = one<ProjectRow>(db, "SELECT * FROM projects WHERE workspace_id = ? AND name = ? ORDER BY created_at, id LIMIT 1", wsId, name);
  if (existing) return existing;
  run(db, "INSERT OR IGNORE INTO projects (id, workspace_id, category, name, created_at) VALUES (?, ?, ?, ?, ?)", randomUUID(), wsId, CATEGORY, name, now());
  return one<ProjectRow>(db, "SELECT * FROM projects WHERE workspace_id = ? AND category = ? AND name = ?", wsId, CATEGORY, name)!;
}

export function docFacts(doc: Pick<DocumentRow, "facts_json">): DocFacts | null {
  return doc.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
}

const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Reads every document whose content Kiki hasn't seen yet. Facts come only from the content.
 * Documents read before the facts gained fields are read again in the background: if their
 * content is unchanged, only the new fields are taken, so names and folders never shift.
 */
export async function runReading(ctx: Ctx, wsId: string): Promise<number> {
  const pending = all<DocumentRow>(
    ctx.db,
    `SELECT d.* FROM documents d JOIN files f ON f.workspace_id = d.workspace_id AND f.file_id = d.file_id
     WHERE d.workspace_id = ? AND f.present = 1
       AND (d.read_status IN ('pending', 'reading')
            OR (d.read_status = 'read' AND d.facts_json IS NOT NULL AND COALESCE(json_extract(d.facts_json, '$.version'), 1) < ?))`,
    wsId,
    FACTS_VERSION,
  );
  let readCount = 0;
  // What this run read, for the activity line (not everything in the workspace).
  const readTypes = new Map<string, number>();
  let upgraded = 0;
  const queue = [...pending];
  const worker = async () => {
    for (let doc = queue.shift(); doc; doc = queue.shift()) {
      if (doc.read_status === "read") {
        // Not `upgraded += await ...`: that reads the count before awaiting and loses the other workers' updates.
        if (await upgradeFacts(ctx, doc)) upgraded++;
        continue;
      }
      run(ctx.db, "UPDATE documents SET read_status = 'reading', updated_at = ? WHERE id = ?", now(), doc.id);
      let file: DriveFile;
      try {
        file = await ctx.drive.getFile(doc.file_id);
        const content = await ctx.drive.readContent(file, MAX_READ_BYTES);
        if (content.kind === "unsupported") {
          run(ctx.db, "UPDATE documents SET read_status = 'unreadable', read_error = ?, read_file_version = ?, updated_at = ? WHERE id = ?", content.reason, file.contentKey, now(), doc.id);
          continue;
        }
        const raw = await ctx.reader.read(content, file.name);
        const facts = toFacts(raw, localText(content));
        tx(ctx.db, () => {
          const project = facts.project.value ? projectNamed(ctx.db, wsId, facts.project.value) : null;
          run(
            ctx.db,
            `UPDATE documents SET doc_type = ?, facts_json = ?, project_id = COALESCE(?, project_id), read_status = 'read', read_mode = ?, read_error = NULL,
               read_file_version = ?, version_status = CASE WHEN ? = 'quote' THEN COALESCE(version_status, 'unresolved') ELSE NULL END, updated_at = ?
             WHERE id = ?`,
            facts.docType,
            JSON.stringify(facts),
            project?.id ?? null,
            ctx.reader.mode,
            file.contentKey,
            facts.docType,
            now(),
            doc!.id,
          );
        });
        readCount++;
        readTypes.set(facts.docType, (readTypes.get(facts.docType) ?? 0) + 1);
      } catch (err) {
        if (err instanceof ReadError && !err.retryable) {
          run(ctx.db, "UPDATE documents SET read_status = 'failed', read_error = ?, updated_at = ? WHERE id = ?", err.message, now(), doc.id);
          continue;
        }
        if (err instanceof DriveError && err.kind === "not_found") {
          run(ctx.db, "UPDATE files SET present = 0 WHERE workspace_id = ? AND file_id = ?", wsId, doc.file_id);
          run(ctx.db, "UPDATE documents SET read_status = 'pending', updated_at = ? WHERE id = ?", now(), doc.id);
          continue;
        }
        // Sign-in or network problems: put it back and let the job retry later.
        run(ctx.db, "UPDATE documents SET read_status = 'pending', updated_at = ? WHERE id = ?", now(), doc.id);
        throw err;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (upgraded) logEvent(ctx.db, wsId, "read", `Kiki took another look at ${upgraded} document${upgraded === 1 ? "" : "s"} for additional document facts. Existing classifications and filing decisions are preserved.`);
  if (readCount) {
    const types = [...readTypes].sort(([a], [b]) => a.localeCompare(b)).map(([type, n]) => `${n} ${type}`);
    logEvent(ctx.db, wsId, "read", `${ctx.reader.mode === "mock" ? "Mock reading" : "Claude"} read ${readCount} document${readCount === 1 ? "" : "s"} (${types.join(", ")}).`);
  }
  return readCount;
}
