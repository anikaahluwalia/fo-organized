/**
 * Step 7 evaluation: how Kiki reads a new message in a Fo conversation about a contractor's quote,
 * and whether a reading ever claims the contractor said something the message doesn't say.
 *
 *   node --disable-warning=ExperimentalWarning scripts/eval-outcome.ts            # mock interpreter
 *   node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-outcome.ts --live
 *   ... --only hedged,injected
 */
import fs from "node:fs";
import path from "node:path";
import type { Outcome } from "../server/domain/outcome.ts";
import { ClaudeReader, MockReader, type Reader } from "../server/extractor.ts";
import { ASKED, CONTRACTOR, OUTCOME_SET, type OutcomeCase } from "./eval/outcome-set.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const reader: Reader = live ? new ClaudeReader(model) : new MockReader();

export type Verdict = "right" | "invented" | "missed" | "wrong";
export const FIELDS = ["relevant", "sourceKind", "final", "newer", "verbatim", "question", "ignored"] as const;
type Field = (typeof FIELDS)[number];

const allowed = <T>(want: T | T[] | "any", got: T) => want === "any" || (Array.isArray(want) ? want.includes(got) : want === got);

/** Scores one interpretation. "Invented" means Kiki would claim something the message doesn't say. */
export function scoreOutcome(c: OutcomeCase, o: Outcome): Record<Field, Verdict> {
  const e = c.expected;
  const presence = (want: "present" | "null" | "any", has: boolean): Verdict => (want === "any" || (want === "present") === has ? "right" : has ? "invented" : "missed");
  return {
    relevant: allowed(e.relevant, o.relevant) ? "right" : o.relevant ? "invented" : "missed",
    // Claiming the contractor's own words when the message only has Fo's summary is an invention.
    sourceKind: allowed(e.sourceKind, o.source_kind) ? "right" : o.source_kind === "quoted_reply" ? "invented" : "wrong",
    final: allowed(e.final, o.asked_document_is_final) ? "right" : o.asked_document_is_final === "unclear" ? "missed" : allowed(e.final, "unclear") ? "invented" : "wrong",
    newer: allowed(e.newer, o.points_to_newer_version) ? "right" : o.points_to_newer_version ? "invented" : "missed",
    verbatim: presence(e.verbatim, o.verbatim_quote !== null),
    question: presence(e.question, Boolean(o.question_for_user)),
    // Not flagging a request to pay or share is the dangerous miss; flagging one too many is harmless.
    ignored: e.ignored === "any" || (e.ignored === "some") === o.requests_to_ignore.length > 0 ? "right" : e.ignored === "some" ? "missed" : "wrong",
  };
}

interface Row {
  id: string;
  ok: boolean;
  error?: string;
  outcome?: Outcome;
  verdicts?: Record<Field, Verdict>;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = OUTCOME_SET.filter((c) => !only || only.has(c.id));
  const rows: Row[] = [];
  for (const c of cases) {
    try {
      const outcome = await reader.interpret({ contractorName: CONTRACTOR, askedDocument: ASKED, message: c.message, source: c.source ?? "fo_conversation" });
      rows.push({ id: c.id, ok: true, outcome, verdicts: scoreOutcome(c, outcome) });
    } catch (err) {
      rows.push({ id: c.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`\nKiki reading Fo's messages: ${live ? `live (${model})` : "mock interpreter"}, ${cases.length} messages\n`);
  for (const r of rows) {
    const bad = r.verdicts ? FIELDS.filter((f) => r.verdicts![f] !== "right") : [];
    const detail = bad.map((f) => `${f} ${r.verdicts![f]}`).join(", ");
    console.log(`${r.ok && !bad.length ? "✓" : "•"} ${r.id.padEnd(24)} ${r.ok ? detail : `ERROR: ${r.error}`}`);
  }
  const tally = Object.fromEntries(FIELDS.map((f) => [f, { right: 0, invented: 0, missed: 0, wrong: 0 } as Record<Verdict, number>])) as Record<Field, Record<Verdict, number>>;
  for (const r of rows) if (r.verdicts) for (const f of FIELDS) tally[f][r.verdicts[f]]++;
  console.log(`\n${"field".padEnd(12)}  right  invented  missed  wrong`);
  for (const f of FIELDS) {
    const t = tally[f];
    console.log(`${f.padEnd(12)}  ${`${t.right}/${rows.filter((r) => r.ok).length}`.padStart(5)}  ${String(t.invented).padStart(8)}  ${String(t.missed).padStart(6)}  ${String(t.wrong).padStart(5)}`);
  }
  const sum = (v: Verdict) => FIELDS.reduce((n, f) => n + tally[f][v], 0);
  const scored = rows.filter((r) => r.ok).length * FIELDS.length;
  console.log(`\n${sum("right")}/${scored} scored fields right · ${sum("invented")} invented · ${rows.filter((r) => !r.ok).length} errors\n`);
  const dir = path.join(process.cwd(), "eval-results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-outcome-${live ? "live" : "mock"}.json`);
  fs.writeFileSync(file, JSON.stringify({ mode: live ? "live" : "mock", model: live ? model : null, at: new Date().toISOString(), rows, tally }, null, 1));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}
