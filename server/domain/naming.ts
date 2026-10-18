import { normalizeProject, type DocFacts, type DocType } from "./documents.ts";

export const CATEGORY = "Projects";
export const SUPERSEDED_FOLDER = "Superseded";

const TYPE_FOLDERS: Record<DocType, string | null> = {
  quote: "Quotes",
  invoice: "Invoices",
  receipt: "Receipts",
  permit: "Permits and licences",
  licence: "Permits and licences",
  contract: "Contracts",
  notes: "Notes",
  report: "Reports",
  research: "Research",
  assignment: "Assignments",
  presentation: "Presentations",
  spreadsheet: "Spreadsheets",
  correspondence: "Correspondence",
  itinerary: "Itineraries",
  other: "Other documents",
  unknown: null,
};

const TYPE_LABELS: Record<DocType, string> = {
  quote: "Quote",
  invoice: "Invoice",
  receipt: "Receipt",
  permit: "Permit",
  licence: "Licence",
  contract: "Contract",
  notes: "Notes",
  report: "Report",
  research: "Research",
  assignment: "Assignment",
  presentation: "Presentation",
  spreadsheet: "Spreadsheet",
  correspondence: "Correspondence",
  itinerary: "Itinerary",
  other: "Document",
  unknown: "Document",
};

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

export function projectFolderPath(project: string, files: { name: string; path: string; isFolder: boolean; isShortcut: boolean }[] = []): string {
  const safe = normalizeProject(project);
  if (!safe) throw new Error("Project name must be a safe, nonempty folder name.");
  // Reuse an existing legacy project folder; upgrading Kiki must not propose relocating it.
  const legacy = files.some((f) => f.isFolder && !f.isShortcut && f.path === "Renovations" && f.name === safe);
  const current = files.some((f) => f.isFolder && !f.isShortcut && f.path === CATEGORY && f.name === safe);
  return `${legacy && !current ? "Renovations" : CATEGORY}/${safe}`;
}

/** Where a document belongs, or null when Kiki can't tell (unknown type or no project). */
export function targetFolder(facts: DocFacts, files: Parameters<typeof projectFolderPath>[1] = []): string | null {
  const project = normalizeProject(facts.project.value);
  const typeFolder = TYPE_FOLDERS[facts.docType];
  if (!project || !typeFolder) return null;
  return `${projectFolderPath(project, files)}/${typeFolder}`;
}

export function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function extension(originalName: string, mimeType: string): string {
  if (mimeType.startsWith("application/vnd.google-apps.")) return "";
  const own = /\.[A-Za-z0-9]{2,5}$/.exec(originalName)?.[0];
  return own ? own.toLowerCase() : (EXTENSIONS[mimeType] ?? "");
}

/**
 * A readable filename built only from verified facts: "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf".
 * Missing facts are left out, never invented. Returns null when there's too little to go on.
 */
export function proposedName(facts: DocFacts, originalName: string, mimeType: string): string | null {
  const date = facts.date.value;
  const issuer = facts.issuer.value;
  const title = facts.title?.value;
  if (!date && !issuer && !title) return null;
  const label = facts.docType === "quote" && facts.revision.isRevision ? "Revised quote" : TYPE_LABELS[facts.docType];
  const parts = [title || label, issuer, facts.reference.value].filter((p): p is string => Boolean(p));
  const base = `${date ? `${date} ` : ""}${parts.join(" - ")}`;
  return sanitizeName(base) + extension(originalName, mimeType);
}

/** "Quote.pdf" -> "Quote (2).pdf" when the name is already taken in the destination. */
export function deduplicateName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const m = /^(.*?)(\.[A-Za-z0-9]{2,5})?$/.exec(name)!;
  for (let n = 2; n < 100; n++) {
    const candidate = `${m[1]} (${n})${m[2] ?? ""}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${m[1]} (${Date.now()})${m[2] ?? ""}`;
}

export function indexFileName(project: string): string {
  return `${project} - document index (kept by Kiki).csv`;
}
