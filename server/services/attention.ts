import { all, kvGet, kvSet, logEvent, type DocumentRow, type ProjectRow } from "../db.ts";
import { findAttention, type AttentionItem } from "../domain/attention.ts";
import { badRequest } from "../errors.ts";
import type { Ctx } from "./context.ts";
import { waitingForRevision } from "./holds.ts";
import { docFacts, requireWorkspace } from "./workspace.ts";

const dismissedKey = (wsId: string) => `attention.dismissed.${wsId}`;

/** Today on this machine's calendar (the user's), as YYYY-MM-DD. */
export function localToday(at = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function dismissed(ctx: Ctx, wsId: string): Set<string> {
  return new Set(JSON.parse(kvGet(ctx.db, dismissedKey(wsId)) ?? "[]") as string[]);
}

/** Documents something else is already handling: an open question to the contractor, a pending update. */
function busyDocs(ctx: Ctx, wsId: string): Set<string> {
  const busy = new Set(all<{ document_id: string }>(ctx.db, "SELECT document_id FROM dispatches WHERE open = 1").map((r) => r.document_id));
  for (const r of all<{ id: string }>(
    ctx.db,
    `SELECT DISTINCT d.id FROM plan_ops o JOIN plans p ON p.id = o.plan_id JOIN documents d ON d.workspace_id = p.workspace_id AND d.file_id = o.file_id
     WHERE p.workspace_id = ? AND p.kind = 'version_update' AND p.status IN ('proposed', 'approved', 'executing')`,
    wsId,
  )) {
    busy.add(r.id);
  }
  for (const w of waitingForRevision(ctx.db, wsId)) for (const c of w.candidates) busy.add(c.docId);
  return busy;
}

export function attentionItems(ctx: Ctx, wsId: string, today = localToday()): AttentionItem[] {
  const projects = new Map(all<ProjectRow>(ctx.db, "SELECT * FROM projects WHERE workspace_id = ?", wsId).map((p) => [p.id, p.name]));
  const docs = all<DocumentRow & { f_name: string }>(
    ctx.db,
    `SELECT d.*, f.name AS f_name FROM documents d JOIN files f ON f.workspace_id = d.workspace_id AND f.file_id = d.file_id
     WHERE d.workspace_id = ? AND f.present = 1`,
    wsId,
  ).map((d) => ({
    docId: d.id,
    fileName: d.f_name,
    project: d.project_id ? (projects.get(d.project_id) ?? null) : null,
    readStatus: d.read_status,
    readError: d.read_error,
    facts: docFacts(d),
    versionStatus: d.version_status,
    acceptedAt: d.accepted_at,
  }));
  const hidden = dismissed(ctx, wsId);
  return findAttention({ today, docs, busyDocIds: busyDocs(ctx, wsId) }).filter((i) => !hidden.has(i.key));
}

/** "Got it": the item stays hidden until the situation changes (its key changes with it). */
export function dismissAttention(ctx: Ctx, key: string): void {
  const ws = requireWorkspace(ctx.db);
  if (typeof key !== "string" || !key || key.length > 600) throw badRequest("Which item?");
  const item = attentionItems(ctx, ws.id).find((i) => i.key === key);
  if (!item) return;
  const keys = dismissed(ctx, ws.id);
  keys.add(key);
  kvSet(ctx.db, dismissedKey(ws.id), JSON.stringify([...keys].slice(-500)));
  logEvent(ctx.db, ws.id, "attention", `You set aside: ${item.title}.`);
}
