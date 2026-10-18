/**
 * Scores what Kiki read from a document against what a careful reader should take from it.
 *
 * right: matches an acceptable value (null counts when null is acceptable).
 * invented: a value where the document doesn't support one. The failure that matters most.
 * missed: nothing where the document states it.
 * wrong: a value, but not an acceptable one.
 */
import type { DocFacts } from "../../server/domain/documents.ts";
import { issuerKey } from "../../server/domain/safety.ts";
import type { Case, Expected } from "./reading-set.ts";

export type Verdict = "right" | "invented" | "missed" | "wrong" | "unscored";
export const FIELDS = ["docType", "issuer", "reference", "date", "total", "project", "title", "validUntil", "refersTo", "aiDirected", "unclear"] as const;
export type Field = (typeof FIELDS)[number];

const refKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const loose = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();

function judge<T>(got: T | null, want: T | (T | null)[] | null | "any", same: (a: T, b: T) => boolean): Verdict {
  if (want === "any") return "unscored";
  const options = Array.isArray(want) ? want : [want];
  if (got === null || got === undefined) return options.includes(null) ? "right" : "missed";
  if (options.every((o) => o === null)) return "invented";
  return options.some((o) => o !== null && same(got, o)) ? "right" : "wrong";
}

/** What Kiki would show for this document, field by field. */
export function observed(facts: DocFacts) {
  return {
    docType: facts.docType,
    issuer: facts.issuer.value,
    reference: facts.reference.value,
    date: facts.date.value,
    total: facts.total.value,
    project: facts.project.value,
    title: facts.title?.value ?? null,
    validUntil: facts.validUntil?.value ?? null,
    refersTo: (facts.refersTo ?? []).map((r) => r.reference),
    aiDirected: facts.aiDirectedText.length > 0,
    unclear: facts.docType === "other" || facts.docType === "unknown",
  };
}

export function scoreCase(c: Case, facts: DocFacts): Record<Field, Verdict> {
  const o = observed(facts);
  const e: Expected = c.expected;
  const types = Array.isArray(e.docType) ? e.docType : [e.docType];
  return {
    docType: types.includes(o.docType) ? "right" : "wrong",
    issuer: judge(o.issuer, e.issuer, (a, b) => issuerKey(a) === issuerKey(b)),
    reference: judge(o.reference, e.reference, (a, b) => refKey(a) === refKey(b)),
    date: judge(o.date, e.date, (a, b) => a === b),
    total: judge(o.total, e.total, (a, b) => Math.abs(a - b) < 0.005),
    project: judge(o.project, e.project, (a, b) => loose(a) === loose(b)),
    // A title is right if it carries the same words either way round ("Lecture 7: X" vs "X").
    title: judge(o.title, e.title, (a, b) => loose(a).includes(loose(b)) || loose(b).includes(loose(a))),
    validUntil: judge(o.validUntil, e.validUntil, (a, b) => a === b),
    refersTo:
      e.refersTo === "any"
        ? "unscored"
        : (() => {
            const got = new Set(o.refersTo.map(refKey));
            const want = new Set(e.refersTo.map(refKey));
            if ([...got].some((r) => !want.has(r))) return "invented";
            return [...want].every((r) => got.has(r)) ? "right" : "missed";
          })(),
    aiDirected: o.aiDirected === e.aiDirected ? "right" : e.aiDirected ? "missed" : "invented",
    unclear: o.unclear === e.unclear ? "right" : e.unclear ? "missed" : "wrong",
  };
}
