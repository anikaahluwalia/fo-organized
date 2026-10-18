/**
 * The texts Fo sends you: what Claude writes for each situation, whether Kiki's checks pass it,
 * and how long it is. A text that fails a check goes out in Kiki's own words instead.
 *   node --env-file=.env scripts/eval-compose.ts [--live]
 */
import fs from "node:fs";
import path from "node:path";
import { chooseText, type ComposeFacts } from "../server/domain/compose.ts";
import { ClaudeReader, MockReader, type Reader } from "../server/extractor.ts";

const live = process.argv.includes("--live");
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const reader: Reader = live ? new ClaudeReader(model) : new MockReader();

const timesheet = { n: 3, kind: "file" as const, name: "Ahluwalia,Anika_Timesheet_Aug23,2026-Aug29,2026.xlsm - DOM Weekly Timesheet (1).pdf", about: [], folder: "Work › Other documents" };
const invoice = { n: 1, kind: "file" as const, name: "Northside invoice Oct 17.pdf", about: ["Northside Building Supply", "N-5602", "invoice", "Flooring"], folder: "Flooring › Invoices", renamedTo: "Invoice - Northside Building Supply - N-5602" };
const ws = "Renovation paperwork";

const CASES: { id: string; facts: ComposeFacts }[] = [
  { id: "one-file", facts: { situation: "new", workspace: ws, answer: "reply_or_link", items: [timesheet] } },
  { id: "renamed", facts: { situation: "new", workspace: ws, answer: "reply_or_link", items: [invoice] } },
  { id: "link-only", facts: { situation: "new", workspace: ws, answer: "link", items: [invoice] } },
  { id: "no-link", facts: { situation: "new", workspace: ws, answer: "reply_or_app", items: [timesheet] } },
  {
    id: "three-files",
    facts: {
      situation: "new",
      workspace: ws,
      answer: "reply_or_link",
      items: [
        { n: 1, kind: "file", name: "scan_0012.pdf", about: ["Oakline Flooring Co.", "Q-1042", "quote"], folder: "Flooring › Quotes", renamedTo: "Quote - Oakline Flooring Co. - Q-1042" },
        { n: 2, kind: "file", name: "IMG_2041.pdf", about: ["Bright Floors Ltd.", "BF-77", "quote"], folder: "Flooring › Quotes", renamedTo: "Quote - Bright Floors Ltd. - BF-77" },
        { n: 3, kind: "file", name: "Oakline invoice deposit.pdf", about: ["Oakline Flooring Co.", "INV-3307", "invoice"], folder: "Flooring › Invoices", renamedTo: "Invoice - Oakline Flooring Co. - INV-3307" },
      ],
    },
  },
  {
    id: "many-files",
    facts: { situation: "new", workspace: ws, answer: "reply_or_link", items: Array.from({ length: 7 }, (_, i) => ({ n: i + 1, kind: "file" as const, name: `receipt_${i + 1}.pdf`, about: ["receipt"], folder: i < 4 ? "Kitchen › Receipts" : "Flooring › Receipts" })), alsoTidying: 2 },
  },
  { id: "question", facts: { situation: "question", workspace: ws, answer: "reply_or_link", items: [{ ...timesheet, kind: "unplaced", folder: undefined, options: ["Flooring renovation › Other documents"] }] } },
  { id: "copy", facts: { situation: "new", workspace: ws, answer: "reply_or_link", items: [{ n: 1, kind: "copy", name: "quote again.pdf", about: ["Oakline Flooring Co.", "Q-1042", "quote"] }] } },
  { id: "revised", facts: { situation: "revised", workspace: ws, answer: "reply_or_link", items: [{ ...timesheet, folder: "Work › Other documents" }] } },
  { id: "unchanged", facts: { situation: "unchanged", workspace: ws, answer: "reply_or_link", items: [timesheet], note: "Those changes are already in the proposal." } },
  { id: "done", facts: { situation: "done", workspace: ws, answer: null, items: [timesheet], verified: { done: 4, total: 4 } } },
  { id: "auto", facts: { situation: "auto", workspace: ws, answer: null, items: [timesheet], verified: { done: 3, total: 3 } } },
  { id: "stopped", facts: { situation: "stopped", workspace: ws, answer: null, items: [invoice], verified: { done: 2, total: 3 } } },
];

console.log(`The texts Fo sends you: ${live ? `live (${model})` : "mock (Kiki's own)"}, ${CASES.length} situations\n`);
const results = [];
for (const c of CASES) {
  let composed = null;
  let error: string | null = null;
  try {
    composed = await reader.composeText(c.facts);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const choice = chooseText(c.facts, composed);
  results.push({ id: c.id, by: choice.by, text: choice.text, problems: choice.problems, claude: composed?.text ?? null, error });
  console.log(`${choice.by === "claude" ? "✓" : "·"} ${c.id.padEnd(12)} ${String(choice.text.length).padStart(3)} chars  ${choice.text}`);
  if (choice.problems.length) console.log(`  Claude's didn't pass (${choice.problems.join("; ")}): ${composed?.text}`);
  if (error) console.log(`  error: ${error}`);
}
const passed = results.filter((r) => r.by === "claude").length;
console.log(`\n${live ? `${passed}/${results.length} written by Claude passed Kiki's checks` : "mock: every text is Kiki's own"} · longest ${Math.max(...results.map((r) => r.text.length))} chars`);
const dir = path.resolve("eval-results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-compose-${live ? "live" : "mock"}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`Saved ${path.relative(process.cwd(), file)}`);
