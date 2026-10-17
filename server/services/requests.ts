import { randomUUID } from "node:crypto";
import { all, logEvent, now, one, run, tx, type Db, type ItemRow, type RequestRow } from "../db.ts";
import { findDemo } from "../demo.ts";
import { quoteFound, verifyExtraction, type Extraction } from "../domain/extraction.ts";
import { assessRisk, normalizeDomain, type RiskAssessment } from "../domain/risk.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { Extractor } from "../extractor.ts";

export interface StoredExtraction {
  extraction: Extraction;
  requesterEmail: string | null;
  requesterDomain: string | null;
  notes: string[];
}

export function getRequest(db: Db, id: string): RequestRow {
  const row = one<RequestRow>(db, "SELECT * FROM requests WHERE id = ?", id);
  if (!row) throw notFound("That request doesn't exist.");
  return row;
}

export function storedExtraction(row: RequestRow): StoredExtraction | null {
  return row.extraction_json ? (JSON.parse(row.extraction_json) as StoredExtraction) : null;
}

export function storedRisk(row: RequestRow): RiskAssessment | null {
  return row.risk_json ? (JSON.parse(row.risk_json) as RiskAssessment) : null;
}

export function activeItems(db: Db, requestId: string): ItemRow[] {
  return all<ItemRow>(db, "SELECT * FROM checklist_items WHERE request_id = ? AND removed = 0 ORDER BY position", requestId);
}

export function createRequest(
  db: Db,
  extractor: Extractor,
  input: { text?: string; trustedDomain?: string | null; demoKey?: string | null },
): { id: string; work: Promise<void> } {
  const demo = input.demoKey ? findDemo(input.demoKey) : undefined;
  if (input.demoKey && !demo) throw badRequest("Unknown demo input.");
  const text = (demo?.text ?? input.text ?? "").trim();
  if (text.length < 20) throw badRequest("Paste the full request (at least a couple of sentences).");
  if (text.length > 20_000) throw badRequest("That's too long. Paste just the one email.");

  const trustedInput = demo ? demo.trustedDomain : (input.trustedDomain ?? "").trim();
  const trustedDomain = trustedInput ? normalizeDomain(trustedInput) : null;
  if (trustedInput && !trustedDomain) throw badRequest("The trusted domain should look like example.com.");

  const id = randomUUID();
  tx(db, () => {
    run(
      db,
      `INSERT INTO requests (id, created_at, input_kind, demo_key, raw_text, trusted_domain, trusted_source, extraction_status, extraction_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      id,
      now(),
      demo ? "demo" : "pasted",
      demo?.key ?? null,
      text,
      trustedDomain,
      demo ? demo.trustedSource : trustedDomain ? "Entered by you" : null,
      extractor.mode,
    );
    logEvent(db, id, "intake", demo ? `Loaded staged demo input: ${demo.title}.` : "You pasted a document request.");
  });
  return { id, work: runExtraction(db, extractor, id) };
}

export function retryExtraction(db: Db, extractor: Extractor, id: string): Promise<void> {
  const n = run(db, "UPDATE requests SET extraction_status = 'running', extraction_error = NULL, extraction_mode = ? WHERE id = ? AND extraction_status = 'failed'", extractor.mode, id);
  if (n !== 1) throw conflict("Only a failed extraction can be retried.");
  return runExtraction(db, extractor, id);
}

async function runExtraction(db: Db, extractor: Extractor, id: string): Promise<void> {
  const row = getRequest(db, id);
  let extraction: Extraction;
  try {
    extraction = await extractor.extract(row.raw_text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tx(db, () => {
      run(db, "UPDATE requests SET extraction_status = 'failed', extraction_error = ? WHERE id = ?", message, id);
      logEvent(db, id, "extraction_failed", message);
    });
    return;
  }

  const verified = verifyExtraction(row.raw_text, extraction);
  const stored: StoredExtraction = verified;
  const risk = assessRisk({
    rawText: row.raw_text,
    requesterDomain: verified.requesterDomain,
    trustedDomain: row.trusted_domain,
    trustedSource: row.trusted_source,
  });

  tx(db, () => {
    run(db, "DELETE FROM checklist_items WHERE request_id = ? AND origin = 'extracted' AND status = 'not_searched'", id);
    const seen = new Set<string>();
    let position = 0;
    for (const item of verified.extraction.requested_items) {
      const key = item.label.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      run(
        db,
        `INSERT INTO checklist_items (id, request_id, position, label, category, source_quote, quote_found, involves_other_person, origin, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'extracted', ?)`,
        randomUUID(),
        id,
        position++,
        item.label.trim().slice(0, 120),
        item.category,
        item.source_quote,
        quoteFound(row.raw_text, item.source_quote) ? 1 : 0,
        item.involves_another_person ? 1 : 0,
        now(),
      );
    }
    run(
      db,
      "UPDATE requests SET extraction_status = 'ready', extraction_json = ?, extraction_error = NULL, risk_json = ? WHERE id = ?",
      JSON.stringify(stored),
      JSON.stringify(risk),
      id,
    );
    const label = extractor.mode === "mock" ? "Mock extraction" : "Claude";
    logEvent(db, id, "extracted", `${label} read the request: ${seen.size} item${seen.size === 1 ? "" : "s"} for you to review.`);
    if (risk.hasWarnings) logEvent(db, id, "risk", `${risk.signals.filter((s) => s.level === "warning").length} warning sign(s) to review. Sharing is on hold.`);
  });
}

/** Changing the baseline recomputes the signals. A review of different signals doesn't carry over. */
export function setTrustedDomain(db: Db, id: string, domainInput: string): void {
  const row = getRequest(db, id);
  const trusted = domainInput.trim() ? normalizeDomain(domainInput) : null;
  if (domainInput.trim() && !trusted) throw badRequest("The trusted domain should look like example.com.");
  const extraction = storedExtraction(row);
  const before = storedRisk(row);
  const risk = assessRisk({
    rawText: row.raw_text,
    requesterDomain: extraction?.requesterDomain ?? null,
    trustedDomain: trusted,
    trustedSource: trusted ? "Entered by you" : null,
  });
  const signature = (r: RiskAssessment | null) => (r?.signals ?? []).map((s) => `${s.level}:${s.id}`).sort().join("|");
  const changed = signature(before) !== signature(risk);
  tx(db, () => {
    run(
      db,
      `UPDATE requests SET trusted_domain = ?, trusted_source = ?, risk_json = ?,
         risk_reviewed_at = CASE WHEN ? THEN NULL ELSE risk_reviewed_at END,
         risk_review_note = CASE WHEN ? THEN NULL ELSE risk_review_note END
       WHERE id = ?`,
      trusted,
      trusted ? "Entered by you" : null,
      JSON.stringify(risk),
      changed ? 1 : 0,
      changed ? 1 : 0,
      id,
    );
    logEvent(db, id, "baseline", trusted ? `Trusted domain set to ${trusted}.` : "Trusted domain cleared.");
  });
}

/** Records that the user looked at the signals. The signals stay visible; nothing is cleared. */
export function reviewRisk(db: Db, id: string, input: { acknowledge?: boolean; note?: string }): void {
  const row = getRequest(db, id);
  const risk = storedRisk(row);
  if (!risk?.hasWarnings) throw conflict("There are no warning signs to review.");
  if (input.acknowledge !== true) throw badRequest("Confirm that you've reviewed the warning signs.");
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  tx(db, () => {
    run(db, "UPDATE requests SET risk_reviewed_at = ?, risk_review_note = ? WHERE id = ?", now(), note, id);
    logEvent(db, id, "risk_reviewed", "You reviewed the warning signs and chose to continue. The signals are still shown.");
  });
}

export function confirmChecklist(db: Db, id: string, items: { id?: string; label?: string; removed?: boolean }[]): void {
  const row = getRequest(db, id);
  if (row.extraction_status !== "ready") throw conflict("Wait until the request has been read.");
  if (!Array.isArray(items)) throw badRequest("Send the checklist items.");
  tx(db, () => {
    let position = (one<{ p: number | null }>(db, "SELECT MAX(position) AS p FROM checklist_items WHERE request_id = ?", id)?.p ?? -1) + 1;
    for (const item of items) {
      const label = (item.label ?? "").trim().slice(0, 120);
      if (item.id) {
        const existing = one<ItemRow>(db, "SELECT * FROM checklist_items WHERE id = ? AND request_id = ?", item.id, id);
        if (!existing) throw badRequest("A checklist item doesn't belong to this request.");
        if (item.removed) run(db, "UPDATE checklist_items SET removed = 1, updated_at = ? WHERE id = ?", now(), item.id);
        else if (label && label !== existing.label) run(db, "UPDATE checklist_items SET label = ?, updated_at = ? WHERE id = ?", label, now(), item.id);
      } else if (label && !item.removed) {
        run(
          db,
          `INSERT INTO checklist_items (id, request_id, position, label, category, origin, updated_at) VALUES (?, ?, ?, ?, 'other', 'user', ?)`,
          randomUUID(),
          id,
          position++,
          label,
          now(),
        );
      }
    }
    const count = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM checklist_items WHERE request_id = ? AND removed = 0", id)!.n;
    if (count === 0) throw badRequest("The checklist is empty.");
    run(db, "UPDATE requests SET checklist_confirmed_at = ? WHERE id = ?", now(), id);
    logEvent(db, id, "checklist", `You confirmed a checklist of ${count} item${count === 1 ? "" : "s"}.`);
  });
}

export type ItemDecision = "confirm" | "not_it" | "have_it" | "missing";

export function decideItem(db: Db, itemId: string, decision: ItemDecision): void {
  const item = one<ItemRow>(db, "SELECT * FROM checklist_items WHERE id = ? AND removed = 0", itemId);
  if (!item) throw notFound("That checklist item doesn't exist.");
  const next: Record<ItemDecision, { status: ItemRow["status"]; reason: string; from?: ItemRow["status"][] }> = {
    confirm: { status: "confirmed", reason: "You confirmed Fo's match. Paper Chase didn't open the file.", from: ["candidate"] },
    not_it: { status: "needs_review", reason: "You said Fo's match isn't the right document.", from: ["candidate"] },
    have_it: { status: "confirmed", reason: "You marked this as handled." },
    missing: { status: "missing", reason: "You marked this as missing." },
  };
  const rule = next[decision];
  if (!rule) throw badRequest("Unknown decision.");
  if (rule.from && !rule.from.includes(item.status)) throw conflict("That item has changed. Reload and try again.");
  tx(db, () => {
    run(db, "UPDATE checklist_items SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?", rule.status, rule.reason, now(), itemId);
    logEvent(db, item.request_id, "item", `${item.label}: ${rule.reason}`);
  });
}
