/**
 * Step 1 evaluation: how well Kiki reads documents of every kind, and whether she ever states
 * something a document doesn't say. Nothing touches Drive.
 *
 *   node --disable-warning=ExperimentalWarning scripts/eval-reading.ts            # mock reader
 *   node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-reading.ts --live
 *   ... --only lecture-notes,permit
 */
import fs from "node:fs";
import path from "node:path";
import { makePdf } from "../server/demo/pdf.ts";
import { toFacts, type DocFacts, type ReadResult } from "../server/domain/documents.ts";
import { ClaudeReader, localText, MockReader, ReadError, type Reader } from "../server/extractor.ts";
import type { DriveContent } from "../server/google/types.ts";
import { READING_SET, type Case } from "./eval/reading-set.ts";
import { FIELDS, observed, scoreCase, type Field, type Verdict } from "./eval/score.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const reader: Reader = live ? new ClaudeReader(model) : new MockReader();

function contentOf(c: Case): DriveContent {
  return c.format === "pdf" ? { kind: "pdf", data: makePdf(c.title ?? "", c.lines) } : { kind: "text", text: c.lines.join("\n") };
}

/** Values the model gave that Kiki dropped because their evidence isn't in the document. */
function dropped(raw: ReadResult, facts: DocFacts): string[] {
  const out: string[] = [];
  const pairs: [string, unknown, unknown][] = [
    ["issuer", raw.issuer.value, facts.issuer.value],
    ["reference", raw.reference_number.value, facts.reference.value],
    ["date", raw.document_date.value, facts.date.value],
    ["total", raw.total.amount, facts.total.value],
    ["project", raw.project.value, facts.project.value],
    ["title", raw.title?.value ?? null, facts.title?.value ?? null],
  ];
  for (const [field, given, kept] of pairs) if (given !== null && given !== undefined && given !== "" && (kept === null || kept === undefined)) out.push(`${field}=${JSON.stringify(given)}`);
  return out;
}

interface Row {
  id: string;
  domain: string;
  ok: boolean;
  error?: string;
  observed?: ReturnType<typeof observed>;
  verdicts?: Record<Field, Verdict>;
  dropped?: string[];
}

async function runCase(c: Case): Promise<Row> {
  const content = contentOf(c);
  try {
    const raw = await reader.read(content, c.fileName);
    const facts = toFacts(raw, localText(content));
    return { id: c.id, domain: c.domain, ok: true, observed: observed(facts), verdicts: scoreCase(c, facts), dropped: dropped(raw, facts) };
  } catch (err) {
    return { id: c.id, domain: c.domain, ok: false, error: err instanceof ReadError || err instanceof Error ? err.message : String(err) };
  }
}

const cases = READING_SET.filter((c) => !only || only.has(c.id));
const rows: Row[] = [];
const queue = [...cases];
await Promise.all(
  Array.from({ length: live ? 3 : 1 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) rows.push(await runCase(c));
  }),
);
rows.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));

const mark: Record<Verdict, string> = { right: "✓", invented: "INVENTED", missed: "missed", wrong: "WRONG", unscored: "·" };
console.log(`\nKiki reading evaluation: ${live ? `live (${model})` : "mock reader"}, ${cases.length} documents\n`);
for (const r of rows) {
  if (!r.ok) {
    console.log(`✗ ${r.id}: couldn't read (${r.error})`);
    continue;
  }
  const problems = FIELDS.filter((f) => r.verdicts![f] !== "right" && r.verdicts![f] !== "unscored").map((f) => `${f} ${mark[r.verdicts![f]]} (${JSON.stringify(r.observed![f as keyof typeof r.observed])})`);
  console.log(`${problems.length ? "•" : "✓"} ${r.id.padEnd(20)} ${r.observed!.docType.padEnd(14)} ${problems.join("; ")}${r.dropped!.length ? `  [dropped without evidence: ${r.dropped!.join(", ")}]` : ""}`);
}

const totals = Object.fromEntries(FIELDS.map((f) => [f, { right: 0, invented: 0, missed: 0, wrong: 0, unscored: 0 }])) as Record<Field, Record<Verdict, number>>;
for (const r of rows) if (r.ok) for (const f of FIELDS) totals[f][r.verdicts![f]]++;
console.log("\nfield         right  invented  missed  wrong");
for (const f of FIELDS) {
  const t = totals[f];
  const scored = t.right + t.invented + t.missed + t.wrong;
  console.log(`${f.padEnd(12)} ${`${t.right}/${scored}`.padStart(6)}  ${String(t.invented).padStart(8)}  ${String(t.missed).padStart(6)}  ${String(t.wrong).padStart(5)}`);
}
const all = FIELDS.reduce((n, f) => n + totals[f].right + totals[f].invented + totals[f].missed + totals[f].wrong, 0);
const right = FIELDS.reduce((n, f) => n + totals[f].right, 0);
const invented = FIELDS.reduce((n, f) => n + totals[f].invented, 0);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${right}/${all} scored fields right · ${invented} invented · ${rows.reduce((n, r) => n + (r.dropped?.length ?? 0), 0)} unsupported values dropped by Kiki's evidence check · ${failed} unreadable\n`);

const dir = path.join(process.cwd(), "eval-results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "mock"}.json`);
fs.writeFileSync(file, JSON.stringify({ mode: live ? "live" : "mock", model: live ? model : null, at: new Date().toISOString(), rows, totals }, null, 1));
console.log(`Saved ${path.relative(process.cwd(), file)}`);
