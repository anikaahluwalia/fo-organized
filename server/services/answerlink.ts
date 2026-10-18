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
import { all, kvGet, kvSet, one, type PlanOpRow, type PlanRow } from "../db.ts";
import { inDuplicatesFolder } from "../domain/duplicates.ts";
import { proposalLines } from "./proposal.ts";
import { notFound } from "../errors.ts";
import { getTask } from "../fo/engine.ts";
import type { Ctx } from "./context.ts";
import { alreadyFiled, displayFolder, isQuestion, LINK_LINE, LINK_ONLY, LINK_ONLY_WHERE, LINK_OR_TEXT, LINK_OR_TEXT_WHERE, notifyPurpose, notifyText, unplacedNotes, replyState, replyWindowMs } from "./notify.ts";
import { replyToTask } from "./outreach.ts";

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

/** Where things stand once you've answered (or the request is over), or null while it waits for you. */
interface Status {
  title: string;
  text: string;
  /** What happens next, shown on its own line. */
  next?: string;
  /** A check mark for "Fo has your answer", rather than a plain note. */
  done: boolean;
}


function settled(ctx: Ctx, taskId: string): Status | null {
  const r = replyState(ctx, taskId);
  if (!r) return { title: "Nothing to answer", text: "There's nothing waiting for you here.", done: false };
  if (notifyPurpose(ctx, taskId) === "offer") {
    // An offer to file a kind of document on her own: there's no plan, only that lesson.
    if (r.status === "approved") return { title: "You said yes", text: "Kiki will file these on her own and text you each time. You can stop that in the Kiki app.", next: "You can close this tab.", done: true };
    if (r.status === "declined") return { title: "Got it", text: "Kiki will keep asking you first.", next: "You can close this tab.", done: true };
    const l = one<{ auto: number }>(ctx.db, "SELECT auto FROM lessons WHERE id = ?", r.planId);
    if (r.status !== "waiting" || !l || l.auto) return { title: "This one's settled", text: "You can change it in the Kiki app.", done: false };
    if ((r.answers?.length ?? 0) > 0 && ["pending", "asking", "working"].includes(getTask(ctx.db, taskId)?.state ?? "")) return { title: "Got it!", text: `You said "${r.answers!.at(-1)!.text}".`, next: "You can close this tab. Fo will let you know.", done: true };
    return null;
  }
  const plan = one<PlanRow>(ctx.db, "SELECT status, content_hash FROM plans WHERE id = ?", r.planId);
  if (r.status === "approved") {
    return plan?.status === "applied"
      ? { title: "All done", text: "Kiki filed it and checked every change in Drive.", next: "You can close this tab.", done: true }
      : { title: "You said yes", text: "Kiki is filing it now.", next: "You can close this tab. Fo will text you when it's done.", done: true };
  }
  if (r.status === "declined") return { title: "Nothing changes", text: "You said no, so Kiki leaves everything as it is.", next: "You can close this tab.", done: true };
  if (r.status === "adjusting" || r.status === "revised") return { title: "Got it!", text: "Kiki is making the changes you asked for.", next: "You can close this tab. Fo will text you the new version.", done: true };
  if (r.status === "not_changed") return { title: "Kiki didn't change it", text: `${r.revision?.note ?? ""} Fo will text you about it.`.trim(), done: false };
  if (r.status !== "waiting" || !plan || plan.status !== "proposed" || plan.content_hash !== r.contentHash) return { title: "This one's settled", text: "This proposal has changed or been settled. Fo will text you the current one.", done: false };
  if (!r.requestedAt || Date.now() - Date.parse(r.requestedAt) > replyWindowMs(ctx, taskId)) return { title: "This link expired", text: "Ask Fo for the proposal again.", done: false };
  // Your answer is with Fo (just sent, or a reload): no form until Fo has answered.
  if ((r.answers?.length ?? 0) > 0 && ["pending", "asking", "working"].includes(getTask(ctx.db, taskId)?.state ?? "")) {
    const said = r.answers!.at(-1)!.text;
    return { title: "Got it!", text: said ? `You said "${said}".` : "Fo has your answer.", next: "You can close this tab. Fo will let you know what happens.", done: true };
  }
  return null;
}

/** The answer page: the proposal Fo texted you, Fo's question if it asked one, and the answer form; once you've answered, where things stand. */
export function answerPage(ctx: Ctx, token: string, notice?: string): string {
  const taskId = requestFor(ctx, token);
  const task = getTask(ctx.db, taskId);
  // The text as Fo sent it, without its own link (you're on that page).
  let proposal = (notifyText(ctx, taskId) ?? "").replace(LINK_LINE, "").replace(/\s*Answer here: \S+\s*$/, "");
  for (const line of [LINK_ONLY, LINK_OR_TEXT, LINK_ONLY_WHERE, LINK_OR_TEXT_WHERE]) proposal = proposal.replace(line, "");
  proposal = proposal.trim();
  // On the page itself: no "Kiki:" (it's her page) and no "tap to answer" (the answers are right here).
  const lead = proposal.replace(/^Kiki:\s*/, "").replace(/\s*(?:Reply|Tap)\b[^?!]*$/, "").trim();
  const status = settled(ctx, taskId);
  const state = replyState(ctx, taskId);
  const plan = state ? one<PlanRow>(ctx.db, "SELECT * FROM plans WHERE id = ?", state.planId) : null;
  // The proposal stays on the page only while the request is fresh (from your last answer): an old
  // link, in a message history or a screenshot, says where things stand but not what was in it.
  const lastAt = Math.max(...[state?.at, state?.requestedAt, ...(state?.answers ?? []).map((a) => a.at)].map((t) => (t ? Date.parse(t) : 0)));
  const recent = Date.now() - lastAt <= replyWindowMs(ctx, taskId);
  // Kiki's word on your last answer, if it didn't settle anything (a yes to "where does it go?").
  const note = notice ?? state?.note;
  const question = task?.state === "needs_user_input" && task.question ? task.question.replace(/^\W*KIKI-(DECISION|STATUS)\s*:.*$/gim, "").trim() : null;
  const body = status
    ? `<section class="status">
  ${status.done ? `<div class="check" aria-hidden="true">&#10003;</div>` : ""}
  <h1>${esc(status.title)}</h1>
  <p>${esc(status.text)}</p>
  ${status.next ? `<p class="next">${esc(status.next)}</p>` : ""}
</section>
${status.done && recent ? `<details><summary>The proposal</summary>${plan ? cards(ctx, plan) : `<pre>${esc(proposal)}</pre>`}</details>` : ""}`
    : `<h1>Kiki</h1><p class="muted">Your answer goes to Fo, and Fo texts you what happens.</p>
${note ? `<p class="note">${esc(note)}</p>` : ""}
${question ? `<div class="ask"><strong>Fo asks:</strong><br>${esc(question)}</div>` : ""}
<p class="lead">${esc(lead ? lead[0]!.toUpperCase() + lead.slice(1) : proposal)}</p>
${plan ? cards(ctx, plan) : ""}
${plan && isQuestion(ctx, plan) ? whereForm(unplacedNotes(plan)) : decideForm}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kiki</title>
<style>
:root{--bg:#fff7f9;--ink:#3a2620;--muted:#7a6460;--line:#f0d5dc;--accent:#3a2620;--ok:#2f7d4f}
@media (prefers-color-scheme:dark){:root{--bg:#1f1719;--ink:#f7e9ec;--muted:#c9b3b8;--line:#4a3438;--accent:#f4b6c4;--ok:#8fd4a8}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted);font-size:14px;margin:0 0 16px}
pre{white-space:pre-wrap;font:inherit;background:transparent;border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 16px}
.ask{border-left:3px solid var(--accent);padding:4px 12px;margin:0 0 16px}
.row{display:flex;gap:8px;margin:0 0 16px}button{font:inherit;padding:12px 16px;border-radius:999px;border:1px solid var(--ink);background:transparent;color:var(--ink)}
.primary{background:var(--accent);color:var(--bg);border-color:var(--accent);flex:1}
label{display:block;font-size:14px;color:var(--muted);margin:0 0 6px}textarea{width:100%;box-sizing:border-box;font:inherit;border:1px solid var(--line);border-radius:12px;padding:10px;background:transparent;color:var(--ink);margin:0 0 10px}
.note{border:1px solid var(--line);border-radius:12px;padding:12px}
.status{text-align:center;padding:48px 8px 32px}.status h1{font-size:24px;margin:0 0 8px}.status p{margin:0 auto;max-width:34ch;color:var(--muted)}.status .next{margin-top:16px;color:var(--ink);font-weight:600}
.check{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;background:var(--ok);color:var(--bg);font-size:30px;line-height:56px}
.lead{font-size:17px;margin:0 0 14px}.cards{list-style:none;padding:0;margin:0 0 12px}.card{border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 8px}
.card .name{font-size:14px;color:var(--muted);word-break:break-word}.card .to{margin:2px 0}.small{font-size:14px;word-break:break-word}.why{font-size:13px;color:var(--muted);margin-top:4px}
.steps{border-top:0;padding-top:0;margin:0 0 16px}.steps pre{font-size:13px}
.label{font-weight:600;margin:0 0 10px}.place{display:block;width:100%;text-align:left;margin:0 0 8px;border-radius:12px;border-color:var(--line)}
details{border-top:1px solid var(--line);padding-top:12px}summary{color:var(--muted);font-size:14px;cursor:pointer;margin:0 0 12px}
</style></head><body><main>
${body}
</main></body></html>`;
}

/**
 * The proposal as you'd check it on a phone: each file you just added, where it goes and any new
 * name, with Kiki's reason; then what else it tidies; then every step, exactly, under a fold.
 */
function cards(ctx: Ctx, plan: PlanRow): string {
  const moves = all<PlanOpRow>(ctx.db, "SELECT * FROM plan_ops WHERE plan_id = ? AND kind = 'move_rename' AND state <> 'excluded' ORDER BY seq", plan.id);
  const fresh = moves.filter((o) => !alreadyFiled(o.pre_path));
  const card = (o: PlanOpRow) => {
    const copy = Boolean(o.new_path && inDuplicatesFolder(o.new_path));
    const renamed = o.new_name && o.pre_name && o.new_name !== o.pre_name && !copy;
    return `<li class="card"><div class="name">${esc(o.pre_name ?? o.new_name ?? "")}</div>
  <div class="to">${copy ? "Set aside as a copy" : `&rarr; <strong>${esc(displayFolder(o.new_path) || "the main folder")}</strong>`}</div>
  ${renamed ? `<div class="small">New name: ${esc(o.new_name!)}</div>` : ""}
  ${o.reason ? `<div class="why">${esc(o.reason)}</div>` : ""}</li>`;
  };
  const tidy = moves.length - fresh.length;
  // Files Kiki asks about: which one, and why she can't tell.
  const asked = unplacedNotes(plan).map((n) => `<li class="card"><div class="name">${esc(n.name)}</div><div class="why">Kiki couldn't tell which project or folder it belongs to.</div></li>`);
  if (!moves.length) return asked.length ? `<ul class="cards">${asked.join("")}</ul>` : "";
  return `${fresh.length || asked.length ? `<ul class="cards">${fresh.map(card).join("")}${asked.join("")}</ul>` : ""}
${tidy ? `<p class="muted">Also tidies ${tidy} file${tidy === 1 ? "" : "s"} already filed.</p>` : ""}
<details class="steps"><summary>Every step</summary><pre>${esc(proposalLines(ctx, plan))}\nNothing is deleted.</pre></details>`;
}

const decideForm = `<form method="post">
  <div class="row">
    <button name="answer" value="Yes, go ahead" class="primary">Yes, go ahead</button>
    <button name="answer" value="No, leave it as it is">No</button>
  </div>
  <label for="other">Or say what you'd like: a change, or a question</label>
  <textarea id="other" name="other" rows="3" placeholder="Put the licence in Business, skip the second one…"></textarea>
  <button name="answer" value="other">Send to Fo</button>
</form>`;

/** "Where does this go?" has no yes: a place that fits, one you type, or leaving it where it is. */
function whereForm(files: { name: string; options: string[] }[]): string {
  const one = files.length === 1;
  const places = one ? files[0]!.options.slice(0, 3) : [];
  return `<form method="post">
  ${places.map((p) => `<button name="answer" value="${esc(`Put it in ${p}`)}" class="place">${esc(displayFolder(p))}</button>`).join("\n  ")}
  <label for="other">${places.length ? "Or type a project or folder" : "Type a project or folder"}</label>
  <textarea id="other" name="other" rows="2" placeholder="${one ? "Work, or Projects/Kitchen…" : "Put the timesheet in Work, the receipt in Kitchen…"}"></textarea>
  <div class="row">
    <button name="answer" value="other" class="primary">Send to Fo</button>
    <button name="answer" value="${one ? "Leave it where it is" : "Leave them where they are"}">${one ? "Leave it where it is" : "Leave them"}</button>
  </div>
</form>`;
}

/**
 * Your answer from the page: sent to Fo on the request's own conversation, like the answer box in
 * Kiki. Null once it's sent: the page then redirects to itself, which shows where things stand (and
 * a reload doesn't post it again). Otherwise the page to show.
 */
export async function submitAnswer(ctx: Ctx, token: string, body: Record<string, string>): Promise<string | null> {
  const taskId = requestFor(ctx, token);
  if (settled(ctx, taskId)) return null;
  const answer = (body.answer === "other" ? body.other : body.answer)?.trim() ?? "";
  if (!answer) return answerPage(ctx, token, "Write what you'd like, then send it.");
  await replyToTask(ctx, taskId, answer);
  return null;
}
