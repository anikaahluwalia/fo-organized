import type { GoogleAuth } from "./oauth.ts";
import {
  DriveError,
  FOLDER_MIME,
  GOOGLE_DOC_MIME,
  GOOGLE_SHEET_MIME,
  type DriveAdapter,
  type DriveConnection,
  type DriveContent,
  type DriveFile,
} from "./types.ts";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS =
  "id,name,mimeType,parents,version,md5Checksum,modifiedTime,createdTime,size,trashed,driveId,webViewLink,shortcutDetails(targetId),capabilities(canRename,canMoveItemWithinDrive,canAddChildren)";

/** Network failures raised before a request is written: Google cannot have received it. */
const PRE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"]);

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function toFile(raw: Record<string, unknown>): DriveFile {
  const caps = (raw.capabilities ?? {}) as Record<string, unknown>;
  const shortcut = (raw.shortcutDetails ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    mimeType: String(raw.mimeType ?? ""),
    parents: Array.isArray(raw.parents) ? raw.parents.map(String) : [],
    version: raw.version === undefined ? null : String(raw.version),
    contentKey: (raw.md5Checksum as string | undefined) ?? (raw.modifiedTime as string | undefined) ?? null,
    modifiedTime: (raw.modifiedTime as string | undefined) ?? null,
    createdTime: (raw.createdTime as string | undefined) ?? null,
    size: raw.size === undefined ? null : Number(raw.size),
    trashed: raw.trashed === true,
    driveId: (raw.driveId as string | undefined) ?? null,
    webViewLink: (raw.webViewLink as string | undefined) ?? null,
    shortcutTargetId: (shortcut.targetId as string | undefined) ?? null,
    capabilities: {
      canRename: caps.canRename !== false,
      canMove: caps.canMoveItemWithinDrive !== false,
      canAddChildren: caps.canAddChildren !== false,
    },
  };
}

function quoteQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Google Drive API v3 over fetch. Only the handful of calls Kiki needs. */
export class LiveDrive implements DriveAdapter {
  readonly mode = "live" as const;
  private readonly auth: GoogleAuth;

  constructor(auth: GoogleAuth) {
    this.auth = auth;
  }

  private async request(method: string, url: string, init: { body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.accessToken(attempt > 0);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
          body: init.body,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (errorCodes(err).some((c) => PRE_SEND_CODES.has(c))) throw new DriveError(`Couldn't reach Google Drive (${message}).`, "network", { delivery: "not_sent" });
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new DriveError("Google Drive didn't answer in time.", "timeout", { delivery: "unknown" });
        }
        throw new DriveError(`Lost contact with Google Drive (${message}).`, "network", { delivery: "unknown" });
      }
      if (res.status === 401 && attempt === 0) continue; // token rejected: refresh once and retry
      if (!res.ok) throw await this.toError(res);
      return res;
    }
    throw new DriveError("Google Drive rejected the sign-in. Connect again.", "auth", { status: 401 });
  }

  private async toError(res: Response): Promise<DriveError> {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = body.error?.errors?.[0]?.reason ?? null;
    const message = body.error?.message ?? `HTTP ${res.status}`;
    const opts = { status: res.status, reason };
    if (res.status === 401) return new DriveError("Google Drive sign-in expired. Connect again.", "auth", opts);
    if (res.status === 404) return new DriveError(`Not found in Drive: ${message}`, "not_found", opts);
    if (res.status === 409) return new DriveError(`Drive reported a conflict: ${message}`, "conflict", opts);
    if (res.status === 429 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return new DriveError("Google Drive is rate-limiting requests.", "rate_limit", opts);
    if (res.status === 403) {
      const scopeHint = reason === "insufficientPermissions" || reason === "insufficientScopes" ? " The granted Google scopes may not allow this (see GOOGLE_DRIVE_SCOPES in the README)." : "";
      return new DriveError(`Drive refused: ${message}.${scopeHint}`, "permission", opts);
    }
    if (res.status >= 500) return new DriveError(`Google Drive had a server problem (${res.status}).`, "server", { ...opts, delivery: "unknown" });
    return new DriveError(`Drive rejected the request: ${message}`, "invalid", opts);
  }

  private async json(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.request(method, url, body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return (await res.json()) as Record<string, unknown>;
  }

  async connection(): Promise<DriveConnection> {
    if (!this.auth.configured()) return { state: "not_configured", message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart." };
    if (!this.auth.hasTokens()) return { state: "needs_auth" };
    try {
      const about = await this.json("GET", `${API}/about?fields=user(emailAddress)`);
      const user = (about.user ?? {}) as { emailAddress?: string };
      return { state: "connected", account: user.emailAddress ?? null };
    } catch (err) {
      if (err instanceof DriveError && err.kind === "auth") return { state: "needs_auth" };
      return { state: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async getFile(id: string): Promise<DriveFile> {
    return toFile(await this.json("GET", `${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`));
  }

  private async list(q: string, driveId: string | null): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "200",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(driveId ? { corpora: "drive", driveId } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.json("GET", `${API}/files?${params}`);
      for (const f of (page.files as Record<string, unknown>[]) ?? []) files.push(toFile(f));
      pageToken = page.nextPageToken as string | undefined;
    } while (pageToken);
    return files;
  }

  listChildren(folderId: string, driveId: string | null): Promise<DriveFile[]> {
    return this.list(`'${quoteQuery(folderId)}' in parents and trashed = false`, driveId);
  }

  findChildFolders(parentId: string, name: string, driveId: string | null): Promise<DriveFile[]> {
    return this.list(`'${quoteQuery(parentId)}' in parents and name = '${quoteQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`, driveId);
  }

  async generateIds(count: number): Promise<string[]> {
    const body = await this.json("GET", `${API}/files/generateIds?count=${count}&space=drive&type=files`);
    return (body.ids as string[]) ?? [];
  }

  async createFolder(input: { id?: string; name: string; parentId: string }): Promise<DriveFile> {
    return toFile(
      await this.json("POST", `${API}/files?supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`, {
        ...(input.id ? { id: input.id } : {}),
        name: input.name,
        mimeType: FOLDER_MIME,
        parents: [input.parentId],
      }),
    );
  }

  async update(id: string, change: { name?: string; addParent?: string; removeParent?: string }): Promise<DriveFile> {
    const params = new URLSearchParams({ supportsAllDrives: "true", fields: FILE_FIELDS });
    if (change.addParent) params.set("addParents", change.addParent);
    if (change.removeParent) params.set("removeParents", change.removeParent);
    return toFile(await this.json("PATCH", `${API}/files/${encodeURIComponent(id)}?${params}`, change.name === undefined ? {} : { name: change.name }));
  }

  async readContent(file: DriveFile, maxBytes: number): Promise<DriveContent> {
    const id = encodeURIComponent(file.id);
    if (file.mimeType === GOOGLE_DOC_MIME || file.mimeType === GOOGLE_SHEET_MIME) {
      const type = file.mimeType === GOOGLE_DOC_MIME ? "text/plain" : "text/csv";
      const res = await this.request("GET", `${API}/files/${id}/export?mimeType=${encodeURIComponent(type)}`);
      return { kind: "text", text: (await res.text()).slice(0, maxBytes) };
    }
    const readable = file.mimeType === "application/pdf" || file.mimeType.startsWith("text/") || /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType);
    if (!readable) return { kind: "unsupported", reason: `Kiki can't read ${file.mimeType} files yet.` };
    if (file.size !== null && file.size > maxBytes) return { kind: "unsupported", reason: "The file is too large for Kiki to read." };
    const res = await this.request("GET", `${API}/files/${id}?alt=media&supportsAllDrives=true`);
    const data = Buffer.from(await res.arrayBuffer());
    if (file.mimeType === "application/pdf") return { kind: "pdf", data };
    if (file.mimeType.startsWith("text/")) return { kind: "text", text: data.toString("utf8") };
    return { kind: "image", data, mimeType: file.mimeType };
  }

  async createFile(input: { id?: string; name: string; parentId: string; mimeType: string; content: Buffer | string }): Promise<DriveFile> {
    const boundary = `kiki-${Math.random().toString(16).slice(2)}`;
    const metadata = JSON.stringify({ ...(input.id ? { id: input.id } : {}), name: input.name, parents: [input.parentId], mimeType: input.mimeType });
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await this.request("POST", `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      body,
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
    });
    return toFile((await res.json()) as Record<string, unknown>);
  }

  async updateContent(id: string, mimeType: string, content: Buffer | string): Promise<DriveFile> {
    const res = await this.request("PATCH", `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      body: typeof content === "string" ? Buffer.from(content, "utf8") : content,
      headers: { "content-type": mimeType },
    });
    return toFile((await res.json()) as Record<string, unknown>);
  }
}
