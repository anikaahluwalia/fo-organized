import type { DocFacts, DocType } from "./documents.ts";
import { money } from "./reconcile.ts";
import { issuerKey } from "./safety.ts";
import { sameDocumentKey } from "./duplicates.ts";

/**
 * Things in the folder that need a person's look: a document others refer to that isn't there,
 * dates running out, or quotes where it isn't clear which one counts. Every item comes from facts
 * Kiki read, with the line that supports it; nothing here changes anything.
 */
export type AttentionKind = "missing" | "expired" | "which_current" | "duplicate" | "expiring" | "undecided" | "unreadable";

export interface AttentionDoc {
  docId: string;
  fileName: string;
  project: string | null;
  readStatus: string;
  readError: string | null;
  facts: DocFacts | null;
  versionStatus: string | null;
  acceptedAt: string | null;
}

export interface AttentionItem {
  /** Stable while the situation is the same, so "Got it" sticks until something changes. */
  key: string;
  kind: AttentionKind;
  project: string | null;
  title: string;
  detail: string | null;
  evidence: string | null;
  docIds: string[];
  /** A quote the user could ask the contractor about. */
  askDocId: string | null;
}

const WORD: Record<DocType, string> = {
  quote: "Quote",
  invoice: "Invoice",
  receipt: "Receipt",
  permit: "Permit",
  licence: "Licence",
  contract: "Contract",
  other: "Document",
  unknown: "Document",
};

const norm = (s: string | null | undefined) => (s ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

function label(d: AttentionDoc): string {
  const f = d.facts!;
  return `${WORD[f.docType]} ${f.reference.value ?? `"${d.fileName}"`}${f.issuer.value ? ` from ${f.issuer.value}` : ""}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

const inDays = (n: number) => (n === 0 ? "That's today." : n === 1 ? "That's tomorrow." : `That's in ${n} days.`);

/** How far ahead a date is worth mentioning. */
const WINDOW_DAYS: Partial<Record<DocType, number>> = { quote: 14, licence: 90, permit: 90, contract: 60 };

const ORDER: AttentionKind[] = ["missing", "expired", "which_current", "duplicate", "expiring", "undecided", "unreadable"];

export function findAttention(input: { today: string; docs: AttentionDoc[]; busyDocIds: Set<string> }): AttentionItem[] {
  const items: AttentionItem[] = [];
  const all = input.docs.filter((d): d is AttentionDoc & { facts: DocFacts } => d.readStatus === "read" && d.facts !== null);

  // Different files that read as the same document. Pointed out, never moved: one may be a signed copy.
  const alike = new Map<string, (AttentionDoc & { facts: DocFacts })[]>();
  for (const d of all) {
    const k = sameDocumentKey(d.facts);
    if (k) alike.set(k, [...(alike.get(k) ?? []), d]);
  }
  const shadowed = new Set<string>();
  for (const group of alike.values()) {
    if (group.length < 2) continue;
    for (const d of group.slice(1)) shadowed.add(d.docId);
    items.push({
      key: `duplicate:${group.map((d) => d.docId).sort().join(",")}`,
      kind: "duplicate",
      project: group[0]!.project,
      title: `${group.length} files look like the same ${label(group[0]!)}`,
      detail: `${group.map((d) => `"${d.fileName}"`).join(" and ")} have the same reference, date and total, but their content differs. If one is a signed copy, keep both; otherwise you can remove the extra one in Drive.`,
      evidence: null,
      docIds: group.map((d) => d.docId),
      askDocId: null,
    });
  }
  // Everything below looks at each document once.
  const read = all.filter((d) => !shadowed.has(d.docId));
  const quotes = read.filter((d) => d.facts.docType === "quote" && d.versionStatus !== "superseded");

  // A document others name that isn't in the folder (one item per missing reference).
  const present = new Set(all.map((d) => norm(d.facts.reference.value)).filter(Boolean));
  const replaced = new Set(all.map((d) => norm(d.facts.revision.revisesReference)).filter(Boolean));
  const missing = new Map<string, { docType: DocType; reference: string; quote: string | null; by: (AttentionDoc & { facts: DocFacts })[] }>();
  for (const d of read) {
    for (const r of d.facts.refersTo ?? []) {
      const k = norm(r.reference);
      // A revision naming the quote it replaces is history, not a gap.
      if (!k || k === norm(d.facts.reference.value) || k === norm(d.facts.revision.revisesReference)) continue;
      if (present.has(k) || replaced.has(k)) continue;
      const entry = missing.get(k) ?? { docType: r.docType, reference: r.reference, quote: r.quote, by: [] };
      if (!entry.by.includes(d)) entry.by.push(d);
      missing.set(k, entry);
    }
  }
  for (const [k, m] of missing) {
    items.push({
      key: `missing:${k}`,
      kind: "missing",
      project: m.by[0]!.project,
      title: `${WORD[m.docType]} ${m.reference} isn't in the folder`,
      detail: m.by.length === 1 ? `${label(m.by[0]!)} refers to it.` : sentence(`${m.by.length} documents refer to it: ${m.by.map(label).join("; ")}`),
      evidence: m.quote,
      docIds: m.by.map((d) => d.docId),
      askDocId: null,
    });
  }

  // Dates running out. A superseded quote, or one in a project where you've accepted a price, doesn't need it.
  const acceptedProjects = new Set(quotes.filter((q) => q.acceptedAt).map((q) => q.project ?? ""));
  for (const d of read) {
    const until = d.facts.validUntil?.value;
    if (!until || d.versionStatus === "superseded" || input.busyDocIds.has(d.docId)) continue;
    const isQuote = d.facts.docType === "quote";
    if (isQuote && acceptedProjects.has(d.project ?? "")) continue;
    const days = daysBetween(input.today, until);
    const evidence = d.facts.validUntil!.quote;
    const counted = d.facts.validUntil!.basis === "days" && d.facts.date.value ? `Counted from its date, ${d.facts.date.value}.` : null;
    if (days < 0) {
      items.push({
        key: `expired:${d.docId}:${until}`,
        kind: "expired",
        project: d.project,
        title: `${label(d)} expired on ${until}`,
        detail: [counted, isQuote ? "The price may have changed; you could ask the contractor if it still stands." : "It may need renewing."].filter(Boolean).join(" "),
        evidence,
        docIds: [d.docId],
        askDocId: isQuote ? d.docId : null,
      });
    } else if (days <= (WINDOW_DAYS[d.facts.docType] ?? 30)) {
      items.push({
        key: `expiring:${d.docId}:${until}`,
        kind: "expiring",
        project: d.project,
        title: `${label(d)} is valid until ${until}`,
        detail: [inDays(days), counted].filter(Boolean).join(" "),
        evidence,
        docIds: [d.docId],
        askDocId: isQuote ? d.docId : null,
      });
    }
  }

  // Several quotes from one contractor for one project, and none identified as current.
  const byContractor = new Map<string, (AttentionDoc & { facts: DocFacts })[]>();
  for (const q of quotes) {
    const who = issuerKey(q.facts.issuer.value);
    if (!who) continue;
    const k = `${q.project ?? ""}|${who}`;
    byContractor.set(k, [...(byContractor.get(k) ?? []), q]);
  }
  for (const group of byContractor.values()) {
    if (group.length < 2 || group.some((q) => q.versionStatus === "current" || input.busyDocIds.has(q.docId))) continue;
    const sorted = [...group].sort((a, b) => (a.facts.date.value ?? "").localeCompare(b.facts.date.value ?? ""));
    const latest = sorted[sorted.length - 1]!;
    items.push({
      key: `which_current:${sorted.map((q) => q.docId).join(",")}`,
      kind: "which_current",
      project: latest.project,
      title: `${group.length} quotes from ${latest.facts.issuer.value}${latest.project ? ` for ${latest.project}` : ""}, and none is marked current`,
      detail: sorted.map((q) => [q.facts.reference.value ?? q.fileName, q.facts.date.value, q.facts.total.value === null ? null : money(q.facts.total.value, q.facts.total.currency)].filter(Boolean).join(", ")).join(" · "),
      evidence: null,
      docIds: sorted.map((q) => q.docId),
      askDocId: latest.docId,
    });
  }

  // Quotes from different contractors for one project, and no price accepted yet.
  const byProject = new Map<string, (AttentionDoc & { facts: DocFacts })[]>();
  for (const q of quotes) if (q.project) byProject.set(q.project, [...(byProject.get(q.project) ?? []), q]);
  for (const [project, group] of byProject) {
    const contractors = new Set(group.map((q) => issuerKey(q.facts.issuer.value)).filter(Boolean));
    if (contractors.size < 2 || group.some((q) => q.acceptedAt)) continue;
    const sorted = [...group].sort((a, b) => (a.facts.issuer.value ?? "").localeCompare(b.facts.issuer.value ?? ""));
    // An invoice for one of them is worth pointing out, but only you decide what was accepted.
    const invoiced = sorted.filter((q) => read.some((d) => d.facts.docType === "invoice" && (d.facts.refersTo ?? []).some((r) => norm(r.reference) === norm(q.facts.reference.value))));
    items.push({
      key: `undecided:${project}:${sorted.map((q) => q.docId).join(",")}`,
      kind: "undecided",
      project,
      title: `${project}: quotes from ${contractors.size} contractors, and no price is accepted yet`,
      detail: `${sorted.map((q) => `${q.facts.issuer.value ?? "Unknown"} ${q.facts.total.value === null ? "" : money(q.facts.total.value, q.facts.total.currency)} (${q.facts.reference.value ?? q.fileName})`.replace(/\s+\(/, " (")).join(" · ")}.${
        invoiced.length === 1 ? ` There's already an invoice for ${invoiced[0]!.facts.reference.value}.` : ""
      } Mark the one you went with as accepted.`,
      evidence: null,
      docIds: sorted.map((q) => q.docId),
      askDocId: null,
    });
  }

  for (const d of input.docs) {
    if (d.readStatus !== "unreadable" && d.readStatus !== "failed") continue;
    items.push({
      key: `unreadable:${d.docId}:${d.readError ?? ""}`,
      kind: "unreadable",
      project: d.project,
      title: `Kiki couldn't read "${d.fileName}"`,
      detail: d.readError,
      evidence: null,
      docIds: [d.docId],
      askDocId: null,
    });
  }

  const when = (i: AttentionItem) => (i.kind === "expiring" || i.kind === "expired" ? (i.key.split(":")[2] ?? "") : "");
  return items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || when(a).localeCompare(when(b)));
}
