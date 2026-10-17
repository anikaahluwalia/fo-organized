import { randomUUID } from "node:crypto";
import { logEvent, now, one, run, tx, type Db, type FoTaskRow, type InventoryRunRow } from "../db.ts";
import { buildInventoryMessage, parseInventoryReply, searchableItems, type SearchItem } from "../domain/inventory.ts";
import { looksLikeQuestion, newReference } from "../domain/outreach.ts";
import { badRequest, conflict } from "../errors.ts";
import { insertTask, type FoEngine, type TaskHandler } from "../fo/engine.ts";
import { activeItems, getRequest } from "./requests.ts";

export function runForTask(db: Db, taskId: string): InventoryRunRow | undefined {
  return one<InventoryRunRow>(db, "SELECT * FROM inventory_runs WHERE fo_task_id = ?", taskId);
}

export function latestRun(db: Db, requestId: string): InventoryRunRow | undefined {
  return one<InventoryRunRow>(db, "SELECT * FROM inventory_runs WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", requestId);
}

/**
 * Starts a read-only Drive check through Fo for the confirmed checklist. Idempotent per
 * clientRequestId, and only one search per request can be open at a time.
 */
export function startInventory(db: Db, engine: FoEngine, requestId: string, clientRequestId: string): { runId: string; created: boolean; work: Promise<void> } {
  if (!clientRequestId || clientRequestId.length > 100) throw badRequest("Missing request id.");
  const request = getRequest(db, requestId);
  if (!request.checklist_confirmed_at) throw conflict("Confirm the checklist before searching.");
  const items = searchableItems(activeItems(db, requestId));
  if (items.length === 0) throw conflict("Nothing on the checklist can be searched for.");

  const result = tx(db, () => {
    const same = one<InventoryRunRow>(db, "SELECT * FROM inventory_runs WHERE client_request_id = ?", clientRequestId);
    if (same) return { runId: same.id, created: false, taskId: same.fo_task_id, reference: same.reference };
    const open = one<InventoryRunRow>(db, "SELECT * FROM inventory_runs WHERE request_id = ? AND open = 1", requestId);
    if (open) return { runId: open.id, created: false, taskId: open.fo_task_id, reference: open.reference };
    const taskId = insertTask(db, "inventory", engine.mode);
    const runId = randomUUID();
    const reference = newReference("PC-INV");
    run(
      db,
      "INSERT INTO inventory_runs (id, request_id, fo_task_id, client_request_id, reference, search_items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      runId,
      requestId,
      taskId,
      clientRequestId,
      reference,
      JSON.stringify(items),
      now(),
    );
    logEvent(db, requestId, "inventory", `Asked ${engine.mode === "mock" ? "Mock Fo" : "Fo"} to check your Drive for ${items.length} item${items.length === 1 ? "" : "s"}, read-only.`);
    return { runId, created: true, taskId, reference };
  });
  const work = result.created ? engine.start(result.taskId, buildInventoryMessage(items, result.reference)) : Promise.resolve();
  return { runId: result.runId, created: result.created, work };
}

export function inventoryReplyMessage(answer: string, reference: string): string {
  return `Answer from the user about Paper Chase document check ${reference}:

${answer.trim()}

Reminder: this is still read-only. Don't modify, move, share or send anything. Reply in the JSON format from my first message.`;
}

export function inventoryHandler(db: Db): TaskHandler {
  return {
    onComplete(task: FoTaskRow, response: string) {
      const runRow = runForTask(db, task.id);
      if (!runRow) return { question: null };
      const items = JSON.parse(runRow.search_items_json) as SearchItem[];
      const parsed = parseInventoryReply(response, items);
      // Fo answered with a question instead of results: put it to the user.
      if (parsed.parseStatus === "malformed" && looksLikeQuestion(response)) return { question: response };

      for (const result of parsed.results) {
        // A document the user already confirmed keeps the user's decision.
        run(
          db,
          `UPDATE checklist_items SET status = ?, status_reason = ?, candidates_json = ?, updated_at = ?
           WHERE id = ? AND status <> 'confirmed'`,
          result.status,
          result.reason,
          result.candidates.length ? JSON.stringify(result.candidates) : null,
          now(),
          result.itemId,
        );
      }
      run(db, "UPDATE inventory_runs SET parse_status = ?, parse_notes = ?, open = 0 WHERE id = ?", parsed.parseStatus, JSON.stringify(parsed.notes), runRow.id);
      const counts = (s: string) => parsed.results.filter((r) => r.status === s).length;
      logEvent(
        db,
        runRow.request_id,
        "inventory",
        parsed.parseStatus === "malformed"
          ? "Fo's reply couldn't be read reliably, so every item needs your review."
          : `${task.mode === "mock" ? "Mock Fo" : "Fo"} reported ${counts("candidate")} possible match(es), ${counts("missing")} missing, ${counts("needs_review")} to review.`,
      );
      return { question: null };
    },
    onStateChange(task: FoTaskRow) {
      const runRow = runForTask(db, task.id);
      if (!runRow || !runRow.open) return;
      if (task.state === "failed" || task.state === "uncertain") {
        // Read-only, so an unfinished search simply closes; the user can search again.
        run(db, "UPDATE inventory_runs SET open = 0 WHERE id = ?", runRow.id);
        logEvent(db, runRow.request_id, "inventory", `The Drive check didn't finish: ${task.failure_detail ?? "no details"}`);
      }
    },
  };
}
