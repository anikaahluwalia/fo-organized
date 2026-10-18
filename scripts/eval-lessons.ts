/**
 * What Kiki learns from where you filed something: Claude's description of the kind of document,
 * whether Kiki's checks keep it, and whether it would recognize the next one like it (and not an
 * unrelated one).
 *   node --env-file=.env scripts/eval-lessons.ts [--live]
 */
import type { DocFacts, DocType, Fact } from "../server/domain/documents.ts";
import { checkPattern, matchLesson, plainPattern, type Pattern } from "../server/domain/lessons.ts";
import { ClaudeReader, MockReader, type Reader } from "../server/extractor.ts";

const live = process.argv.includes("--live");
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const reader: Reader = live ? new ClaudeReader(model) : new MockReader();

const known = <T>(value: T | null): Fact<T> => ({ value, quote: value === null ? null : String(value), quoteFound: value === null ? null : true });
function facts(docType: DocType, title: string | null, issuer: string | null): DocFacts {
  return {
    docType,
    title: known(title),
    issuer: known(issuer),
    reference: known<string>(null),
    date: known<string>(null),
    total: { ...known<number>(null), currency: null },
    project: known<string>(null),
    scope: null,
    lineItems: [],
    revision: { isRevision: false, label: null, revisesReference: null, quote: null },
    aiDirectedText: [],
    textAvailable: true,
  };
}

type Doc = { name: string; facts: DocFacts | null };
const CASES: { id: string; filed: Doc; place: string; next: Doc; unrelated: Doc }[] = [
  {
    id: "timesheet",
    filed: { name: "Ahluwalia,Anika_Timesheet_Aug23,2026-Aug29,2026.xlsm - DOM Weekly Timesheet (1).pdf", facts: null },
    place: "Projects/Work/Other documents",
    next: { name: "Ahluwalia,Anika_Timesheet_Aug30,2026-Sep5,2026.xlsm - DOM Weekly Timesheet.pdf", facts: null },
    unrelated: { name: "ANIKA__AHLUWALIA__RESUME_WYGO.pdf", facts: null },
  },
  {
    id: "hydro-bill",
    filed: { name: "HydroOne_Oct.pdf", facts: facts("invoice", "Your electricity bill", "Hydro One") },
    place: "Projects/Home/Invoices",
    next: { name: "bill-nov.pdf", facts: facts("invoice", "Your electricity bill", "Hydro One") },
    unrelated: { name: "Rogers_Oct.pdf", facts: facts("invoice", "Your wireless bill", "Rogers") },
  },
  {
    id: "pay-stub",
    filed: { name: "paystub_2026-09-30.pdf", facts: facts("other", "Pay Statement", "Maple Leaf Foods") },
    place: "Projects/Work/Other documents",
    next: { name: "paystub_2026-10-15.pdf", facts: facts("other", "Pay Statement", "Maple Leaf Foods") },
    unrelated: { name: "receipt_2026-10-15.pdf", facts: facts("receipt", "Receipt", "Home Depot") },
  },
  {
    id: "lecture-notes",
    filed: { name: "CS246 lecture 5 notes.pdf", facts: facts("notes", "Lecture 5: Inheritance", null) },
    place: "School/CS 246",
    next: { name: "CS246 lecture 6 notes.pdf", facts: facts("notes", "Lecture 6: Templates", null) },
    unrelated: { name: "meeting notes.pdf", facts: facts("notes", "Team sync", null) },
  },
];

console.log(`What Kiki learns from where you filed something: ${live ? `live (${model})` : "mock (Kiki's own)"}\n`);
let kept = 0;
let right = 0;
for (const c of CASES) {
  let claude: Pattern | null = null;
  try {
    claude = await reader.describeKind(c.filed.name, c.filed.facts, c.place);
  } catch (err) {
    console.log(`  error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problems = claude ? checkPattern(claude, c.filed.name, c.filed.facts) : ["no answer"];
  const pattern = !problems.length ? claude! : plainPattern(c.filed.name, c.filed.facts);
  if (!problems.length) kept++;
  const lesson = pattern ? [{ id: c.id, description: pattern.description, keywords: pattern.keywords, place: c.place, examples: 1, updatedAt: "" }] : [];
  const nextOk = matchLesson(lesson, c.next.name, c.next.facts) !== null;
  const unrelatedOk = matchLesson(lesson, c.unrelated.name, c.unrelated.facts) === null;
  if (nextOk && unrelatedOk) right++;
  console.log(`${!problems.length ? "✓" : "·"} ${c.id.padEnd(14)} ${JSON.stringify(pattern)}  next: ${nextOk ? "recognized" : "MISSED"}, unrelated: ${unrelatedOk ? "left alone" : "WRONGLY MATCHED"}`);
  if (problems.length && claude) console.log(`  Claude's didn't pass (${problems.join("; ")}): ${JSON.stringify(claude)}`);
}
console.log(`\n${live ? `${kept}/${CASES.length} of Claude's descriptions kept · ` : ""}${right}/${CASES.length} recognize the next one and leave the unrelated one alone`);
