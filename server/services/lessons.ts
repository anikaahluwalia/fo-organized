/**
 * Learning from your answers (see domain/lessons.ts). Kiki learns only from a filing you approved
 * and she verified in Drive: where you put a file yourself ("put it in Work") becomes "documents
 * like this go in Work"; a later filing that followed a lesson and that you approved backs it up;
 * keeping files' own names on two separate proposals means you'd rather keep them.
 */
import { randomUUID } from "node:crypto";
import { all, kvGet, kvSet, logEvent, now, one, run, type DocumentRow, type LessonRow, type PlanOpRow, type PlanRow } from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { checkPattern, matchLesson, plainPattern, type Pattern, type PlaceLesson } from "../domain/lessons.ts";
import { inert } from "../domain/inert.ts";
import { notFound } from "../errors.ts";
import type { LessonView } from "../../shared/api.ts";
import type { Ctx } from "./context.ts";

/** Kiki lets you keep names on her own after you've asked on this many proposals. */
const KEEP_NAMES_AFTER = 2;

export function placeLessons(db: Ctx["db"], workspaceId: string): PlaceLesson[] {
  return all<LessonRow>(db, "SELECT * FROM lessons WHERE workspace_id = ? AND kind = 'place' ORDER BY updated_at DESC", workspaceId).map((l) => ({
    id: l.id,
    description: l.description,
    keywords: JSON.parse(l.keywords_json ?? "[]") as string[],
    place: l.place ?? "",
    examples: l.examples,
    updatedAt: l.updated_at,
  }));
}

export function keepsNames(db: Ctx["db"], workspaceId: string): boolean {
  return Boolean(one(db, "SELECT id FROM lessons WHERE workspace_id = ? AND kind = 'keep_names'", workspaceId));
}

export function lessonsView(db: Ctx["db"], workspaceId: string): LessonView[] {
  return all<LessonRow>(db, "SELECT * FROM lessons WHERE workspace_id = ? ORDER BY created_at", workspaceId).map((l) => ({
    id: l.id,
    kind: l.kind,
    text: l.kind === "keep_names" ? "You keep files' own names, so Kiki doesn't propose renames." : `${capital(l.description)} go in ${shown(l.place)}.`,
    examples: l.examples,
    since: l.created_at,
  }));
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shown = (place: string | null) => (place ?? "").replace(/^(Projects|Renovations)\//, "").split("/").join(" › ");

/** Kiki forgets a lesson: the next proposal is made without it. */
export function forgetLesson(ctx: Ctx, id: string): void {
  const l = one<LessonRow>(ctx.db, "SELECT * FROM lessons WHERE id = ?", id);
  if (!l) throw notFound("Kiki doesn't have that lesson.");
  run(ctx.db, "DELETE FROM lessons WHERE id = ?", id);
  logEvent(ctx.db, l.workspace_id, "lesson", `You told Kiki to forget: ${lessonsText(l)}`);
}

const lessonsText = (l: LessonRow) => (l.kind === "keep_names" ? "keeping files' own names." : `${l.description} go in ${shown(l.place)}.`);

/** After a filing you approved is applied: what it teaches. Safe to run again (each plan teaches once). */
export async function learnFromPlan(ctx: Ctx, planId: string): Promise<void> {
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", planId);
  if (!plan || plan.kind !== "organize" || !["applied", "partial"].includes(plan.status)) return;
  if (kvGet(ctx.db, `lessons.read.${planId}`)) return;
  kvSet(ctx.db, `lessons.read.${planId}`, "1");
  const edits = ((plan.details_json ? (JSON.parse(plan.details_json) as { edits?: Record<string, { place?: string; keepName?: boolean }> }) : null)?.edits ?? {}) as Record<string, { place?: string; keepName?: boolean }>;
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state = 'verified' AND file_id IS NOT NULL", planId);
  const lessons = placeLessons(ctx.db, plan.workspace_id);

  for (const op of moves) {
    const doc = op.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", op.doc_id) : undefined;
    const facts = doc?.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
    const name = op.pre_name ?? op.new_name ?? "";
    if (!op.new_path) continue;
    if (edits[op.file_id!]?.place) {
      // You chose where this went: remember documents like it go there.
      const pattern = await describe(ctx, name, facts, op.new_path);
      if (pattern) remember(ctx, plan, pattern, op.new_path);
    } else {
      // Kiki followed a lesson and you said yes: it's better supported now.
      const l = matchLesson(lessons, name, facts);
      if (l && l.place === op.new_path) run(ctx.db, "UPDATE lessons SET examples = examples + 1, updated_at = ? WHERE id = ?", now(), l.id);
    }
  }

  if (Object.values(edits).some((e) => e.keepName) && !keepsNames(ctx.db, plan.workspace_id)) {
    const key = `lessons.keep_name.${plan.workspace_id}`;
    const plans = new Set((kvGet(ctx.db, key) ?? "").split(",").filter(Boolean)).add(plan.id);
    kvSet(ctx.db, key, [...plans].join(","));
    if (plans.size >= KEEP_NAMES_AFTER) {
      const at = now();
      run(ctx.db, "INSERT INTO lessons (id, workspace_id, kind, description, examples, from_plan_id, created_at, updated_at) VALUES (?, ?, 'keep_names', ?, ?, ?, ?, ?)", randomUUID(), plan.workspace_id, "keeping files' own names", plans.size, planId, at, at);
      logEvent(ctx.db, plan.workspace_id, "lesson", "Kiki learned you keep files' own names, so she won't propose renames. You can change that in the app.");
    }
  }
}

/** Claude's description of the kind of document, if it checks out against the document; else Kiki's own. */
async function describe(ctx: Ctx, name: string, facts: DocFacts | null, place: string): Promise<Pattern | null> {
  const claude = await ctx.reader.describeKind(name, facts, place).catch(() => null);
  const pattern = claude && checkPattern(claude, name, facts).length === 0 ? claude : plainPattern(name, facts);
  return pattern && checkPattern(pattern, name, facts).length === 0 ? { description: inert(pattern.description.toLowerCase(), 40), keywords: pattern.keywords.map((k) => k.toLowerCase()) } : null;
}

/** Keeps a lesson: the same kind of document again moves it or backs it up; a new kind adds one. */
function remember(ctx: Ctx, plan: PlanRow, pattern: Pattern, place: string): void {
  const key = JSON.stringify([...pattern.keywords].sort());
  const same = all<LessonRow>(ctx.db, "SELECT * FROM lessons WHERE workspace_id = ? AND kind = 'place'", plan.workspace_id).find((l) => JSON.stringify([...(JSON.parse(l.keywords_json ?? "[]") as string[])].sort()) === key);
  const at = now();
  if (same && same.place === place) {
    run(ctx.db, "UPDATE lessons SET examples = examples + 1, updated_at = ? WHERE id = ?", at, same.id);
    return;
  }
  if (same) {
    // You put this kind somewhere else this time: that's where they go now.
    run(ctx.db, "UPDATE lessons SET place = ?, description = ?, examples = 1, from_plan_id = ?, updated_at = ? WHERE id = ?", place, pattern.description, plan.id, at, same.id);
  } else {
    run(
      ctx.db,
      "INSERT INTO lessons (id, workspace_id, kind, description, keywords_json, place, examples, from_plan_id, created_at, updated_at) VALUES (?, ?, 'place', ?, ?, ?, 1, ?, ?, ?)",
      randomUUID(),
      plan.workspace_id,
      pattern.description,
      JSON.stringify(pattern.keywords),
      place,
      plan.id,
      at,
      at,
    );
  }
  logEvent(ctx.db, plan.workspace_id, "lesson", `Kiki learned: ${pattern.description} go in ${shown(place)}. She'll suggest it next time. You can change that in the app.`);
}
