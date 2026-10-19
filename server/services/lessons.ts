/**
 * Learning from your answers (see domain/lessons.ts). Kiki learns only from a filing you approved
 * and she verified in Drive: where you put a file yourself ("put it in Work") becomes "documents
 * like this go in Work"; a later filing that followed a lesson and that you approved backs it up;
 * keeping files' own names on two separate proposals means you'd rather keep them.
 */
import { createHash, randomUUID } from "node:crypto";
import { all, kvGet, kvSet, logEvent, now, one, run, type DocumentRow, type LessonRow, type PlanOpRow, type PlanRow } from "../db.ts";
import type { DocFacts } from "../domain/documents.ts";
import { approvalInstructions, isPlainYes, sameAnswer, type ApprovalReport } from "../domain/approval.ts";
import { checkPattern, matchLesson, plainPattern, type Pattern, type PlaceLesson } from "../domain/lessons.ts";
import { newReference } from "../domain/outreach.ts";
import { inert } from "../domain/inert.ts";
import { notFound } from "../errors.ts";
import type { LessonView } from "../../shared/api.ts";
import { getTask, insertTask } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { answerLink } from "./answerlink.ts";
import { autoTextEnabled, message, saveReply, type ReplyState } from "./notify.ts";
import { approvePlan } from "./plans.ts";

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
    auto: Boolean(l.auto),
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
    auto: Boolean(l.auto),
    offered: l.offer === "offered",
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
      if (l && l.place === op.new_path) {
        run(ctx.db, "UPDATE lessons SET examples = examples + 1, updated_at = ? WHERE id = ?", now(), l.id);
        // Twice now, and you said yes to Kiki's suggestion: she offers to do these on her own.
        if (!l.auto) offerToFileAlone(ctx, l.id);
      }
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
  return pattern && checkPattern(pattern, name, facts).length === 0 ? { description: inert(pattern.description, 40), keywords: pattern.keywords.map((k) => k.toLowerCase()) } : null;
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

// Filing a kind of document on her own (standing permission) -----------------------------------

/** What an offer is bound to: the lesson as it stood when offered. A changed lesson isn't what you agreed to. */
export function offerHash(l: LessonRow): string {
  return createHash("sha256").update(JSON.stringify([l.id, l.place, l.keywords_json])).digest("hex");
}

/**
 * Kiki offers, once, to file this kind of document on her own from now on. With texts on, Fo
 * brings you the offer (bound to this lesson, like a proposal); either way it's in the app.
 */
export function offerToFileAlone(ctx: Ctx, lessonId: string): void {
  const l = one<LessonRow>(ctx.db, "SELECT * FROM lessons WHERE id = ?", lessonId);
  if (!l || l.kind !== "place" || l.auto || l.offer || l.examples < 2) return;
  run(ctx.db, "UPDATE lessons SET offer = 'offered' WHERE id = ?", l.id);
  logEvent(ctx.db, l.workspace_id, "lesson", `Kiki offered to file ${l.description} in ${shown(l.place)} on her own from now on.`);
  if (!autoTextEnabled(ctx)) return;
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  const link = answerLink(ctx, taskId);
  const text = `Kiki: you've filed ${l.examples} ${l.description} in ${shown(l.place)}. Want me to file new ones there on my own from now on? I'll text you each time.${link ? `${ctx.foWebhook ? " Reply yes or no, or tap:" : " Tap to answer:"}\n${link}` : " Reply yes or no, or answer in the Kiki app."}`;
  const binding = { requestId: randomUUID(), planId: l.id, contentHash: offerHash(l) };
  kvSet(ctx.db, `notify.purpose.${taskId}`, "offer");
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  saveReply(ctx, taskId, { status: "waiting", text: null, source: null, ...binding, requestedAt: now() });
  const context = `It asks whether I let Kiki file ${l.description} in ${shown(l.place)} without asking first, from now on (a standing permission I can stop in the app). Only a plain yes turns it on.${link && !ctx.foWebhook ? " Don't invite me to reply by text: the link is how I answer." : ""}`;
  void ctx.engine.start(taskId, `${message(text, newReference(), "text", false, context)}\n\n${approvalInstructions(binding)}`).catch(() => undefined);
}

/** Your answer to the offer, as Fo reported it: only a plain yes turns it on; anything else leaves it off. */
export function settleOffer(ctx: Ctx, taskId: string, state: ReplyState, answer: { text: string }, report: ApprovalReport, l: LessonRow): void {
  const at = now();
  if (report.decision === "clarification") {
    saveReply(ctx, taskId, { ...state, clarification: report.userReply });
    return;
  }
  if (report.decision === "approved") {
    if (!sameAnswer(report.userReply, answer.text) || !isPlainYes(answer.text)) {
      saveReply(ctx, taskId, { ...state, note: "Kiki didn't turn it on: your answer wasn't a plain yes. Answer again below." });
      return;
    }
    setFilesAlone(ctx, l.id, true);
    saveReply(ctx, taskId, { ...state, status: "approved", text: report.userReply, source: "relayed_by_fo", at });
    return;
  }
  run(ctx.db, "UPDATE lessons SET offer = 'declined', updated_at = ? WHERE id = ?", at, l.id);
  saveReply(ctx, taskId, { ...state, status: "declined", text: report.userReply, source: "relayed_by_fo", at });
  logEvent(ctx.db, l.workspace_id, "lesson", `You'd rather Kiki keep asking about ${l.description}.`);
}

/** You turn filing a kind of document on her own on or off (in the app, or by your yes to the offer). */
export function setFilesAlone(ctx: Ctx, lessonId: string, on: boolean): void {
  const l = one<LessonRow>(ctx.db, "SELECT * FROM lessons WHERE id = ?", lessonId);
  if (!l || l.kind !== "place") throw notFound("Kiki doesn't have that lesson.");
  run(ctx.db, "UPDATE lessons SET auto = ?, offer = CASE WHEN ? = 1 THEN offer ELSE 'declined' END, updated_at = ? WHERE id = ?", on ? 1 : 0, on ? 1 : 0, now(), l.id);
  logEvent(ctx.db, l.workspace_id, "lesson", on ? `Kiki will file ${l.description} in ${shown(l.place)} on her own and text you after.` : `Kiki will ask again before filing ${l.description}.`);
}

/**
 * A new proposal Kiki may carry out on your standing OK: every file in it is a new one of a kind
 * you said she may file on her own, going exactly where those go, and nothing else is in it (no
 * copies, renames of filed documents, or questions). Then she approves it in your name and texts
 * you after. Anything else waits for you as usual. Returns whether she did.
 */
export function fileAlone(ctx: Ctx, plan: PlanRow): boolean {
  if (plan.kind !== "organize" || plan.status !== "proposed") return false;
  const auto = placeLessons(ctx.db, plan.workspace_id).filter((l) => l.auto);
  if (!auto.length) return false;
  const details = plan.details_json ? (JSON.parse(plan.details_json) as { notes?: { unplaced?: boolean }[]; edits?: object }) : null;
  if (details?.notes?.some((n) => n.unplaced) || details?.edits) return false;
  const ops = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND state <> 'excluded'", plan.id);
  const moves = ops.filter((o) => o.kind === "move_rename");
  if (!moves.length || ops.some((o) => !["move_rename", "create_folder", "write_index"].includes(o.kind))) return false;
  const used = new Set<string>();
  for (const op of moves) {
    if (op.pre_path && /^(Projects|Renovations)\/./.test(op.pre_path)) return false;
    const doc = op.doc_id ? one<DocumentRow>(ctx.db, "SELECT * FROM documents WHERE id = ?", op.doc_id) : undefined;
    const facts = doc?.facts_json ? (JSON.parse(doc.facts_json) as DocFacts) : null;
    const l = matchLesson(auto, op.pre_name ?? "", facts);
    if (!l || l.place !== op.new_path) return false;
    used.add(l.id);
  }
  approvePlan(ctx, plan.id, { contentHash: plan.content_hash, clientRequestId: `standing-${plan.id}` });
  kvSet(ctx.db, `standing.plan.${plan.id}`, [...used].join(","));
  logEvent(ctx.db, plan.workspace_id, "approved", `Kiki is filing "${plan.title}" on her own, as you allowed.`);
  return true;
}
