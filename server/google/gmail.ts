import { demoFileContent, REVISED_QUOTE } from "../demo/renovation.ts";
import type { GoogleAuth } from "./oauth.ts";
import { DriveError } from "./types.ts";

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export interface GmailAttachment {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number | null;
  from: string;
  subject: string;
  date: string | null;
}

/** Read-only Gmail access: find attachments from one sender, and download one. Never sends or changes mail. */
export interface GmailAdapter {
  readonly mode: "live" | "mock";
  available(): boolean;
  searchAttachments(opts: { from: string; afterIso: string }): Promise<GmailAttachment[]>;
  download(messageId: string, attachmentId: string): Promise<Buffer>;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** One plain address, nothing Gmail's search could read as extra terms (spaces, OR, braces, quotes). */
export function isPlainEmail(s: string): boolean {
  return s.length <= 254 && /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(s);
}
const USEFUL = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;

interface Part {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

function flatten(part: Part | undefined, out: Part[] = []): Part[] {
  if (!part) return out;
  out.push(part);
  for (const p of part.parts ?? []) flatten(p, out);
  return out;
}

export class LiveGmail implements GmailAdapter {
  readonly mode = "live" as const;
  private readonly auth: GoogleAuth;

  constructor(auth: GoogleAuth) {
    this.auth = auth;
  }

  available(): boolean {
    return this.auth.grantedScopes().includes(GMAIL_READONLY);
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.accessToken(attempt > 0);
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new DriveError(`Couldn't reach Gmail (${err instanceof Error ? err.message : String(err)}).`, "network", { delivery: "not_sent" });
      }
      if (res.status === 401 && attempt === 0) continue;
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
      if (!res.ok) {
        const kind = res.status === 403 ? "permission" : res.status === 404 ? "not_found" : res.status === 429 ? "rate_limit" : res.status >= 500 ? "server" : "invalid";
        throw new DriveError(`Gmail: ${body.error?.message ?? `HTTP ${res.status}`}`, kind, { status: res.status });
      }
      return body;
    }
    throw new DriveError("Gmail sign-in expired. Connect again.", "auth", { status: 401 });
  }

  async searchAttachments(opts: { from: string; afterIso: string }): Promise<GmailAttachment[]> {
    if (!isPlainEmail(opts.from)) throw new DriveError("Kiki only searches Gmail for one exact sender address.", "invalid", { delivery: "not_sent" });
    // Gmail's after: takes a Unix time in seconds; go back a minute for clock differences.
    const after = Math.floor(Date.parse(opts.afterIso) / 1000) - 60;
    const q = `from:${opts.from} has:attachment after:${after}`;
    const list = await this.get(`${API}/messages?maxResults=10&q=${encodeURIComponent(q)}`);
    const out: GmailAttachment[] = [];
    for (const m of (list.messages as { id: string }[] | undefined) ?? []) {
      const msg = await this.get(`${API}/messages/${encodeURIComponent(m.id)}?format=full`);
      const payload = msg.payload as Part | undefined;
      const header = (name: string) => payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
      const date = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
      for (const p of flatten(payload)) {
        if (!p.filename || !p.body?.attachmentId || !USEFUL.test(p.mimeType ?? "")) continue;
        out.push({ messageId: m.id, attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType!, size: p.body.size ?? null, from: header("from"), subject: header("subject"), date });
      }
    }
    return out;
  }

  async download(messageId: string, attachmentId: string): Promise<Buffer> {
    const body = await this.get(`${API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return Buffer.from(String(body.data ?? ""), "base64url");
  }
}

/**
 * Mock Gmail: whoever you ask about appears to have emailed the revised quote just now.
 * Only used in mock mode and tests, and labelled as mock in the app.
 */
export class FakeGmail implements GmailAdapter {
  readonly mode = "mock" as const;
  enabled = true;
  searches: { from: string; afterIso: string }[] = [];
  attachments: (GmailAttachment & { data: Buffer })[] = [];

  available(): boolean {
    return this.enabled;
  }

  async searchAttachments(opts: { from: string; afterIso: string }): Promise<GmailAttachment[]> {
    if (!isPlainEmail(opts.from)) throw new DriveError("Kiki only searches Gmail for one exact sender address.", "invalid", { delivery: "not_sent" });
    this.searches.push(opts);
    if (!this.attachments.some((a) => a.from === opts.from)) {
      this.attachments.push({
        messageId: `mock-msg-${this.attachments.length + 1}`,
        attachmentId: `mock-att-${this.attachments.length + 1}`,
        filename: REVISED_QUOTE.fileName,
        mimeType: REVISED_QUOTE.mimeType,
        size: null,
        from: opts.from,
        subject: "Revised flooring quote",
        date: new Date().toISOString(),
        data: demoFileContent(REVISED_QUOTE),
      });
    }
    return this.attachments.filter((a) => a.from === opts.from).map(({ data: _data, ...a }) => a);
  }

  async download(messageId: string, attachmentId: string): Promise<Buffer> {
    const a = this.attachments.find((x) => x.messageId === messageId && x.attachmentId === attachmentId);
    if (!a) throw new DriveError("Attachment not found.", "not_found", { status: 404 });
    return a.data;
  }
}
