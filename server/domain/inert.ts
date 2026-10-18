/**
 * Untrusted text (Drive file and folder names, document facts, reasons built from them, Fo's and
 * contractors' words) inside a message Kiki sends to Fo or to Claude. Kiki's protocol markers must
 * only ever be Kiki's own lines, so such text becomes one inert line.
 */

/** Line breaks of every kind, control characters, and invisible formatting characters. */
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Kiki's markers, in any spelling Fo might read as the same thing (dash counts, spacing, case, look-alikes after NFKC). */
export const MARKERS = /-{2,}\s*(?:BEGIN|END)\s+APPROVED\s+BODY\s*-{2,}|\bKIKI\s*[-_\u2010-\u2015]?\s*(?:STATUS|DECISION)\b\s*:?/gi;

/** One plain line: no line breaks or control characters, no protocol markers, bounded length. */
export function inert(s: string | null | undefined, max = 300): string {
  return (s ?? "").normalize("NFKC").replace(BREAKS, " ").replace(MARKERS, " [removed] ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Whether text carries one of Kiki's markers, in any spelling. */
export function hasMarker(s: string): boolean {
  return new RegExp(MARKERS.source, "i").test(s.normalize("NFKC"));
}

/** A line break of any kind, where only one plain line belongs. */
export const hasLineBreak = (s: string) => /[\r\n\v\f\u0085\u2028\u2029]/.test(s);
