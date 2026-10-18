/**
 * Fo brings a proposal to you. Kiki sends Fo the exact proposal and asks it to explain it and ask
 * you; you answer in Kiki, on the same conversation, and Fo reports your decision bound to that
 * exact version. When you ask for changes, Kiki makes a new version and sends it to the same
 * conversation, where it needs its own decision.
 */
import { randomUUID } from "node:crypto";
import { validateChanges } from "../domain/adjust.ts";
import { inert } from "../domain/inert.ts";
import { approvalInstructions, type ApprovalBinding } from "../domain/approval.ts";
import { kvGet, kvSet, logEvent, now, one, tx, type PlanRow, type WorkspaceRow } from "../db.ts";
import { conflict } from "../errors.ts";
import { getTask, insertTask } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { notifyPurpose, replyState, saveReply, textProposal } from "./notify.ts";
import { adjustOrganize, getPlan } from "./plans.ts";
import { proposalItems, proposalLines } from "./proposal.ts";

function decideMessage(ctx: Ctx, ws: WorkspaceRow, plan: PlanRow, binding: ApprovalBinding, lead: string): string {
  return `${lead} Please explain it to me here in plain words, in two or three short sentences (name the files and where they'd go; skip folder paths, the index and version numbers unless I ask), and ask me what I'd like to do. Don't message anyone else, and don't change any files yourself: Kiki does that after I decide.

Kiki's proposal for my Drive folder "${inert(ws.name)}" (version ${plan.version}): ${inert(plan.summary)}
${proposalLines(ctx, plan)}
Nothing is deleted.

I can say yes or no, ask about it, or ask for changes: skip a file, rename one, keep a name, put a file somewhere else, or say where a file that isn't moved should go.

${approvalInstructions(binding)}`;
}

/** A request to Fo about one proposal version: its task, binding and what Kiki asked. */
/**
 * A new request for your decision on `plan`. In Kiki, Fo brings it to you with `message`; by text
 * (`texted`), the text is queued and goes out on its own, so there's no message to send here.
 */
function newRequest(ctx: Ctx, plan: PlanRow, message: (binding: ApprovalBinding) => string, texted?: (taskId: string) => void): { taskId: string; message: string; byText: boolean } {
  const taskId = insertTask(ctx.db, "notify", ctx.engine.mode);
  const binding: ApprovalBinding = { requestId: randomUUID(), planId: plan.id, contentHash: plan.content_hash };
  kvSet(ctx.db, `notify.purpose.${taskId}`, texted ? "find" : "decide");
  if (texted) kvSet(ctx.db, `notify.plan.${plan.id}`, taskId);
  kvSet(ctx.db, `decide.plan.${plan.id}`, taskId);
  saveReply(ctx, taskId, { status: "waiting", text: null, source: null, ...binding, requestedAt: now() });
  if (texted) {
    texted(taskId);
    return { taskId, message: "", byText: true };
  }
  const text = message(binding);
  kvSet(ctx.db, `notify.text.${taskId}`, text);
  return { taskId, message: text, byText: false };
}

/**
 * Asks Fo to bring this proposal to you, here in Kiki. One request per proposal version: asking
 * again while one is open shows the open one instead of sending another.
 */
export function askThroughFo(ctx: Ctx, planId: string): { taskId: string; created: boolean } {
  const plan = getPlan(ctx.db, planId);
  if (plan.status !== "proposed") throw conflict("Only a proposal that's waiting for your decision can go to Fo.", "stale_plan");
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ? AND active = 1", plan.workspace_id);
  if (!ws) throw conflict("That proposal belongs to a folder Kiki isn't working on now.", "stale_plan");
  const open = kvGet(ctx.db, `decide.plan.${plan.id}`);
  const openTask = open ? getTask(ctx.db, open) : undefined;
  if (open && openTask && openTask.state !== "failed" && replyState(ctx, open)?.status === "waiting") return { taskId: open, created: false };
  const { taskId, message } = tx(ctx.db, () => {
    const request = newRequest(ctx, plan, (binding) => decideMessage(ctx, ws, plan, binding, `Kiki has a proposal for my Drive folder and needs my decision.`));
    logEvent(ctx.db, ws.id, "fo_text", `Kiki asked ${ctx.engine.mode === "mock" ? "Mock Fo" : "Fo"} to bring you "${plan.title}" (version ${plan.version}).`);
    return request;
  });
  void ctx.engine.start(taskId, message).catch(() => undefined);
  return { taskId, created: true };
}

/**
 * You asked for changes (Fo's bound decision said so): Kiki reads what you asked for, makes the new
 * version and sends it to the same Fo conversation for its own decision. When she can't tell what
 * to change, she says so there instead of guessing. Safe to run again: it acts only while the
 * request is still "adjusting", and records the new version before anything is sent.
 */
export async function handleChangeRequest(ctx: Ctx, taskId: string, opts: { quiet?: boolean } = {}): Promise<void> {
  let state = replyState(ctx, taskId);
  const task = getTask(ctx.db, taskId);
  if (!state || !task?.conversation_id) return;
  if (opts.quiet) {
    // Fo reported a clarification: read your latest answer once, and act only if it asks for a change.
    const answer = state.answers?.at(-1);
    if (state.status !== "waiting" || !answer || state.interpretedAt === answer.at) return;
    saveReply(ctx, taskId, { ...state, interpretedAt: answer.at });
    state = { ...state, interpretedAt: answer.at, text: answer.text };
  } else if (state.status !== "adjusting") return;
  if (!state.text) return;
  const asked = state;
  const conversationId = task.conversation_id;
  const plan = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", asked.planId);
  const ws = plan ? one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ? AND active = 1", plan.workspace_id) : undefined;
  if (!plan || !ws || plan.status !== "proposed" || plan.content_hash !== asked.contentHash) {
    if (!opts.quiet) saveReply(ctx, taskId, { ...asked, status: "stale" });
    return;
  }
  const items = proposalItems(ctx, plan);
  // Reading the answer can fail for a passing reason; the job tries again and nothing has changed yet.
  const request = plan.kind === "organize" ? await ctx.reader.interpretChange(items, asked.text!) : null;
  // Read quietly, only a clear request for a change goes further.
  if (opts.quiet && (!request || request.kind !== "changes" || Object.keys(validateChanges(items, request).changes).length === 0)) return;
  const followUp = tx(ctx.db, () => {
    const fresh = replyState(ctx, taskId);
    const current = one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", plan.id);
    if (fresh?.status !== (opts.quiet ? "waiting" : "adjusting") || current?.status !== "proposed" || current.content_hash !== asked.contentHash) return null;
    const notes: string[] = [];
    let next: PlanRow | null = null;
    if (!request) {
      notes.push("Kiki can only take this kind of proposal as it is, or not at all.");
    } else {
      const { changes, problems } = validateChanges(items, request);
      if (Object.keys(changes).length) {
        const adjusted = adjustOrganize(ctx, plan.id, changes);
        if (adjusted.changed) next = getPlan(ctx.db, adjusted.planId);
        else notes.push("Those changes are already in the proposal.");
      } else {
        notes.push(request.kind === "question" ? `That sounds like a question about the proposal ("${inert(request.question ?? state.text, 200)}").` : "Kiki couldn't find a change to make in that answer.");
      }
      notes.push(...problems);
      if (request.unsupported.length) notes.push(`Kiki can't do this from a proposal: ${request.unsupported.map((u) => `"${inert(u, 120)}"`).join(", ")}.`);
    }
    const note = notes.join(" ") || null;
    const target = next ?? plan;
    const said = `"${inert(state.text, 300)}"`;
    const lead = next
      ? `I asked for changes (${said}), and Kiki made version ${next.version} of the proposal.${note ? ` ${note}` : ""}`
      : `I answered ${said}, but Kiki didn't change the proposal. ${note ?? ""}`.trim();
    // The proposal reached you as a text (you answered by text, or at its link): the next version
    // comes back to you as a text too, with its own link.
    const byText = Boolean(state.answers?.at(-1)?.via) || notifyPurpose(ctx, taskId) === "find";
    const sent = newRequest(ctx, target, (binding) => decideMessage(ctx, ws, target, binding, lead), byText ? (id) => void textProposal(ctx, target, id, next ? "revised" : "unchanged", note ?? undefined) : undefined);
    saveReply(ctx, taskId, { ...state, status: next ? "revised" : "not_changed", revision: { planId: next?.id ?? null, version: next?.version ?? null, note } });
    logEvent(ctx.db, ws.id, "plan", next ? `You asked for changes through Fo, so Kiki made version ${next.version} of "${next.title}". It needs your decision.` : `You answered through Fo, but Kiki didn't change the proposal. ${note ?? ""}`.trim());
    return sent;
  });
  // A texted version is on its way (queued with its text); one in Kiki goes to the same conversation.
  if (followUp && !followUp.byText) await ctx.engine.startInConversation(followUp.taskId, conversationId, followUp.message).catch(() => undefined);
}
