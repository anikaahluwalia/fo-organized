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
  const where = Boolean(plan && isQuestion(ctx, plan));
  const body = status
    ? `<section class="status">
  ${status.done ? `<div class="check" aria-hidden="true">${ICON.check}</div>` : ""}
  <h1>${esc(status.title)}</h1>
  <p>${esc(status.text)}</p>
  ${status.next ? `<p class="next">${esc(status.next)}</p>` : ""}
</section>
${status.done && recent ? `<details><summary>The proposal</summary>${plan ? cards(ctx, plan) : `<pre>${esc(proposal)}</pre>`}</details>` : ""}`
    : `<span class="pill">${where ? "Kiki needs a folder" : "Awaiting your answer"}</span>
<h1>${esc(lead ? lead[0]!.toUpperCase() + lead.slice(1) : proposal)}</h1>
<p class="lede">${where ? "Pick where it goes. Nothing moves until you answer." : "Review exactly what Kiki will change."}</p>
${note ? `<p class="note">${esc(note)}</p>` : ""}
${question ? `<div class="ask"><strong>Fo asks:</strong><br>${esc(question)}</div>` : ""}
${plan ? cards(ctx, plan) : ""}
${where ? whereForm(unplacedNotes(plan!)) : decideForm}
<p class="foot">Your answer goes to Fo, and Fo texts you what happens.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Kiki</title>
<style>
:root{--bg:#fbfaf9;--surface:#fff;--ink:#33211c;--muted:#6b5a54;--line:#e6dfdb;--strong-line:#d3c8c3;--accent:#b0435c;--pill-bg:#fae6eb;--pill-ink:#7f2c41;--primary:#33211c;--on-primary:#fff;--avatar:#fff;--ok:#2f7a4a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f0f;--surface:#171717;--ink:#f2f0ef;--muted:#a8a3a0;--line:#2e2e2e;--strong-line:#3d3d3d;--accent:#f0b3c1;--pill-bg:#33242a;--pill-ink:#f3cbd5;--primary:#ededed;--on-primary:#141414;--avatar:#f6eeee;--ok:#93d3a6;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--strong-line)}
.avatar{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--avatar);overflow:hidden;flex:none}
.brand{color:var(--accent);font-size:30px;font-weight:500;letter-spacing:-.04em;line-height:1}
.from{margin-left:auto;color:var(--muted);font-size:15px}
main{max-width:720px;margin:0 auto;padding:28px 20px 48px;display:flex;flex-direction:column;align-items:flex-start;gap:18px}
main>*{max-width:100%}
h1{margin:0;font-size:26px;line-height:1.25;font-weight:600;letter-spacing:-.02em;overflow-wrap:anywhere}
p{margin:0}.lede,.foot{color:var(--muted)}.foot{font-size:15px}
.pill{display:inline-block;padding:7px 14px;border-radius:8px;background:var(--pill-bg);color:var(--pill-ink);font-size:15px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px;color:var(--muted);margin:0}
.ask{border-left:2px solid var(--accent);padding:2px 0 2px 14px;overflow-wrap:anywhere}
.note{border-left:2px solid var(--accent);padding:2px 0 2px 14px}
form{display:flex;flex-direction:column;gap:12px;width:100%}form>button:not(.place){align-self:flex-start}
.row{display:flex;flex-wrap:wrap;gap:10px}
button{font:inherit;font-size:17px;min-height:52px;padding:12px 26px;border-radius:999px;border:1px solid var(--strong-line);background:var(--surface);color:var(--ink);cursor:pointer}
.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}
button:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
label{display:block;font-size:17px;font-weight:500;margin:10px 0 0}
textarea{width:100%;font:inherit;font-size:17px;border:1px solid var(--strong-line);border-radius:16px;padding:14px 16px;background:var(--surface);color:var(--ink);min-height:110px;resize:vertical}
textarea::placeholder{color:var(--muted)}
.status{align-self:stretch;text-align:center;padding:40px 0 24px;display:flex;flex-direction:column;align-items:center;gap:10px}
.status h1{font-size:30px}.status p{max-width:34ch;color:var(--muted)}.status .next{margin-top:8px;color:var(--ink);font-weight:500}
.check{display:grid;place-items:center;width:60px;height:60px;margin-bottom:8px;border-radius:50%;border:1.5px solid var(--ok);color:var(--ok)}
.cards{list-style:none;padding:0;margin:0;width:100%;border-top:1px solid var(--strong-line)}
.card{display:grid;grid-template-columns:auto minmax(0,1fr);gap:0 18px;padding:18px 0;border-bottom:1px solid var(--strong-line)}
.card svg,.check svg{display:block}.card .icon{color:var(--muted);padding-top:2px}
.card .name{font-size:17px;font-weight:500;overflow-wrap:anywhere}.card .to,.small,.why{color:var(--muted);overflow-wrap:anywhere}.card .to strong{color:var(--ink);font-weight:500}.why{font-size:14px;margin-top:4px}
.more{color:var(--muted);font-size:15px}
.place{width:100%;text-align:left;border-radius:14px}
details{width:100%;border-top:1px solid var(--line);padding-top:12px}summary{color:var(--muted);font-size:15px;cursor:pointer}details[open] summary{margin-bottom:12px}
.steps{border-top:0;padding-top:0}
</style></head><body>
<header class="top"><span class="avatar">${KIKI}</span><span class="brand">kiki</span><span class="from">Review from Fo</span></header>
<main>
${body}
</main></body></html>`;
}

/** Kiki's face for the page's header (decorative). */
const KIKI = `<svg viewBox="148 218 920 740" width="40" height="32" aria-hidden="true" focusable="false"><path fill="#F59FAC" d="M1045 600C1047 646 1045 697 1029 740C1014 782 985 826 952 855C918 885 870 902 829 916C789 929 747 930 709 934C670 938 636 938 600 939C564 940 529 941 490 938C451 935 408 933 368 919C328 905 281 885 250 854C219 824 194 779 181 736C167 694 166 644 169 600C172 556 182 509 199 470C216 430 241 390 271 361C300 331 340 309 377 293C413 276 454 270 491 264C528 257 563 255 600 254C637 252 671 255 711 258C752 260 804 251 842 267C881 282 914 318 943 351C972 384 999 423 1016 465C1033 506 1043 554 1045 600Z"/><ellipse cx="412" cy="622" rx="39" ry="52" fill="#3A2620"/><ellipse cx="787" cy="604" rx="39" ry="52" fill="#3A2620"/><path d="M585 710C612 711 640 700 668 666" fill="none" stroke="#3A2620" stroke-width="22" stroke-linecap="round"/></svg>`;

const svg = (d: string, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
const ICON = {
  check: svg("M5 12.5l4.5 4.5L19 7", 30),
  move: svg("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 14h6M13 12l2 2-2 2"),
  copy: svg("M9 9h10v12H9zM5 15V3h10"),
  where: svg("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10.5 11.5a1.5 1.5 0 1 1 2 1.4c-.4.2-.5.5-.5.9M12 16.5v.01"),
};

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
    return `<li class="card"><span class="icon">${copy ? ICON.copy : ICON.move}</span><div><div class="name">${esc(o.pre_name ?? o.new_name ?? "")}</div>
  <div class="to">${copy ? "Set aside as a copy" : `&rarr; <strong>${esc(displayFolder(o.new_path) || "the main folder")}</strong>`}</div>
  ${renamed ? `<div class="small">New name: ${esc(o.new_name!)}</div>` : ""}
  ${o.reason ? `<div class="why">${esc(o.reason)}</div>` : ""}</div></li>`;
  };
  const tidy = moves.length - fresh.length;
  // Files Kiki asks about: which one, and why she can't tell.
  const asked = unplacedNotes(plan).map((n) => `<li class="card"><span class="icon">${ICON.where}</span><div><div class="name">${esc(n.name)}</div><div class="why">Kiki couldn't tell which project or folder it belongs to.</div></div></li>`);
  if (!moves.length) return asked.length ? `<ul class="cards">${asked.join("")}</ul>` : "";
  return `${fresh.length || asked.length ? `<ul class="cards">${fresh.map(card).join("")}${asked.join("")}</ul>` : ""}
${tidy ? `<p class="more">Also tidies ${tidy} file${tidy === 1 ? "" : "s"} already filed.</p>` : ""}
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
