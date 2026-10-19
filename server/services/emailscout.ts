/**
 * Files that arrive by email. Kiki is for your files, not your email: Fo reads your email, so Fo
 * looks. Once you turn this on, Kiki asks Fo to check your Gmail twice a day for emails with a
 * document attached and to text you about them first. When you tell Fo yes, Fo saves the
 * attachment in its Drive, shares it with your Kiki account and ends its reply with a hand-over
 * line; Fo's webhook brings that reply to Kiki, who copies the file into your folder. From there
 * it's an ordinary new file: Kiki proposes where it goes (or files it on your standing OK).
 *
 * A hand-over can only bring one shared file into the folder. It can't move, rename or delete
 * anything, and Kiki never touches your email.
 */
import { kvGet, kvSet, logEvent } from "../db.ts";
import { sanitizeName } from "../domain/naming.ts";
import { inert } from "../domain/inert.ts";
import { conflict } from "../errors.ts";
import { insertTask, type TaskHandler } from "../fo/engine.ts";
import { DriveError } from "../google/types.ts";
import type { Ctx } from "./context.ts";
import { activeWorkspace, recordFile } from "./workspace.ts";

const SETTING = "settings.email_scout";
const MAX_BYTES = 5 * 1024 * 1024;
/** Hand-overs Kiki accepts in a day: plenty for a person's inbox, a ceiling if something goes wrong. */
const DAILY_LIMIT = 25;

export function emailScoutOn(ctx: Ctx): boolean {
  return kvGet(ctx.db, SETTING) === "on";
}

/** The account Fo shares files with: the Google account Kiki uses for Drive. */
async function kikiAccount(ctx: Ctx): Promise<string> {
  const c = await ctx.drive.connection();
  const account = c.state === "connected" ? c.account : null;
  if (!account) throw conflict("Connect Google Drive first, so Fo knows which account to share files with.");
  return account;
}

/** What Fo does on each check, spelled out in full (a scheduled run starts fresh each time). */
function routine(account: string): string {
  return `1. Look in my Gmail for emails received since your last Kiki email check that have a document attached (a PDF, a scan or photo of a document, a Word or Excel file), and that you haven't already asked me about.
2. If there are any, text me one short message listing each one (who it's from, the subject, the attachment's name) and ask which ones Kiki should file. If there are none, don't text me.
3. Never forward, reply to, delete, label or change any email, and don't contact anyone but me.
4. When I say yes to one or more of them, for each: save that attachment as a file in your Drive, share it with ${account} (viewer is enough), and end your reply to me with one line per file, exactly in this form and nothing else on the line:
KIKI-HANDOFF: <the shared file's Google Drive link>
Kiki, my file-organizing app, picks those lines up, copies the files into my folder and files them; if a place isn't clear, Kiki asks me where they go.`;
}

function askFo(ctx: Ctx, purpose: string, message: string): string {
  const taskId = insertTask(ctx.db, "scout", ctx.engine.mode);
  kvSet(ctx.db, `scout.purpose.${taskId}`, purpose);
  void ctx.engine.start(taskId, message).catch(() => undefined);
  return taskId;
}

/** You turn email checking on or off. On: Kiki asks Fo to set up the twice-daily check. */
export async function setEmailScout(ctx: Ctx, on: boolean): Promise<{ on: boolean }> {
  if (on === emailScoutOn(ctx)) return { on };
  const ws = activeWorkspace(ctx.db);
  if (on) {
    if (ctx.fo.mode === "live" && !ctx.foWebhook) throw conflict("Set up Fo's webhook first: it's how Fo's hand-overs reach Kiki.");
    const account = await kikiAccount(ctx);
    kvSet(ctx.db, SETTING, "on");
    askFo(
      ctx,
      "setup",
      `This comes from Kiki, the file-organizing app I connected to you. Please set up a recurring schedule called "Kiki email check" that runs every day at 9:00 and 17:00 my time and does this each time:\n\n${routine(account)}\n\nReply with the times it's set for. Don't text me now.`,
    );
    logEvent(ctx.db, ws?.id ?? null, "email_scout", "You turned on email checking: Kiki asked Fo to look for files in your email twice a day and ask you first.");
  } else {
    kvSet(ctx.db, SETTING, undefined);
    askFo(ctx, "stop", `This comes from Kiki, the file-organizing app I connected to you. Please cancel the recurring schedule called "Kiki email check". Don't text me.`);
    logEvent(ctx.db, ws?.id ?? null, "email_scout", "You turned off email checking: Kiki asked Fo to stop the twice-daily check.");
  }
  return { on };
}

/** You ask for a check now instead of waiting for the next one. */
export async function checkEmailNow(ctx: Ctx): Promise<{ taskId: string }> {
  if (!emailScoutOn(ctx)) throw conflict("Turn on email checking first.");
  const account = await kikiAccount(ctx);
  const taskId = askFo(ctx, "check", `This comes from Kiki, the file-organizing app I connected to you. Please run my Kiki email check once now:\n\n${routine(account)}`);
  logEvent(ctx.db, activeWorkspace(ctx.db)?.id ?? null, "email_scout", "Kiki asked Fo to check your email for files now.");
  return { taskId };
}

/** The Drive file a hand-over line points at, if it is one. */
export function handoffFileIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/^[ \t]*KIKI-HANDOFF:[ \t]*(\S+)[ \t]*$/gim)) {
    let url: URL;
    try {
      url = new URL(m[1]!);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname)) continue;
    const id = /\/d\/([A-Za-z0-9_-]{20,})/.exec(url.pathname)?.[1] ?? url.searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]{20,}$/.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * A hand-over from Fo: copies that one shared file into your folder, once, and Kiki takes it from
 * there. Safe to run again: the copy's Drive id is chosen first and remembered.
 */
export async function acceptHandoff(ctx: Ctx, fileId: string): Promise<void> {
  const ws = activeWorkspace(ctx.db);
  if (!ws || !emailScoutOn(ctx)) return;
  const key = `handoff.${fileId}`;
  const prior = JSON.parse(kvGet(ctx.db, key) ?? "null") as { state: "saving" | "saved" | "refused"; copyId: string } | null;
  if (prior?.state === "saved" || prior?.state === "refused") return;
  const day = `handoff.day.${new Date().toISOString().slice(0, 10)}`;
  if (!prior && Number(kvGet(ctx.db, day) ?? 0) >= DAILY_LIMIT) {
    logEvent(ctx.db, ws.id, "email_scout", `Fo handed over more files than Kiki takes in a day (${DAILY_LIMIT}). The rest wait until tomorrow.`);
    return;
  }
  const refuse = (why: string) => {
    kvSet(ctx.db, key, JSON.stringify({ state: "refused", copyId: "" }));
    logEvent(ctx.db, ws.id, "email_scout", why);
  };
  let shared;
  try {
    shared = await ctx.drive.getFile(fileId);
  } catch (err) {
    if (err instanceof DriveError && err.kind === "not_found") return refuse("Fo handed over a file Kiki can't open. Ask Fo to share it with your Kiki account again.");
    throw err;
  }
  const name = sanitizeName(shared.name) || "attachment";
  if (shared.mimeType.startsWith("application/vnd.google-apps.")) return refuse(`Fo handed over "${inert(name)}", a Google ${shared.mimeType.endsWith("folder") ? "folder" : "Doc"}, not a file. Kiki only brings in files.`);
  if (shared.size !== null && shared.size !== undefined && shared.size > MAX_BYTES) return refuse(`Fo handed over "${inert(name)}", which is larger than 5 MB. Save it to the folder yourself and Kiki will pick it up.`);

  const copyId = prior?.copyId ?? (await ctx.drive.generateIds(1))[0]!;
  if (!prior) {
    kvSet(ctx.db, key, JSON.stringify({ state: "saving", copyId }));
    kvSet(ctx.db, day, String(Number(kvGet(ctx.db, day) ?? 0) + 1));
  }
  let copy = await ctx.drive.getFile(copyId).catch((err) => {
    if (err instanceof DriveError && err.kind === "not_found") return null;
    throw err;
  });
  if (!copy) {
    const content = await ctx.drive.readContent(shared, MAX_BYTES);
    const data = content.kind === "pdf" || content.kind === "image" ? content.data : content.kind === "text" ? Buffer.from(content.text, "utf8") : null;
    if (!data) return refuse(`Fo handed over "${inert(name)}", which Kiki can't read (${content.kind === "unsupported" ? content.reason : "an unknown type"}).`);
    try {
      copy = await ctx.drive.createFile({ id: copyId, name, parentId: ws.root_file_id, mimeType: shared.mimeType, content: data });
    } catch (err) {
      if (err instanceof DriveError && (err.kind === "conflict" || err.delivery === "unknown")) copy = await ctx.drive.getFile(copyId);
      else throw err;
    }
  }
  recordFile(ctx.db, ws.id, copy, "", "supplied_by_user");
  kvSet(ctx.db, key, JSON.stringify({ state: "saved", copyId: copy.id }));
  logEvent(ctx.db, ws.id, "email_scout", `You told Fo yes: Kiki copied "${inert(copy.name)}" from your email into the folder.`);
  ctx.jobs.enqueue("read", `read:${ws.id}`, { workspaceId: ws.id });
}

/** A cut-off reply: reads the whole turn (by its run) and takes any hand-over lines from it. */
export async function lookupHandoff(ctx: Ctx, conversationId: string, runId: string | null): Promise<void> {
  const turns = await ctx.fo.getConversation(conversationId);
  const turn = turns.filter((t) => t.role === "assistant" && (!runId || (t as { runId?: string }).runId === runId)).at(-1);
  for (const fileId of handoffFileIds(turn?.text ?? "")) ctx.jobs.enqueue("handoff", `handoff:${fileId}`, { fileId });
}

/** Kiki's requests to Fo about email checking: Fo's reply is just shown; nothing waits on it. */
export const scoutHandler: TaskHandler = {
  onComplete: () => ({ question: null }),
  onStateChange: () => undefined,
};
