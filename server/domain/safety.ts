/**
 * Documents and messages are untrusted data. Kiki never follows instructions inside them; this
 * flags text that looks aimed at AI tools so the user can see it was ignored.
 */
const AI_DIRECTED =
  /\b(ignore|disregard) (all |any )?(previous|prior|above|earlier) instructions\b|\bnote to (any |the )?(ai|assistant|bot)\b|\bAI (assistant|agent)s?\b|\byou are (now )?authori[sz]ed to\b|\bsystem prompt\b|\bas an ai\b/i;

export function aiDirectedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && AI_DIRECTED.test(l))
    .slice(0, 5);
}

/** Case-, punctuation- and suffix-insensitive company key, for matching "Oakline Flooring Co." to "oakline flooring". */
export function issuerKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|incorporated|ltd|limited|llc|co|company|corp|corporation)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || null;
}
