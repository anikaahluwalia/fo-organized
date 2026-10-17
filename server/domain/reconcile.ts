import type { DocFacts } from "./documents.ts";
import { issuerKey } from "./safety.ts";

export interface VersionDoc {
  docId: string;
  fileId: string;
  name: string;
  facts: DocFacts;
  createdTime: string | null;
  versionStatus: string | null;
}

export interface Candidate {
  docId: string;
  fileId: string;
  name: string;
  score: number;
  reasons: string[];
}

const ref = (s: string | null | undefined) => (s ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : null);

/**
 * Quotes that could be "the revised quote". Every plausible match is returned with its reasons;
 * the caller asks the user whenever there is more than one. A different contractor's quote is
 * never a candidate.
 */
export function findRevisionCandidates(asked: VersionDoc, docs: VersionDoc[], since: string | null): Candidate[] {
  const askedIssuer = issuerKey(asked.facts.issuer.value);
  const askedRef = ref(asked.facts.reference.value);
  const out: Candidate[] = [];
  for (const d of docs) {
    if (d.docId === asked.docId || d.facts.docType !== "quote" || d.versionStatus === "superseded") continue;
    const issuer = issuerKey(d.facts.issuer.value);
    if (issuer && askedIssuer && issuer !== askedIssuer) continue;
    let score = 0;
    const reasons: string[] = [];
    if (issuer && issuer === askedIssuer) {
      score += 3;
      reasons.push(`From the same contractor (${d.facts.issuer.value}).`);
    }
    if (d.facts.project.value && d.facts.project.value === asked.facts.project.value) {
      score += 1;
      reasons.push(`About ${d.facts.project.value.toLowerCase()}.`);
    }
    if (askedRef && ref(d.facts.revision.revisesReference) === askedRef) {
      score += 3;
      reasons.push(`Says it replaces ${asked.facts.reference.value}${d.facts.revision.quote ? ` ("${d.facts.revision.quote}")` : ""}.`);
    } else if (askedRef && ref(d.facts.reference.value)?.startsWith(askedRef)) {
      score += 1;
      reasons.push(`Its reference (${d.facts.reference.value}) builds on ${asked.facts.reference.value}.`);
    }
    if (d.facts.revision.isRevision) {
      score += 1;
      reasons.push("Marked as a revision.");
    }
    if (d.facts.date.value && asked.facts.date.value) {
      if (d.facts.date.value > asked.facts.date.value) {
        score += 1;
        reasons.push(`Dated ${d.facts.date.value}, after the original (${asked.facts.date.value}).`);
      } else if (d.facts.date.value < asked.facts.date.value) {
        score -= 2;
        reasons.push(`Dated ${d.facts.date.value}, before the original.`);
      }
    }
    if (since && d.createdTime && d.createdTime >= since) {
      score += 2;
      reasons.push("Arrived in the workspace after Fo asked.");
    }
    if (score >= 4) out.push({ docId: d.docId, fileId: d.fileId, name: d.name, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export interface QuoteDiff {
  total: { from: number | null; to: number | null; delta: number | null; currency: string | null; fromQuote: string | null; toQuote: string | null } | null;
  changed: { from: string; to: string; fromAmount: number | null; toAmount: number | null }[];
  added: { description: string; amount: number | null }[];
  removed: { description: string; amount: number | null }[];
  scope: { from: string | null; to: string | null } | null;
  lines: string[];
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1));

function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
}

export function money(n: number | null, currency: string | null = null): string {
  if (n === null) return "unknown";
  const s = `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${n < 0 ? "-" : ""}${s}${currency && currency !== "CAD" && currency !== "USD" ? ` ${currency}` : ""}`;
}

/** Price and scope differences between two quotes, each backed by the documents' own lines. */
export function diffQuotes(oldFacts: DocFacts, newFacts: DocFacts): QuoteDiff {
  const lines: string[] = [];
  let total: QuoteDiff["total"] = null;
  if (oldFacts.total.value !== null || newFacts.total.value !== null) {
    const delta = oldFacts.total.value !== null && newFacts.total.value !== null ? Math.round((newFacts.total.value - oldFacts.total.value) * 100) / 100 : null;
    total = { from: oldFacts.total.value, to: newFacts.total.value, delta, currency: newFacts.total.currency ?? oldFacts.total.currency, fromQuote: oldFacts.total.quote, toQuote: newFacts.total.quote };
    if (delta !== 0) lines.push(`Total: ${money(total.from)} to ${money(total.to)}${delta !== null ? ` (${delta > 0 ? "+" : ""}${money(delta)})` : ""}`);
  }

  const remaining = [...newFacts.lineItems];
  const changed: QuoteDiff["changed"] = [];
  const removed: QuoteDiff["removed"] = [];
  for (const item of oldFacts.lineItems) {
    let best = -1;
    let bestScore = 0;
    remaining.forEach((cand, i) => {
      const s = similarity(item.description, cand.description);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (best >= 0 && bestScore >= 0.5) {
      const match = remaining.splice(best, 1)[0]!;
      if (match.description !== item.description || match.amount !== item.amount) {
        changed.push({ from: item.description, to: match.description, fromAmount: item.amount, toAmount: match.amount });
        lines.push(
          match.description !== item.description
            ? `Changed: "${item.description}" (${money(item.amount)}) is now "${match.description}" (${money(match.amount)})`
            : `Changed price: ${item.description}, ${money(item.amount)} to ${money(match.amount)}`,
        );
      }
    } else {
      removed.push({ description: item.description, amount: item.amount });
      lines.push(`Removed: ${item.description} (${money(item.amount)})`);
    }
  }
  const added = remaining.map((r) => ({ description: r.description, amount: r.amount }));
  for (const a of added) lines.push(`Added: ${a.description} (${money(a.amount)})`);
  const scope = oldFacts.scope !== newFacts.scope ? { from: oldFacts.scope, to: newFacts.scope } : null;
  return { total, changed, added, removed, scope, lines };
}
