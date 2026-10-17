import { createHash, randomBytes } from "node:crypto";
import {
  DriveError,
  FOLDER_MIME,
  GOOGLE_DOC_MIME,
  SHORTCUT_MIME,
  type DriveAdapter,
  type DriveConnection,
  type DriveContent,
  type DriveFile,
} from "./types.ts";

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parent: string | null;
  version: number;
  modifiedTime: string;
  createdTime: string;
  content: Buffer | null;
  shortcutTargetId: string | null;
  canRename: boolean;
  canMove: boolean;
  trashed: boolean;
}

export type FakeOp = "getFile" | "listChildren" | "findChildFolders" | "generateIds" | "createFolder" | "update" | "readContent" | "createFile" | "updateContent";

/**
 * error: the call fails and changes nothing.
 * lost_after_apply: the change happens, but the caller sees a timeout (the hard case).
 */
export interface FailureRule {
  op: FakeOp;
  fileId?: string;
  mode: "error" | "lost_after_apply";
  error?: DriveError;
  times?: number;
}

/**
 * In-memory Drive with the same interface as LiveDrive. Used by tests and by the clearly
 * labelled mock mode. Supports failure injection and concurrent edits "by someone else".
 */
export class FakeDrive implements DriveAdapter {
  readonly mode: "live" | "mock";
  readonly files = new Map<string, FakeFile>();
  readonly calls: { op: FakeOp; id?: string }[] = [];
  private failures: FailureRule[] = [];
  private tick = 0;
  connectionState: DriveConnection = { state: "connected", account: "demo@example.com" };

  constructor(mode: "live" | "mock" = "mock") {
    this.mode = mode;
    this.files.set("root", this.make("root", "My Drive", FOLDER_MIME, null));
  }

  private stamp(): string {
    return new Date(Date.UTC(2026, 9, 17, 12, 0, this.tick++)).toISOString();
  }

  private make(id: string, name: string, mimeType: string, parent: string | null, content: Buffer | null = null): FakeFile {
    const at = this.stamp();
    return { id, name, mimeType, parent, version: 1, modifiedTime: at, createdTime: at, content, shortcutTargetId: null, canRename: true, canMove: true, trashed: false };
  }

  newId(): string {
    return `f${randomBytes(6).toString("hex")}`;
  }

  // Test and seeding helpers --------------------------------------------------------------

  addFolder(name: string, parent = "root", id = this.newId()): string {
    this.files.set(id, this.make(id, name, FOLDER_MIME, parent));
    return id;
  }

  addFile(name: string, parent: string, mimeType: string, content: Buffer | string | null = null, id = this.newId()): string {
    const data = content === null ? null : typeof content === "string" ? Buffer.from(content, "utf8") : content;
    this.files.set(id, this.make(id, name, mimeType, parent, data));
    return id;
  }

  addShortcut(name: string, parent: string, targetId: string): string {
    const id = this.newId();
    const f = this.make(id, name, SHORTCUT_MIME, parent);
    f.shortcutTargetId = targetId;
    this.files.set(id, f);
    return id;
  }

  /** Simulates someone else changing a file between preview and execution. */
  touch(id: string, change: { name?: string; parent?: string }): void {
    const f = this.mustGet(id);
    if (change.name !== undefined) f.name = change.name;
    if (change.parent !== undefined) f.parent = change.parent;
    f.version += 1;
    f.modifiedTime = this.stamp();
  }

  fail(rule: FailureRule): void {
    this.failures.push({ times: 1, ...rule });
  }

  childrenOf(parent: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.parent === parent && !f.trashed);
  }

  pathOf(id: string): string {
    const names: string[] = [];
    let cur = this.files.get(id);
    while (cur && cur.id !== "root") {
      names.unshift(cur.name);
      cur = cur.parent ? this.files.get(cur.parent) : undefined;
    }
    return names.join("/");
  }

  // DriveAdapter ---------------------------------------------------------------------------

  private takeFailure(op: FakeOp, id?: string): FailureRule | undefined {
    const i = this.failures.findIndex((r) => r.op === op && (!r.fileId || r.fileId === id));
    if (i === -1) return undefined;
    const rule = this.failures[i]!;
    rule.times = (rule.times ?? 1) - 1;
    if (rule.times <= 0) this.failures.splice(i, 1);
    return rule;
  }

  private async guard<T>(op: FakeOp, id: string | undefined, fn: () => T): Promise<T> {
    this.calls.push({ op, id });
    await Promise.resolve();
    const rule = this.takeFailure(op, id);
    if (rule?.mode === "error") throw rule.error ?? new DriveError("Injected failure.", "server", { status: 500, delivery: "not_sent" });
    const result = fn();
    if (rule?.mode === "lost_after_apply") throw new DriveError("Google Drive didn't answer in time.", "timeout", { delivery: "unknown" });
    return result;
  }

  private mustGet(id: string): FakeFile {
    const f = this.files.get(id);
    if (!f || f.trashed) throw new DriveError(`Not found in Drive: ${id}`, "not_found", { status: 404 });
    return f;
  }

  private view(f: FakeFile): DriveFile {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parent ? [f.parent] : [],
      version: String(f.version),
      contentKey: f.content ? createHash("md5").update(f.content).digest("hex") : f.modifiedTime,
      modifiedTime: f.modifiedTime,
      createdTime: f.createdTime,
      size: f.content ? f.content.length : null,
      trashed: f.trashed,
      driveId: null,
      webViewLink: f.id === "root" ? null : `https://drive.google.com/mock/${f.id}`,
      shortcutTargetId: f.shortcutTargetId,
      capabilities: { canRename: f.canRename, canMove: f.canMove, canAddChildren: f.mimeType === FOLDER_MIME },
    };
  }

  async connection(): Promise<DriveConnection> {
    return this.connectionState;
  }

  getFile(id: string): Promise<DriveFile> {
    return this.guard("getFile", id, () => this.view(this.mustGet(id)));
  }

  listChildren(folderId: string): Promise<DriveFile[]> {
    return this.guard("listChildren", folderId, () => this.childrenOf(folderId).map((f) => this.view(f)));
  }

  findChildFolders(parentId: string, name: string): Promise<DriveFile[]> {
    return this.guard("findChildFolders", parentId, () =>
      this.childrenOf(parentId)
        .filter((f) => f.mimeType === FOLDER_MIME && f.name === name)
        .map((f) => this.view(f)),
    );
  }

  generateIds(count: number): Promise<string[]> {
    return this.guard("generateIds", undefined, () => Array.from({ length: count }, () => this.newId()));
  }

  createFolder(input: { id?: string; name: string; parentId: string }): Promise<DriveFile> {
    return this.guard("createFolder", input.id, () => {
      this.mustGet(input.parentId);
      const id = input.id ?? this.newId();
      if (this.files.has(id)) throw new DriveError("A file with this ID already exists.", "conflict", { status: 409 });
      const f = this.make(id, input.name, FOLDER_MIME, input.parentId);
      this.files.set(id, f);
      return this.view(f);
    });
  }

  update(id: string, change: { name?: string; addParent?: string; removeParent?: string }): Promise<DriveFile> {
    return this.guard("update", id, () => {
      const f = this.mustGet(id);
      if (change.name !== undefined && !f.canRename) throw new DriveError("Drive refused: you can't rename this file.", "permission", { status: 403 });
      if (change.addParent) {
        if (!f.canMove) throw new DriveError("Drive refused: you can't move this file.", "permission", { status: 403 });
        this.mustGet(change.addParent);
        if (change.removeParent && f.parent !== change.removeParent) throw new DriveError("Drive rejected the request: removeParents doesn't match.", "invalid", { status: 400 });
        f.parent = change.addParent;
      }
      if (change.name !== undefined) f.name = change.name;
      f.version += 1;
      f.modifiedTime = this.stamp();
      return this.view(f);
    });
  }

  readContent(file: DriveFile): Promise<DriveContent> {
    return this.guard("readContent", file.id, (): DriveContent => {
      const f = this.mustGet(file.id);
      if (!f.content) return { kind: "unsupported", reason: "This file has no readable content." };
      if (f.mimeType === "application/pdf") return { kind: "pdf", data: f.content };
      if (f.mimeType.startsWith("text/") || f.mimeType === GOOGLE_DOC_MIME) return { kind: "text", text: f.content.toString("utf8") };
      if (f.mimeType.startsWith("image/")) return { kind: "image", data: f.content, mimeType: f.mimeType };
      return { kind: "unsupported", reason: `Kiki can't read ${f.mimeType} files yet.` };
    });
  }

  createFile(input: { id?: string; name: string; parentId: string; mimeType: string; content: Buffer | string }): Promise<DriveFile> {
    return this.guard("createFile", input.id, () => {
      this.mustGet(input.parentId);
      const id = input.id ?? this.newId();
      if (this.files.has(id)) throw new DriveError("A file with this ID already exists.", "conflict", { status: 409 });
      const data = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
      const f = this.make(id, input.name, input.mimeType, input.parentId, data);
      this.files.set(id, f);
      return this.view(f);
    });
  }

  updateContent(id: string, _mimeType: string, content: Buffer | string): Promise<DriveFile> {
    return this.guard("updateContent", id, () => {
      const f = this.mustGet(id);
      f.content = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      f.version += 1;
      f.modifiedTime = this.stamp();
      return this.view(f);
    });
  }
}
