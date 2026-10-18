/**
 * Step 3 evaluation: turning the account holder's answer into changes to a proposal. The number
 * that matters most is "invented": a change they didn't ask for, which would land in the next
 * version they're asked to approve.
 *
 *   node --disable-warning=ExperimentalWarning scripts/eval-adjust.ts            # mock interpreter
 *   node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-adjust.ts --live
 *   ... --only move-one,unsupported
 */
import fs from "node:fs";
import path from "node:path";
import type { ChangeRequest, ProposalItem } from "../server/domain/adjust.ts";
import { ClaudeReader, MockReader, type Reader } from "../server/extractor.ts";
import { ADJUST_SET, PROPOSAL, type AdjustCase, type ExpectedEdit } from "./eval/adjust-set.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

/** The eval's proposal as the items Kiki shows (file ids stand in for real ones). */
export const ITEMS: ProposalItem[] = PROPOSAL.map((p) => ({ n: p.n, fileId: `file-${p.n}`, kind: p.kind, name: p.name, to: p.to ?? null, why: p.why ?? null }));

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const matches = (want: ExpectedEdit, got: ChangeRequest["edits"][number]) =>
  want.item === got.item &&
  want.action === got.action &&
  (want.value === undefined ||
    (want.action === "rename" ? norm(got.new_name).includes(norm(want.value)) : norm(got.place) === norm(want.value) || norm(got.place).endsWith(`/${norm(want.value)}`)));

export interface Score {
  kind: boolean;
  unsupported: boolean;
  right: number;
  missed: ExpectedEdit[];
  invented: ChangeRequest["edits"];
}

export function scoreAdjust(c: AdjustCase, got: ChangeRequest): Score {
  const missed = c.expected.edits.filter((w) => !got.edits.some((g) => matches(w, g)));
  const invented = got.edits.filter((g) => !c.expected.edits.some((w) => matches(w, g)) && !(c.expected.optional ?? []).includes(g.item));
  return {
    kind: got.kind === c.expected.kind,
    unsupported: (c.expected.unsupported === "some") === got.unsupported.length > 0,
    right: c.expected.edits.length - missed.length,
    missed,
    invented,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reader: Reader = live ? new ClaudeReader(model) : new MockReader();
  const cases = ADJUST_SET.filter((c) => !only || only.has(c.id));
  const rows: { id: string; got?: ChangeRequest; score?: Score; error?: string }[] = [];
  for (const c of cases) {
    try {
      const got = await reader.interpretChange(ITEMS, c.reply);
      rows.push({ id: c.id, got, score: scoreAdjust(c, got) });
    } catch (err) {
      rows.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  console.log(`\nKiki changing a proposal from your answer: ${live ? `live (${model})` : "mock interpreter"}, ${cases.length} answers\n`);
  let right = 0;
  let expected = 0;
  let invented = 0;
  let kinds = 0;
  let unsupported = 0;
  for (const r of rows) {
    if (!r.score) {
      console.log(`• ${r.id.padEnd(22)} ERROR: ${r.error}`);
      continue;
    }
    const s = r.score;
    const c = cases.find((x) => x.id === r.id)!;
    right += s.right;
    expected += c.expected.edits.length;
    invented += s.invented.length;
    kinds += Number(s.kind);
    unsupported += Number(s.unsupported);
    const problems = [
      s.kind ? null : `kind ${r.got!.kind} (want ${c.expected.kind})`,
      s.missed.length ? `missed ${s.missed.map((m) => `${m.item}:${m.action}${m.value ? `=${m.value}` : ""}`).join(", ")}` : null,
      s.invented.length ? `INVENTED ${s.invented.map((g) => `${g.item}:${g.action}${g.new_name ?? g.place ? `=${g.new_name ?? g.place}` : ""}`).join(", ")}` : null,
      s.unsupported ? null : `unsupported ${r.got!.unsupported.length ? "flagged" : "not flagged"}`,
    ].filter(Boolean);
    console.log(`${problems.length ? "•" : "✓"} ${r.id.padEnd(22)} ${problems.join(" · ")}`);
  }
  const ok = rows.filter((r) => r.score).length;
  console.log(`\n${right}/${expected} asked-for changes found · ${invented} invented · kind ${kinds}/${ok} · unsupported asks ${unsupported}/${ok} · ${rows.length - ok} errors\n`);
  const dir = path.join(process.cwd(), "eval-results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-adjust-${live ? "live" : "mock"}.json`);
  fs.writeFileSync(file, JSON.stringify({ mode: live ? "live" : "mock", model: live ? model : null, at: new Date().toISOString(), rows }, null, 1));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}
