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
    .replace(/\s*:\s+/g, " - ")
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
/** Words that only say what kind of document it is. A heading made of nothing else isn't a title. */
const GENERIC_TITLE_WORDS = new Set(
  "quote quotation estimate invoice bill receipt permit building licence license business contract agreement service notes note meeting minutes report research assignment presentation deck slides spreadsheet sheet correspondence letter memo itinerary trip travel document statement revised revision final copy draft original tax the a an of and for".split(" "),
);

/**
 * A stated title worth naming a file after. A heading that only repeats the document's type
 * ("QUOTE", "ESTIMATE / QUOTE", "BUSINESS LICENCE") isn't one; anything specific is ("Induction
 * and invariants", "Assignment 4").
 */
export function meaningfulTitle(title: string | null | undefined): string | null {
  const t = title?.trim();
  if (!t) return null;
  if (/\d/.test(t)) return t;
  const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.length > 0 && words.every((w) => GENERIC_TITLE_WORDS.has(w)) ? null : t;
}

/** A long title cut at its last clause break that fits ("2026 Property Assessment - 12 Cedar Lane"), else after a whole word, marked "…". */
function shortTitle(title: string, max = 60): string {
  if (title.length <= max) return title;
  const head = title.slice(0, max);
  const clause = Math.max(...[" - ", ", ", ": ", "; "].map((s) => head.lastIndexOf(s)));
  if (clause >= 20) return head.slice(0, clause);
  return `${(/\s/.test(title[max]!) ? head : head.replace(/\s+\S*$/, "")).trimEnd()}…`;
}

const PERSONAL_ID =
  /\b(driver'?s'?\s*licen[cs]e|driving\s*licen[cs]e|passport|health\s*(insurance\s*)?card|social\s*insurance|social\s*security|\bSIN\b|\bSSN\b|identity\s*card|\bID\s*card|photo\s*card|birth\s*certificate|permanent\s*resident|citizenship\s*card|national\s*id)\b/i;

/**
 * A personal ID document (a driver's licence, passport, health card, SIN card…). Its number never
 * goes into a file name, the index or a text: those travel further than the document does.
 */
export function isPersonalId(facts: DocFacts | null, name = ""): boolean {
  return PERSONAL_ID.test([facts?.title?.value, facts?.issuer?.value, name].filter(Boolean).join(" "));
}

/** Without any number run of 4+ digits (or the document's reference): for a personal ID's title or name. */
export function withoutIdNumbers(s: string, reference?: string | null): string {
  let out = reference ? s.split(reference).join(" ") : s;
  if (reference) for (const part of reference.split(/[\s-]+/).filter((p) => p.length >= 3)) out = out.split(part).join("");
  return out
    .replace(/[A-Z]?\d[\d\s-]{3,}\d/gi, "")
    .replace(/(\s*-\s*){2,}/g, " - ")
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function proposedName(facts: DocFacts, originalName: string, mimeType: string): string | null {
  const date = facts.date.value;
  const issuer = facts.issuer.value;
  const personal = isPersonalId(facts, originalName);
  const stated = meaningfulTitle(facts.title?.value);
  const title = stated && personal ? withoutIdNumbers(stated, facts.reference.value) || null : stated;
  if (!date && !issuer && !title) return null;
  const label = facts.docType === "quote" && facts.revision.isRevision ? "Revised quote" : TYPE_LABELS[facts.docType];
  const short = title ? shortTitle(title) : null;
  const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // A reference already in the (shortened) title isn't repeated.
  const reference = !personal && facts.reference.value && !(short && key(short).includes(key(facts.reference.value))) ? facts.reference.value : null;
  const parts = [short || label, issuer, reference].filter((p): p is string => Boolean(p));
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
