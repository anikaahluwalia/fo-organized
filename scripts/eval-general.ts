/**
 * Ordinary files, not paperwork with a project on it: what Claude says each is, where it would
 * naturally go, and that a name merely visible in a screenshot isn't taken as its project.
 *   node --env-file=.env scripts/eval-general.ts [--live]
 */
import { toFacts } from "../server/domain/documents.ts";
import { proposedName } from "../server/domain/naming.ts";
import { ClaudeReader, MockReader, type Reader } from "../server/extractor.ts";

const live = process.argv.includes("--live");
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const reader: Reader = live ? new ClaudeReader(model) : new MockReader();

const CASES: { id: string; name: string; text: string; expect: { project: null | string; folderOneOf: string[] } }[] = [
  { id: "resume", name: "ANIKA_AHLUWALIA_RESUME_SWE.pdf", text: "ANIKA AHLUWALIA\nSoftware Engineer\nanika@example.com\nEXPERIENCE\nIntern, Shopify, 2025\nEDUCATION\nUniversity of Waterloo, Computer Science", expect: { project: null, folderOneOf: ["Career", "Work", "Personal documents", "Resumes", "Job search"] } },
  {
    id: "app-screenshot",
    name: "Screenshot 2026-10-18 at 2.02.22 PM.png",
    text: "Kiki\nI have a plan.\nRenovation paperwork, checked 5:57 PM\nPlan  Proposed\nProjects/Flooring/Invoices  New folder\nSet aside duplicate copies\nApprove   Not now",
    expect: { project: null, folderOneOf: ["Screenshots", "Images", "Pictures"] },
  },
  { id: "boarding-pass", name: "IMG_7781.png", text: "BOARDING PASS\nAIR CANADA\nPassenger: AHLUWALIA/ANIKA\nFrom: TORONTO YYZ  To: SAN FRANCISCO SFO\nFlight AC 755  Date: 24 OCT 2026  Seat 14C", expect: { project: null, folderOneOf: ["Travel", "Trips"] } },
  { id: "bank-statement", name: "document (3).pdf", text: "RBC Royal Bank\nChequing Account Statement\nStatement period: September 1 to September 30, 2026\nOpening balance $2,104.55\nClosing balance $1,873.20", expect: { project: null, folderOneOf: ["Finances", "Banking", "Bank statements", "Money"] } },
];

console.log(`Ordinary files: ${live ? `live (${model})` : "mock"}\n`);
let ok = 0;
for (const c of CASES) {
  try {
    const read = await reader.read({ kind: "text", text: c.text } as never, c.name);
    const facts = toFacts(read, c.text);
    const name = proposedName(facts, c.name, "application/pdf") ?? c.name;
    const projectOk = facts.project.value === c.expect.project;
    const folderOk = c.expect.folderOneOf.some((f) => f.toLowerCase() === (facts.suggested ?? "").toLowerCase());
    if (projectOk && folderOk) ok++;
    console.log(`${projectOk && folderOk ? "✓" : "·"} ${c.id.padEnd(15)} kind ${JSON.stringify(facts.kind)}, goes in ${JSON.stringify(facts.suggested)}, project ${JSON.stringify(facts.project.value)}, name ${JSON.stringify(name)}${name !== c.name ? " (junk name replaced)" : ""}`);
  } catch (err) {
    console.log(`· ${c.id.padEnd(15)} error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${ok}/${CASES.length} placed sensibly with no invented project`);
