/**
 * A proposal as Fo shows it to the account holder: every change, the files Kiki would move
 * numbered so an answer can refer to them ("skip number 3"), and the files she couldn't place.
 * File names, folder names and reasons come from documents, so each is one inert line.
 */
import { itemLine, oneLine, type ProposalItem } from "../domain/adjust.ts";
import { inDuplicatesFolder } from "../domain/duplicates.ts";
import type { PlanNote } from "../domain/plan.ts";
import { all, one, type PlanOpRow, type PlanRow } from "../db.ts";
import type { Ctx } from "./context.ts";

/**
 * The proposal's numbered items: each file it moves, numbered as the step it is in Kiki (so "skip
 * step 7" means the same file in Kiki and in Fo's message), then each file Kiki couldn't place.
 */
export function proposalItems(ctx: Ctx, plan: PlanRow): ProposalItem[] {
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state <> 'excluded' AND file_id IS NOT NULL ORDER BY seq", plan.id);
  const last = one<{ n: number | null }>(ctx.db, "SELECT MAX(seq) AS n FROM plan_ops WHERE plan_id = ?", plan.id)?.n ?? 0;
  const items: ProposalItem[] = moves.map((o) => ({
    n: o.seq,
    fileId: o.file_id!,
    kind: o.new_path && inDuplicatesFolder(o.new_path) ? "copy" : "move",
    name: o.pre_name ?? o.new_name ?? "",
    to: `${o.new_path ? `${o.new_path}/` : ""}${o.new_name ?? ""}`,
    why: o.reason,
  }));
  const notes = ((plan.details_json ? (JSON.parse(plan.details_json) as { notes?: PlanNote[] } | null) : null)?.notes ?? []) as PlanNote[];
  const shortcuts = new Set(all<{ file_id: string }>(ctx.db, "SELECT file_id FROM files WHERE workspace_id = ? AND is_shortcut = 1", plan.workspace_id).map((r) => r.file_id));
  for (const note of notes) {
    // Shortcuts never move, so there's nothing to say about where they'd go.
    if (note.status !== "left_in_place" || shortcuts.has(note.fileId) || items.some((i) => i.fileId === note.fileId)) continue;
    items.push({ n: last + items.filter((i) => i.kind === "unplaced").length + 1, fileId: note.fileId, kind: "unplaced", name: note.name, to: null, why: note.reason });
  }
  return items;
}

/** Every change in the proposal, one per line, with the numbers answers can refer to. */
export function proposalLines(ctx: Ctx, plan: PlanRow, items = proposalItems(ctx, plan)): string {
  const ops = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state <> 'excluded' ORDER BY seq", plan.id);
  const numbered = new Map(items.map((i) => [i.fileId, i.n]));
  const lines = ops.map((op) => {
    if (op.kind === "move_rename") {
      const n = op.file_id ? numbered.get(op.file_id) : undefined;
      return `${n ? `${n}.` : "-"} Move "${oneLine(op.pre_name)}" from "${oneLine(op.pre_path) || "workspace folder"}" to "${oneLine(op.new_path)}/${oneLine(op.new_name)}". ${oneLine(op.reason)}`.trim();
    }
    if (op.kind === "create_folder") return `- Create folder "${oneLine(op.folder_path)}".`;
    if (op.kind === "write_index") return `- Update index "${oneLine(op.folder_path)}/${oneLine(op.new_name)}".`;
    const doc = op.doc_id ? one<{ file_id: string }>(ctx.db, "SELECT file_id FROM documents WHERE id = ?", op.doc_id) : undefined;
    const file = doc ? one<{ name: string }>(ctx.db, "SELECT name FROM files WHERE workspace_id = ? AND file_id = ?", plan.workspace_id, doc.file_id) : undefined;
    return `- Mark "${oneLine(file?.name ?? "document")}" as ${op.target_status}. ${oneLine(op.reason)}`.trim();
  });
  const unplaced = items.filter((i) => i.kind === "unplaced");
  if (unplaced.length) lines.push("Not moved:", ...unplaced.map(itemLine));
  return lines.join("\n");
}
