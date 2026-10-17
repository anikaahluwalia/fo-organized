import { all, type Db, type DocumentRow, type FileRow, type ProjectRow } from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { join } from "../domain/plan.ts";
import { money } from "../domain/reconcile.ts";

const STATUS_LABEL: Record<string, string> = {
  current: "Current (identified)",
  superseded: "Superseded",
  unresolved: "Not yet confirmed",
  proposed: "Proposed",
};

function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface IndexRow {
  doc: DocumentRow;
  file: FileRow;
  facts: DocFacts;
  latestReceived: boolean;
}

/** Documents of a project, with "latest received" computed per contractor for quotes. */
export function projectIndexRows(db: Db, project: ProjectRow): IndexRow[] {
  const rows = all<DocumentRow & { f_name: string; f_path: string }>(
    db,
    `SELECT d.*, f.name AS f_name, f.path AS f_path FROM documents d
       JOIN files f ON f.workspace_id = d.workspace_id AND f.file_id = d.file_id
     WHERE d.project_id = ? AND d.read_status = 'read' AND f.present = 1`,
    project.id,
  );
  const files = new Map(all<FileRow>(db, "SELECT * FROM files WHERE workspace_id = ? AND present = 1", project.workspace_id).map((f) => [f.file_id, f]));
  const out: IndexRow[] = rows.map((r) => ({ doc: r, file: files.get(r.file_id)!, facts: JSON.parse(r.facts_json!) as DocFacts, latestReceived: false }));
  const newest = new Map<string, IndexRow>();
  for (const row of out.filter((r) => r.facts.docType === "quote")) {
    const key = (row.facts.issuer.value ?? "").toLowerCase();
    const prev = newest.get(key);
    const stamp = (r: IndexRow) => r.file.created_time ?? r.facts.date.value ?? "";
    if (!prev || stamp(row) > stamp(prev)) newest.set(key, row);
  }
  for (const row of newest.values()) row.latestReceived = true;
  const order = ["quote", "invoice", "receipt", "contract", "permit", "licence", "other", "unknown"];
  return out.sort((a, b) => order.indexOf(a.facts.docType) - order.indexOf(b.facts.docType) || (a.facts.date.value ?? "").localeCompare(b.facts.date.value ?? ""));
}

/** The index file Kiki keeps in Drive: one row per document, from verified facts and locations. */
export function buildIndexCsv(db: Db, project: ProjectRow, verifiedAt: string): string {
  const header = ["Type", "Status", "Contractor or supplier", "Reference", "Date", "Total", "Accepted by you", "File name", "Folder", "Notes"];
  const lines = [header.map(csvCell).join(",")];
  for (const row of projectIndexRows(db, project)) {
    const f = row.facts;
    const notes = [row.latestReceived && f.docType === "quote" ? "Latest received from this contractor" : null, f.revision.isRevision ? (f.revision.label ?? "Revision") : null].filter(Boolean).join("; ");
    lines.push(
      [
        f.docType,
        f.docType === "quote" ? (STATUS_LABEL[row.doc.version_status ?? "unresolved"] ?? row.doc.version_status) : "",
        f.issuer.value,
        f.reference.value,
        f.date.value,
        f.total.value === null ? "" : money(f.total.value, f.total.currency),
        row.doc.accepted_at ? `Yes (${row.doc.accepted_at.slice(0, 10)})` : "",
        row.file.name,
        join(row.file.path, "").replace(/\/$/, "") || "(workspace folder)",
        notes,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  lines.push("", csvCell(`Kept by Kiki (Fo-rganized). Last updated from verified Drive state at ${verifiedAt}. Edits here aren't read back; change things in the app.`));
  return `${lines.join("\r\n")}\r\n`;
}
