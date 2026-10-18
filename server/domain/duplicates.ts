import type { DocFacts } from "./documents.ts";
import { issuerKey } from "./safety.ts";

/** Where Kiki sets aside exact copies, next to the copy she keeps. Nothing is ever deleted. */
export const DUPLICATES_FOLDER = "Duplicates";

const MD5 = /^[0-9a-f]{32}$/i;

export interface CopyCandidate {
  docId: string;
  fileId: string;
  name: string;
  /** Folder path relative to the workspace root ("" = top level). */
  path: string;
  /** Drive's MD5 of the content when it has one; anything else (a modified time) proves nothing. */
  contentKey: string | null;
  createdTime: string | null;
}

export const inDuplicatesFolder = (path: string) => path.split("/").includes(DUPLICATES_FOLDER);
const numbered = (name: string) => /\s\(\d+\)(\.[A-Za-z0-9]{1,5})?$/.test(name);

/** The copy to keep: not already set aside, not a "(2)" name, the oldest, then a stable tiebreak. */
function keeperOrder(a: CopyCandidate, b: CopyCandidate): number {
  return (
    Number(inDuplicatesFolder(a.path)) - Number(inDuplicatesFolder(b.path)) ||
    Number(numbered(a.name)) - Number(numbered(b.name)) ||
    (a.createdTime ?? "").localeCompare(b.createdTime ?? "") ||
    a.fileId.localeCompare(b.fileId)
  );
}

/** Byte-identical files (same MD5). Each group lists the copy to keep first. */
export function exactCopies<T extends CopyCandidate>(docs: T[]): { keep: T; copies: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const d of docs) {
    if (!d.contentKey || !MD5.test(d.contentKey)) continue;
    const k = d.contentKey.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const [keep, ...copies] = [...g].sort(keeperOrder);
      return { keep: keep!, copies };
    });
}

/** docId of each extra copy -> docId of the copy Kiki keeps. */
export function copyMap(docs: CopyCandidate[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of exactCopies(docs)) for (const c of g.copies) out.set(c.docId, g.keep.docId);
  return out;
}

const norm = (s: string | null | undefined) => (s ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

/**
 * Different files that read as the same document: same type, issuer, reference, date and total.
 * Only pointed out, never moved: one of them might be a signed copy worth keeping.
 */
export function sameDocumentKey(f: DocFacts): string | null {
  const who = issuerKey(f.issuer.value);
  if (!who || !f.reference.value) return null;
  return [f.docType, who, norm(f.reference.value), f.date.value ?? "", f.total.value ?? ""].join("|");
}
