/**
 * Step 2 evaluation: runs Kiki's real pipeline on each workspace in scripts/eval/organize-set.ts
 * (read, propose, approve, apply in a fake Drive) and checks where every file actually ended up.
 *
 *   node --disable-warning=ExperimentalWarning scripts/eval-organize.ts            # mock reader
 *   node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-organize.ts --live
 *   ... --only work,student
 */
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { makePdf } from "../server/demo/pdf.ts";
import { ClaudeReader, MockReader, type Reader } from "../server/extractor.ts";
import { MockFoClient } from "../server/fo/mock.ts";
import { FakeDrive } from "../server/google/fake.ts";
import { ORGANIZE_SET, type OrgFile, type Scenario } from "./eval/organize-set.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const quiet = args.includes("--quiet");

export type FileVerdict = "right" | "not-filed" | "wrong-place" | "wrong-name" | "moved-unnecessarily" | "renamed-unnecessarily";

const test = (m: string | RegExp, s: string) => (typeof m === "string" ? m === s : m.test(s));
const anyOf = (m: string | RegExp | (string | RegExp)[], s: string) => (Array.isArray(m) ? m : [m]).some((x) => test(x, s));

export function judgeFile(f: OrgFile, before: { path: string; name: string }, after: { path: string; name: string }): FileVerdict {
  const moved = after.path !== before.path;
  const renamed = after.name !== before.name;
  if ("stay" in f.expect) return moved ? "moved-unnecessarily" : renamed ? "renamed-unnecessarily" : "right";
  if (!moved && !renamed) return anyOf(f.expect.folder, after.path) ? "right" : "not-filed";
  if (!anyOf(f.expect.folder, after.path)) return "wrong-place";
  const want = f.expect.name ?? "any";
  if (want === "any") return "right";
  if (want === "keep") return renamed ? "renamed-unnecessarily" : "right";
  return test(want, after.name) ? "right" : "wrong-name";
}

/** The collection a filed path belongs to: Projects/<name>, or the user's own folder. */
export function collectionOf(p: string): string | null {
  if (!p) return null;
  const parts = p.split("/");
  return parts[0] === "Projects" ? parts.slice(0, 2).join("/") : p.replace(/\/Duplicates$/, "");
}

function contentOf(f: OrgFile, all: OrgFile[]): { mime: string; data: Buffer | string | null } {
  const src = f.copyOf ? all.find((x) => x.key === f.copyOf)! : f;
  if (f.kind === "empty") return { mime: "text/plain", data: "" };
  if (f.kind === "binary") return { mime: "image/heic", data: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]) };
  if (src.kind === "pdf") return { mime: "application/pdf", data: makePdf(src.title ?? "", src.lines ?? []) };
  return { mime: f.name.endsWith(".csv") ? "text/csv" : "text/plain", data: (src.lines ?? []).join("\n") };
}

export interface ScenarioResult {
  id: string;
  files: { key: string; before: string; after: string; verdict: FileVerdict }[];
  groups: { kind: "together" | "apart"; keys: string[]; ok: boolean }[];
  planned: number;
  error?: string;
}

export async function runScenario(s: Scenario, reader: Reader): Promise<ScenarioResult> {
  const drive = new FakeDrive("mock");
  const root = drive.addFolder(`Workspace ${s.id}`, "root");
  const folders = new Map<string, string>([["", root]]);
  const ensure = (p: string): string => {
    if (folders.has(p)) return folders.get(p)!;
    const parent = ensure(p.split("/").slice(0, -1).join("/"));
    const id = drive.addFolder(p.split("/").pop()!, parent);
    folders.set(p, id);
    return id;
  };
  for (const p of s.folders ?? []) ensure(p);
  const outside = drive.addFile("Property tax 2026.pdf", "root", "application/pdf", makePdf("Outside the workspace", ["Not Kiki's to touch."]));
  const ids = new Map<string, string>();
  for (const f of s.files) {
    const parent = ensure(f.path);
    if (f.kind === "shortcut") ids.set(f.key, drive.addShortcut(f.name, parent, outside));
    else {
      const c = contentOf(f, s.files);
      ids.set(f.key, drive.addFile(f.name, parent, c.mime, c.data));
    }
  }
  const before = new Map(s.files.map((f) => [f.key, { path: f.path, name: f.name }]));
  const rel = (id: string) => {
    const full = drive.pathOf(id).split("/").slice(1); // drop the workspace folder's own name
    return { path: full.slice(0, -1).join("/"), name: full.at(-1)! };
  };

  const app = createApp({
    db: openDb(":memory:"),
    drive,
    reader,
    fo: new MockFoClient({ stepMs: 1, replyDelayMs: 0 }),
    anthropicModel: model,
    claudeCredentialsDetected: live,
    engineOptions: { pollWaitSeconds: 0, backoffBaseMs: 1 },
    watchIntervalSeconds: 0,
    workspacePollSeconds: 0,
  });
  let planned = 0;
  let error: string | undefined;
  try {
    await app.selectWorkspace(root);
    await app.settle();
    const plan = (await app.view()).plans.find((p) => p.status === "proposed");
    if (plan) {
      planned = plan.ops.filter((o) => o.kind === "move_rename").length;
      app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `eval-${s.id}` });
      await app.settle();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    app.close();
  }
  if (drive.pathOf(outside) !== "Property tax 2026.pdf") error = `${error ?? ""} A FILE OUTSIDE THE WORKSPACE MOVED.`.trim();
  const files = s.files.map((f) => {
    const a = rel(ids.get(f.key)!);
    const b = before.get(f.key)!;
    return { key: f.key, before: `${b.path ? `${b.path}/` : ""}${b.name}`, after: `${a.path ? `${a.path}/` : ""}${a.name}`, verdict: judgeFile(f, b, a) };
  });
  const coll = (key: string) => collectionOf(rel(ids.get(key)!).path);
  const groups = [
    ...(s.together ?? []).map((keys) => ({ kind: "together" as const, keys, ok: keys.every((k) => coll(k) !== null && coll(k) === coll(keys[0]!)) })),
    ...(s.apart ?? []).map((keys) => ({ kind: "apart" as const, keys, ok: new Set(keys.map(coll)).size === keys.length || keys.some((k) => coll(k) === null) })),
  ];
  return { id: s.id, files, groups, planned, ...(error ? { error } : {}) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reader: Reader = live ? new ClaudeReader(model) : new MockReader();
  const scenarios = ORGANIZE_SET.filter((s) => !only || only.has(s.id));
  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s, reader));

  console.log(`\nKiki organizing evaluation: ${live ? `live (${model})` : "mock reader"}, ${scenarios.length} workspaces\n`);
  const tally: Record<FileVerdict, number> = { right: 0, "not-filed": 0, "wrong-place": 0, "wrong-name": 0, "moved-unnecessarily": 0, "renamed-unnecessarily": 0 };
  let groupsOk = 0;
  let groupsAll = 0;
  for (const r of results) {
    const bad = r.files.filter((f) => f.verdict !== "right");
    console.log(`${bad.length || r.groups.some((g) => !g.ok) || r.error ? "•" : "✓"} ${r.id} (${r.planned} moves proposed)${r.error ? `  ERROR: ${r.error}` : ""}`);
    for (const f of r.files) {
      tally[f.verdict]++;
      if (f.verdict !== "right" || !quiet) console.log(`    ${f.verdict === "right" ? "✓" : f.verdict.toUpperCase().padEnd(21)} ${f.before}  ->  ${f.after}`);
    }
    for (const g of r.groups) {
      groupsAll++;
      if (g.ok) groupsOk++;
      else console.log(`    GROUP ${g.kind === "together" ? "SPLIT" : "MERGED"}: ${g.keys.join(", ")}`);
    }
  }
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log(`\n${tally.right}/${total} files right · ${groupsOk}/${groupsAll} groups right · ${tally["moved-unnecessarily"] + tally["renamed-unnecessarily"]} unnecessary changes · not filed ${tally["not-filed"]} · wrong place ${tally["wrong-place"]} · wrong name ${tally["wrong-name"]}\n`);
  const dir = path.join(process.cwd(), "eval-results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-organize-${live ? "live" : "mock"}.json`);
  fs.writeFileSync(file, JSON.stringify({ mode: live ? "live" : "mock", model: live ? model : null, at: new Date().toISOString(), results, tally }, null, 1));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}
