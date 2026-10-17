export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  version: string | null;
  /** Changes only when the content changes (md5 for binary files, modified time otherwise). */
  contentKey: string | null;
  modifiedTime: string | null;
  createdTime: string | null;
  size: number | null;
  trashed: boolean;
  driveId: string | null;
  webViewLink: string | null;
  shortcutTargetId: string | null;
  capabilities: { canRename: boolean; canMove: boolean; canAddChildren: boolean };
}

export type DriveContent =
  | { kind: "pdf"; data: Buffer }
  | { kind: "text"; text: string }
  | { kind: "image"; data: Buffer; mimeType: string }
  | { kind: "unsupported"; reason: string };

export type DriveConnection =
  | { state: "connected"; account: string | null }
  | { state: "needs_auth" }
  | { state: "not_configured"; message: string }
  | { state: "error"; message: string };

export type DriveErrorKind = "not_found" | "permission" | "auth" | "rate_limit" | "conflict" | "invalid" | "server" | "network" | "timeout" | "unknown";

/**
 * delivery says whether a mutating request could have taken effect:
 * - "not_sent": provably never reached Google (not signed in, host unreachable).
 * - "unknown": it may have been applied; read the file back before deciding anything.
 */
export class DriveError extends Error {
  readonly kind: DriveErrorKind;
  readonly status: number | null;
  readonly reason: string | null;
  readonly delivery: "not_sent" | "unknown";
  constructor(message: string, kind: DriveErrorKind, opts: { status?: number | null; reason?: string | null; delivery?: "not_sent" | "unknown" } = {}) {
    super(message);
    this.name = "DriveError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.reason = opts.reason ?? null;
    // A definite HTTP error response means the change was rejected, not applied.
    this.delivery = opts.delivery ?? (opts.status ? "not_sent" : "unknown");
  }
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "server" || this.kind === "network" || this.kind === "timeout";
  }
}

export interface DriveAdapter {
  readonly mode: "live" | "mock";
  connection(): Promise<DriveConnection>;
  getFile(id: string): Promise<DriveFile>;
  listChildren(folderId: string, driveId: string | null): Promise<DriveFile[]>;
  findChildFolders(parentId: string, name: string, driveId: string | null): Promise<DriveFile[]>;
  generateIds(count: number): Promise<string[]>;
  createFolder(input: { id?: string; name: string; parentId: string }): Promise<DriveFile>;
  update(id: string, change: { name?: string; addParent?: string; removeParent?: string }): Promise<DriveFile>;
  readContent(file: DriveFile, maxBytes: number): Promise<DriveContent>;
  createFile(input: { id?: string; name: string; parentId: string; mimeType: string; content: Buffer | string }): Promise<DriveFile>;
  updateContent(id: string, mimeType: string, content: Buffer | string): Promise<DriveFile>;
}
