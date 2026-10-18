import { kvGet, kvSet, logEvent, now, one, run, tx, type DispatchRow, type OutcomeRow, type OutreachVersionRow, type WatchRow, type WorkspaceRow } from "../db.ts";
import { sanitizeName } from "../domain/naming.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { isPlainEmail, type GmailAttachment } from "../google/gmail.ts";
import { DriveError } from "../google/types.ts";
import type { Ctx } from "./context.ts";
import { recordFile } from "./workspace.ts";

/** Drive's simple (multipart) upload takes up to 5 MB. */
const MAX_SAVE_BYTES = 5 * 1024 * 1024;

const foundKey = (outcomeId: string) => `gmail.found.${outcomeId}`;
const savedKey = (wsId: string, a: Pick<GmailAttachment, "messageId" | "attachmentId">) => `gmail.saved.${wsId}.${a.messageId}.${a.attachmentId}`;

interface SavedState {
  state: "saving" | "saved";
  fileId: string;
  name: string;
}

function refs(ctx: Ctx, outcomeId: string) {
  const o = one<OutcomeRow>(ctx.db, "SELECT * FROM outcomes WHERE id = ?", outcomeId);
  if (!o) throw notFound("That update doesn't exist.");
  const w = one<WatchRow>(ctx.db, "SELECT * FROM watches WHERE id = ?", o.watch_id)!;
  const d = one<DispatchRow>(ctx.db, "SELECT * FROM dispatches WHERE id = ?", w.dispatch_id)!;
  const v = one<OutreachVersionRow>(ctx.db, "SELECT * FROM outreach_versions WHERE id = ?", d.version_id)!;
  const ws = one<WorkspaceRow>(ctx.db, "SELECT * FROM workspaces WHERE id = ?", w.workspace_id)!;
  if (!ws.active) throw conflict("That update belongs to a folder Kiki isn't working on now.");
  return { o, d, v, ws };
}

function readSaved(ctx: Ctx, key: string): SavedState | null {
  const raw = kvGet(ctx.db, key);
  return raw ? (JSON.parse(raw) as SavedState) : null;
}

export function foundAttachments(ctx: Ctx, outcomeId: string): (GmailAttachment & { saved: boolean })[] {
  const list = JSON.parse(kvGet(ctx.db, foundKey(outcomeId)) ?? "[]") as GmailAttachment[];
  if (!list.length) return [];
  const wsId = one<{ workspace_id: string }>(ctx.db, "SELECT w.workspace_id FROM outcomes o JOIN watches w ON w.id = o.watch_id WHERE o.id = ?", outcomeId)?.workspace_id ?? "";
  return list.map((a) => ({ ...a, saved: readSaved(ctx, savedKey(wsId, a))?.state === "saved" }));
}

/** Read-only: attachments the contractor emailed since Fo asked. Nothing is saved yet. */
export async function searchEmailedAttachments(ctx: Ctx, outcomeId: string): Promise<GmailAttachment[]> {
  if (!ctx.gmail?.available()) throw conflict("Let Kiki look in Gmail first (read-only).", "gmail_not_connected");
  const { d, v, ws } = refs(ctx, outcomeId);
  const from = v.recipient_email.trim();
  // Only ever search one exact sender: an empty or odd address must not widen the search.
  if (!isPlainEmail(from)) throw badRequest(`Kiki needs ${v.recipient_name}'s email address to look for their message in Gmail.`);
  const found = await ctx.gmail.searchAttachments({ from, afterIso: d.created_at });
  kvSet(ctx.db, foundKey(outcomeId), JSON.stringify(found));
  logEvent(
    ctx.db,
    ws.id,
    "gmail",
    found.length
      ? `Kiki looked in Gmail (read-only) and found ${found.length} attachment${found.length === 1 ? "" : "s"} from ${v.recipient_name} since Fo asked.`
      : `Kiki looked in Gmail (read-only): nothing from ${v.recipient_name} with an attachment since Fo asked.`,
  );
  return found;
}

/**
 * Saves one emailed attachment into the workspace folder, after the user approves it. The Drive
 * file ID is generated first and remembered, so a lost response or a double click can't make a
 * second copy. Then the update is checked again with the file in place.
 */
export async function saveEmailedAttachment(ctx: Ctx, outcomeId: string, index: number): Promise<{ fileId: string; created: boolean }> {
  if (!ctx.gmail?.available()) throw conflict("Let Kiki look in Gmail first (read-only).", "gmail_not_connected");
  const { v, ws } = refs(ctx, outcomeId);
  const list = JSON.parse(kvGet(ctx.db, foundKey(outcomeId)) ?? "[]") as GmailAttachment[];
  const a = Number.isInteger(index) ? list[index] : undefined;
  if (!a) throw badRequest("Choose one of the attachments Kiki found.");
  if (a.size !== null && a.size > MAX_SAVE_BYTES) {
    throw badRequest(`"${a.filename}" is larger than 5 MB, which Kiki can't save yet. Save it to the folder yourself and she'll pick it up.`);
  }
  const key = savedKey(ws.id, a);
  const notFoundAsNull = (err: unknown) => {
    if (err instanceof DriveError && err.kind === "not_found") return null;
    throw err;
  };

  let prior = readSaved(ctx, key);
  if (prior?.state === "saved") {
    const still = await ctx.drive.getFile(prior.fileId).catch(notFoundAsNull);
    if (still && !still.trashed) return { fileId: still.id, created: false };
    // The saved copy was deleted since: save a fresh one.
    prior = null;
  }

  let fileId = prior?.fileId ?? null;
  if (!fileId) {
    fileId = (await ctx.drive.generateIds(1))[0]!;
    kvSet(ctx.db, key, JSON.stringify({ state: "saving", fileId, name: a.filename } satisfies SavedState));
  }
  // An earlier attempt may already have created it under the same ID.
  let file = await ctx.drive.getFile(fileId).catch(notFoundAsNull);
  if (!file) {
    const data = await ctx.gmail.download(a.messageId, a.attachmentId);
    if (data.length > MAX_SAVE_BYTES) throw badRequest(`"${a.filename}" is larger than 5 MB, which Kiki can't save yet. Save it to the folder yourself and she'll pick it up.`);
    const name = sanitizeName(a.filename) || "attachment.pdf";
    try {
      file = await ctx.drive.createFile({ id: fileId, name, parentId: ws.root_file_id, mimeType: a.mimeType, content: data });
    } catch (err) {
      // The response was lost, or a retry raced the first attempt: Drive has the answer.
      if (err instanceof DriveError && (err.kind === "conflict" || err.delivery === "unknown")) file = await ctx.drive.getFile(fileId);
      else throw err;
    }
  }
  const saved = file;
  tx(ctx.db, () => {
    recordFile(ctx.db, ws.id, saved, "", "supplied_by_user");
    kvSet(ctx.db, key, JSON.stringify({ state: "saved", fileId: saved.id, name: saved.name } satisfies SavedState));
    logEvent(ctx.db, ws.id, "gmail_saved", `You approved saving "${saved.name}" from ${v.recipient_name}'s email into the folder.`);
    run(ctx.db, "UPDATE outcomes SET status = 'interpreting', error = NULL, updated_at = ? WHERE id = ? AND status = 'needs_clarification'", now(), outcomeId);
  });
  ctx.jobs.enqueue("outcome", `outcome:${outcomeId}`, { outcomeId });
  return { fileId: saved.id, created: true };
}
