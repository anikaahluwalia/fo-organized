/**
 * "Refresh the plan" on a plan that went stale (something changed before it ran): Kiki looks at the
 * folder again and proposes the same kind of change against what's there now. A stale undo comes
 * back as that undo, a quote update as that update; never an unrelated plan.
 */
import { one, type OutcomeRow, type PlanRow } from "../db.ts";
import type { Outcome } from "../domain/outcome.ts";
import type { Candidate } from "../domain/reconcile.ts";
import { conflict } from "../errors.ts";
import type { Ctx } from "./context.ts";
import { proposeMarkCurrent } from "./current.ts";
import { getPlan, proposeOrganize, proposeUndo } from "./plans.ts";
import { proposeConfirmCurrent, proposeVersionUpdate } from "./watch.ts";
import { requireWorkspace, runInventory } from "./workspace.ts";

export async function refreshPlan(ctx: Ctx, planId: string): Promise<{ planId: string | null; message: string }> {
  const plan = getPlan(ctx.db, planId);
  if (plan.status !== "stale") throw conflict("Only a plan that went stale can be refreshed.");
  const ws = requireWorkspace(ctx.db);
  // What's in the folder now, so the new version binds to it.
  await runInventory(ctx, ws.id);
  const source = plan.source_json ? (JSON.parse(plan.source_json) as { undoOf?: string; outcomeId?: string; markedBy?: string } | null) : null;
  const details = plan.details_json ? (JSON.parse(plan.details_json) as { oldDocumentId?: string; newDocumentId?: string } | null) : null;
  if (plan.kind === "undo" && source?.undoOf) {
    return { planId: proposeUndo(ctx, source.undoOf), message: "Kiki prepared the undo again, against what's in the folder now." };
  }
  if (plan.kind === "version_update" && details?.newDocumentId) {
    if (source?.markedBy === "user") return { planId: proposeMarkCurrent(ctx, details.newDocumentId).planId, message: "Kiki prepared the update again." };
    const o = source?.outcomeId ? one<OutcomeRow>(ctx.db, "SELECT * FROM outcomes WHERE id = ?", source.outcomeId) : undefined;
    if (o) {
      if (details.newDocumentId === details.oldDocumentId && o.interpretation_json) proposeConfirmCurrent(ctx, o.id, JSON.parse(o.interpretation_json) as Outcome);
      else proposeVersionUpdate(ctx, o.id, details.newDocumentId, o.candidates_json ? (JSON.parse(o.candidates_json) as Candidate[]) : [{ docId: details.newDocumentId } as Candidate]);
      const next = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE series_id = ? AND status = 'proposed'", plan.series_id);
      return { planId: next?.id ?? null, message: next ? "Kiki prepared the update again." : "Nothing to update any more." };
    }
  }
  const r = proposeOrganize(ctx);
  return { planId: r.planId, message: r.message };
}
