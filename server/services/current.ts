import { all, logEvent, one, type DocumentRow, type FileRow, type ProjectRow } from "../db.ts";
import { copyMap } from "../domain/duplicates.ts";
import { buildConfirmCurrentPlan, buildVersionUpdatePlan } from "../domain/plan.ts";
import { diffQuotes, money } from "../domain/reconcile.ts";
import { issuerKey } from "../domain/safety.ts";
import { conflict, notFound } from "../errors.ts";
import type { Ctx } from "./context.ts";
import { indexFiles, planDoc, planFiles, refreshOrganizeProposal, savePlanVersion } from "./plans.ts";
import { docFacts, requireWorkspace } from "./workspace.ts";

/**
 * You know which quote is the current one: Kiki prepares the same reviewed change a contractor's
 * answer would (record it as current, move that contractor's earlier quote to Superseded, update
 * the index), with "you said so" as the evidence. Nothing changes in Drive until you approve it,
 * and marking a quote current never accepts its price.
 */
export function proposeMarkCurrent(ctx: Ctx, docId: string): { planId: string } {
  const ws = requireWorkspace(ctx.db);
  const doc = one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ? AND workspace_id = ?", docId, ws.id);
  const facts = doc ? docFacts(doc) : null;
  if (!doc || !facts || doc.doc_type !== "quote") throw notFound("That quote isn't in the index.");
  if (doc.version_status === "current") throw conflict("That quote is already marked current.");
  if (doc.version_status === "superseded") throw conflict("That quote was superseded. Undo that update first if it was a mistake.");
  const project = (doc.project_id ? one<ProjectRow>(ctx.db, "SELECT * FROM projects WHERE id = ?", doc.project_id)?.name : null) ?? facts.project.value;
  if (!project) throw conflict("Kiki doesn't know which project this quote belongs to yet, so it can't be marked current.");

  // That contractor's other quotes for the project (an exact copy is the same quote, not another one).
  const files = new Map(all<FileRow>(ctx.db, "SELECT * FROM files WHERE workspace_id = ? AND present = 1", ws.id).map((f) => [f.file_id, f]));
  const quotes = all<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE workspace_id = ? AND read_status = 'read' AND doc_type = 'quote' AND project_id IS ?", ws.id, doc.project_id).filter(
    (d) => files.has(d.file_id),
  );
  const copies = copyMap(quotes.map((d) => ({ docId: d.id, fileId: d.file_id, name: files.get(d.file_id)!.name, path: files.get(d.file_id)!.path, contentKey: files.get(d.file_id)!.version, createdTime: files.get(d.file_id)!.created_time })));
  const who = issuerKey(facts.issuer.value);
  const others = quotes.filter(
    (d) => d.id !== doc.id && !copies.has(d.id) && copies.get(doc.id) !== d.id && d.version_status !== "superseded" && who !== null && issuerKey(docFacts(d)?.issuer.value) === who,
  );
  // The one it replaces: the quote currently marked current, else the latest one.
  const old = [...others].sort((a, b) => Number(b.version_status === "current") - Number(a.version_status === "current") || (docFacts(b)?.date.value ?? "").localeCompare(docFacts(a)?.date.value ?? ""))[0];

  const ref = facts.reference.value ?? "this quote";
  const statement = `You said ${ref} is the current quote.`;
  const base = { rootId: ws.root_file_id, files: planFiles(ctx.db, ws.id), project, indexFile: indexFiles(ctx.db, ws.id)[project] ?? null, sourceLabel: "You", statement };
  let planId: string;
  if (!old) {
    const draft = buildConfirmCurrentPlan({ ...base, doc: planDoc(doc), evidence: { source: "You", statement, sourceKind: "user", interpreter: null } });
    planId = savePlanVersion(ctx.db, ws, {
      kind: "version_update",
      seriesId: `version:${doc.id}:${doc.id}`,
      title: `Mark ${ref} as the current ${project.toLowerCase()} quote`,
      summary: "You said this quote is current. Recording it as current doesn't accept its price.",
      draft,
      details: { notes: [], evidence: { source: "You", statement }, oldDocumentId: doc.id, newDocumentId: doc.id },
      source: { markedBy: "user" },
    }).plan.id;
  } else {
    const oldFacts = docFacts(old)!;
    const diff = diffQuotes(oldFacts, facts);
    const evidence = { source: "You", sourceKind: "user", statement, interpreter: null, candidateReasons: [], diff };
    const draft = buildVersionUpdatePlan({ ...base, oldDoc: planDoc(old), newDoc: planDoc(doc), evidence });
    planId = savePlanVersion(ctx.db, ws, {
      kind: "version_update",
      seriesId: `version:${old.id}:${doc.id}`,
      title: `Make ${ref} the current ${project.toLowerCase()} quote`,
      summary: `Mark ${ref} as current and keep ${oldFacts.reference.value ?? "the earlier quote"} as superseded.${diff.total?.delta ? ` The total changes by ${diff.total.delta > 0 ? "+" : ""}${money(diff.total.delta)}.` : ""}`,
      draft,
      details: {
        notes: draft.notes,
        diff,
        evidence,
        conflict: old.version_status === "current" ? `${oldFacts.reference.value ?? "Another quote"} from ${oldFacts.issuer.value ?? "this contractor"} is marked current now; this would change that.` : null,
        oldDocumentId: old.id,
        newDocumentId: doc.id,
      },
      source: { markedBy: "user" },
    }).plan.id;
  }
  logEvent(ctx.db, ws.id, "current", `You said ${ref} is the current quote. Kiki prepared the change for your approval.`);
  // The update owns the files it moves; the regular filing proposal lets go of them.
  refreshOrganizeProposal(ctx);
  return { planId };
}
