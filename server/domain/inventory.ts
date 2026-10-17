import { z } from "zod";
import type { ItemStatus } from "../db.ts";

export interface SearchItem {
  ref: string; // "C1", "C2", ... stable within one search
  itemId: string;
  label: string;
}

export interface Candidate {
  name: string;
  /** Only Google Drive / Docs https links are kept; anything else is dropped, never repaired. */
  link: string | null;
  linkNote: string | null;
}

export interface ItemResult {
  itemId: string;
  status: ItemStatus;
  reason: string;
  candidates: Candidate[];
}

export interface InventoryParse {
  parseStatus: "parsed" | "partial" | "malformed";
  notes: string[];
  results: ItemResult[];
}

/** Passwords and logins are never searched for. Everything else goes to Fo as a label only. */
export function searchableItems(items: { id: string; label: string; category: string }[]): SearchItem[] {
  return items
    .filter((i) => i.category !== "credential")
    .map((i, n) => ({ ref: `C${n + 1}`, itemId: i.id, label: i.label }));
}

export function buildInventoryMessage(items: SearchItem[], reference: string): string {
  const list = items.map((i) => `${i.ref}. ${i.label}`).join("\n");
  return `Paper Chase read-only document check (ref ${reference}).

Please look through my connected Google Drive for the documents below. This is read-only: do not modify, move, rename, delete, copy, share, upload or send anything, and don't contact anyone. If you can't search my Drive, say so instead of guessing.

Documents:
${list}

Reply with a JSON code block in exactly this shape, then anything else you want to tell me:
\`\`\`json
{"items":[{"id":"C1","status":"found","files":[{"name":"file name as it appears in Drive","link":"https://drive.google.com/... or null"}],"note":"short note"}]}
\`\`\`
status is "found", "missing" or "unsure". Only list files you actually saw. Use null for any link you don't have; don't construct links or file IDs.`;
}

const FoInventorySchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      files: z
        .array(z.object({ name: z.string().nullish(), link: z.string().nullish() }).loose())
        .nullish(),
      note: z.string().nullish(),
    }).loose(),
  ),
}).loose();

function extractJsonObject(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1]!] : [];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export function sanitizeLink(link: string | null | undefined): { link: string | null; note: string | null } {
  if (!link) return { link: null, note: null };
  try {
    const url = new URL(link);
    if (url.protocol === "https:" && (url.hostname === "drive.google.com" || url.hostname === "docs.google.com")) {
      return { link: url.toString(), note: null };
    }
    return { link: null, note: `Fo gave a link to ${url.hostname}, which isn't Google Drive, so it isn't shown.` };
  } catch {
    return { link: null, note: "Fo gave something that isn't a valid link, so it isn't shown." };
  }
}

/**
 * Parses Fo's reply conservatively. A file Fo names is a candidate for the user to check, never a
 * verified document. Anything ambiguous, missing or malformed becomes "needs_review" rather than
 * "found" or "missing".
 */
export function parseInventoryReply(reply: string, items: SearchItem[]): InventoryParse {
  const notes: string[] = [];
  const json = extractJsonObject(reply);
  const parsed = json === undefined ? undefined : FoInventorySchema.safeParse(json);
  if (!parsed?.success) {
    return {
      parseStatus: "malformed",
      notes: ["Fo's reply wasn't in the expected format, so nothing was marked found or missing. Read Fo's reply in the evidence."],
      results: items.map((i) => ({ itemId: i.itemId, status: "needs_review", reason: "Fo's reply couldn't be read reliably.", candidates: [] })),
    };
  }

  const byRef = new Map<string, (typeof parsed.data.items)[number][]>();
  for (const entry of parsed.data.items) {
    const ref = entry.id.trim().toUpperCase();
    if (!items.some((i) => i.ref === ref)) {
      notes.push(`Ignored an entry for an item Paper Chase didn't ask about (${entry.id}).`);
      continue;
    }
    byRef.set(ref, [...(byRef.get(ref) ?? []), entry]);
  }

  let complete = true;
  const results = items.map((item): ItemResult => {
    const entries = byRef.get(item.ref) ?? [];
    if (entries.length !== 1) {
      complete = false;
      return {
        itemId: item.itemId,
        status: "needs_review",
        reason: entries.length === 0 ? "Fo's reply didn't mention this item." : "Fo's reply listed this item more than once.",
        candidates: [],
      };
    }
    const entry = entries[0]!;
    const note = entry.note?.trim() || null;
    const status = entry.status.trim().toLowerCase();
    const candidates: Candidate[] = (entry.files ?? [])
      .filter((f) => f.name && f.name.trim())
      .map((f) => {
        const { link, note: linkNote } = sanitizeLink(f.link);
        return { name: f.name!.trim(), link, linkNote };
      });

    if (status === "found") {
      if (candidates.length === 0) {
        complete = false;
        return { itemId: item.itemId, status: "needs_review", reason: "Fo said it found this but didn't name a file.", candidates };
      }
      return { itemId: item.itemId, status: "candidate", reason: note ?? "Fo named a possible match. Check it's the right document.", candidates };
    }
    if (status === "missing") {
      if (candidates.length > 0) {
        complete = false;
        return { itemId: item.itemId, status: "needs_review", reason: "Fo said this is missing but also named files.", candidates };
      }
      return { itemId: item.itemId, status: "missing", reason: note ?? "Fo didn't find this in your Drive.", candidates };
    }
    if (status !== "unsure") complete = false;
    return { itemId: item.itemId, status: "needs_review", reason: note ?? "Fo wasn't sure about this one.", candidates };
  });

  return { parseStatus: complete && notes.length === 0 ? "parsed" : "partial", notes, results };
}
