/**
 * Answering from Fo's text. A text reply can't be tied to Kiki's request (it starts a separate Fo
 * conversation), so each text Kiki has Fo send ends with a link to a small page for that one
 * proposal. Your answer there goes to Fo on the request's own conversation, exactly like the
 * answer box in Kiki, so it stays linked; Fo reports your decision and texts you what happened.
 *
 * The link is the only thing a phone can reach: an unguessable token, stored only as a hash, that
 * opens this one request until it's settled or expires. Nothing else in Kiki is served to it.
 */
import { createHash, randomBytes } from "node:crypto";
import { kvGet, kvSet, one, type PlanRow } from "../db.ts";
import { notFound } from "../errors.ts";
import { getTask } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { LINK_ONLY, LINK_OR_TEXT, notifyText, replyState, replyWindowMs } from "./notify.ts";
import { READING_ANSWER, replyToTask } from "./outreach.ts";

const key = (token: string) => `answer.link.${createHash("sha256").update(token).digest("hex")}`;

/** A link to answer this request, when Kiki has a public address; null otherwise. */
export function answerLink(ctx: Ctx, taskId: string): string | null {
  if (!ctx.publicUrl) return null;
  const token = randomBytes(24).toString("base64url");
  kvSet(ctx.db, key(token), taskId);
  kvSet(ctx.db, `answer.linked.${taskId}`, "1");
  return `${ctx.publicUrl}/a/${token}`;
}

function requestFor(ctx: Ctx, token: string): string {
  const taskId = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? kvGet(ctx.db, key(token)) : null;
  if (!taskId) throw notFound("This link doesn't work. Ask Fo for the proposal again.");
  return taskId;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Where the request stands, in plain words, or null while it's waiting for you. */
function settled(ctx: Ctx, taskId: string): string | null {
  const r = replyState(ctx, taskId);
  if (!r) return "There's nothing to answer here.";
  const plan = one<PlanRow>(ctx.db, "SELECT status, content_hash FROM plans WHERE id = ?", r.planId);
  if (r.status === "approved") return "You said yes. Kiki is applying it, and Fo will text you when it's done.";
  if (r.status === "declined") return "You said no, so nothing changes.";
  if (r.status === "adjusting" || r.status === "revised") return "You asked for changes. Fo will text you the new version.";
  if (r.status === "not_changed") return `Kiki didn't change the proposal. ${r.revision?.note ?? ""}`.trim();
  if (r.status !== "waiting" || !plan || plan.status !== "proposed" || plan.content_hash !== r.contentHash) return "This proposal has changed or been settled. Fo will text you the current one.";
  if (!r.requestedAt || Date.now() - Date.parse(r.requestedAt) > replyWindowMs(ctx, taskId)) return "This request expired. Ask Fo for the proposal again.";
  // Your answer is with Fo (a second tap, or a reload, lands here): no form until Fo has answered.
  if ((r.answers?.length ?? 0) > 0 && ["pending", "asking", "working"].includes(getTask(ctx.db, taskId)?.state ?? "")) return READING_ANSWER;
  return null;
}

/** The answer page: the proposal Fo texted you, Fo's question if it asked one, and the answer form. */
export function answerPage(ctx: Ctx, token: string, notice?: string): string {
  const taskId = requestFor(ctx, token);
  const task = getTask(ctx.db, taskId);
  // The text as Fo sent it, without its own link (you're on that page).
  const proposal = (notifyText(ctx, taskId) ?? "").replace(/\s*Answer here: \S+\s*$/, "").replace(LINK_ONLY, "").replace(LINK_OR_TEXT, "").trim();
  const done = settled(ctx, taskId);
  const question = task?.state === "needs_user_input" && task.question ? task.question.replace(/^\W*KIKI-(DECISION|STATUS)\s*:.*$/gim, "").trim() : null;
  const form = done
    ? `<p class="note">${esc(done)}</p>`
    : `<form method="post">
  <div class="row">
    <button name="answer" value="Yes, go ahead" class="primary">Yes, go ahead</button>
    <button name="answer" value="No, leave it as it is">No</button>
  </div>
  <label for="other">Or say what you'd like: a change, or a question</label>
  <textarea id="other" name="other" rows="3" placeholder="Put the licence in Business, skip the second one…"></textarea>
  <button name="answer" value="other">Send to Fo</button>
</form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kiki</title>
<style>
:root{--bg:#fff7f9;--ink:#3a2620;--muted:#7a6460;--line:#f0d5dc;--accent:#3a2620}
@media (prefers-color-scheme:dark){:root{--bg:#1f1719;--ink:#f7e9ec;--muted:#c9b3b8;--line:#4a3438;--accent:#f4b6c4}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted);font-size:14px;margin:0 0 16px}
pre{white-space:pre-wrap;font:inherit;background:transparent;border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 16px}
.ask{border-left:3px solid var(--accent);padding:4px 12px;margin:0 0 16px}
.row{display:flex;gap:8px;margin:0 0 16px}button{font:inherit;padding:12px 16px;border-radius:999px;border:1px solid var(--ink);background:transparent;color:var(--ink)}
.primary{background:var(--accent);color:var(--bg);border-color:var(--accent);flex:1}
label{display:block;font-size:14px;color:var(--muted);margin:0 0 6px}textarea{width:100%;box-sizing:border-box;font:inherit;border:1px solid var(--line);border-radius:12px;padding:10px;background:transparent;color:var(--ink);margin:0 0 10px}
.note{border:1px solid var(--line);border-radius:12px;padding:12px}
</style></head><body><main>
<h1>Kiki</h1><p class="muted">Your answer goes to Fo, and Fo texts you what happens.</p>
${notice ? `<p class="note">${esc(notice)}</p>` : ""}
${question ? `<div class="ask"><strong>Fo asks:</strong><br>${esc(question)}</div>` : ""}
<pre>${esc(proposal)}</pre>
${form}
</main></body></html>`;
}

/** Your answer from the page: sent to Fo on the request's own conversation, like the answer box in Kiki. */
export async function submitAnswer(ctx: Ctx, token: string, body: Record<string, string>): Promise<string> {
  const taskId = requestFor(ctx, token);
  const done = settled(ctx, taskId);
  if (done) return answerPage(ctx, token);
  const answer = (body.answer === "other" ? body.other : body.answer)?.trim() ?? "";
  if (!answer) return answerPage(ctx, token, "Write what you'd like, then send it.");
  await replyToTask(ctx, taskId, answer);
  return answerPage(ctx, token, `Sent to Fo: "${answer}".`);
}
