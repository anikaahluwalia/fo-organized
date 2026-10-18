import { createHash } from "node:crypto";
import type { OpKind } from "../db.ts";
import type { DocFacts } from "./documents.ts";
import { deduplicateName, indexFileName, projectFolderPath, proposedName, SUPERSEDED_FOLDER, targetFolder } from "./naming.ts";
import { issuerKey } from "./safety.ts";
import { copyMap, DUPLICATES_FOLDER } from "./duplicates.ts";

export interface PlanFile {
  fileId: string;
  name: string;
  mimeType: string;
  parentId: string | null;
  path: string; // folder path the file lives in, relative to the workspace root ("" = root)
  version: string | null;
  createdTime: string | null;
  isFolder: boolean;
  isShortcut: boolean;
  canRename: boolean;
  canMove: boolean;
}

export interface PlanDoc {
  docId: string;
  fileId: string;
  facts: DocFacts | null;
  readStatus: string;
  readError: string | null;
  versionStatus: string | null;
}

export type Ref = { file: string } | { op: number };

export interface PlannedOp {
  seq: number;
  kind: OpKind;
  fileId: string | null;
  docId: string | null;
  folderPath: string | null;
  parentRef: Ref | null;
  newName: string | null;
  pre: { name: string; parentId: string | null; version: string | null; path: string } | null;
  newPath: string | null;
  preStatus: string | null;
  targetStatus: string | null;
  targetSupersedesId: string | null;
  reason: string;
  evidence: unknown;
  dependsOn: number[];
}

export interface PlanNote {
  fileId: string;
  name: string;
  path: string;
  status: "already_organized" | "needs_review" | "left_in_place" | "waiting";
  reason: string;
}

export interface PlanDraft {
  ops: PlannedOp[];
  notes: PlanNote[];
}

export const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

export function refKey(ref: Ref | null): string | null {
  if (!ref) return null;
  return "file" in ref ? `file:${ref.file}` : `op:${ref.op}`;
}

export function parseRef(key: string | null): Ref | null {
  if (!key) return null;
  const [kind, value] = key.split(/:(.*)/s);
  return kind === "op" ? { op: Number(value) } : { file: value ?? "" };
}

/** The approval binds to this: every operation's target, preconditions and outcome. */
export function planHash(ops: PlannedOp[]): string {
  const canonical = ops.map((o) => [
    o.seq,
    o.kind,
    o.fileId,
    o.docId,
    o.folderPath,
    refKey(o.parentRef),
    o.newName,
    o.pre?.name ?? null,
    o.pre?.parentId ?? null,
    o.pre?.version ?? null,
    o.preStatus,
    o.targetStatus,
    o.targetSupersedesId,
    o.dependsOn,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Existing folders by path, plus folders this plan will create. */
class Folders {
  private readonly byPath = new Map<string, string>();
  private readonly planned = new Map<string, number>();
  private readonly ops: PlannedOp[];
  readonly files: PlanFile[];

  constructor(rootId: string, files: PlanFile[], ops: PlannedOp[]) {
    this.ops = ops;
    this.files = files;
    this.byPath.set("", rootId);
    // If Drive holds two folders with the same name in one place, use the oldest one consistently.
    const folders = files.filter((f) => f.isFolder && !f.isShortcut).sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.fileId.localeCompare(b.fileId));
    for (const f of folders) {
      const p = join(f.path, f.name);
      if (!this.byPath.has(p)) this.byPath.set(p, f.fileId);
    }
  }

  existing(path: string): string | undefined {
    return this.byPath.get(path);
  }

  /** A reference to the folder at path, planning create_folder ops for any missing ancestors. */
  ensure(path: string): Ref {
    const found = this.byPath.get(path);
    if (found) return { file: found };
    const seq = this.planned.get(path);
    if (seq !== undefined) return { op: seq };
    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parentRef = this.ensure(parentPath);
    const op: PlannedOp = {
      seq: this.ops.length + 1,
      kind: "create_folder",
      fileId: null,
      docId: null,
      folderPath: path,
      parentRef,
      newName: name,
      pre: null,
      newPath: parentPath,
      preStatus: null,
      targetStatus: null,
      targetSupersedesId: null,
      reason: `Create the "${name}" folder${parentPath ? ` inside ${parentPath}` : ""}.`,
      evidence: null,
      dependsOn: "op" in parentRef ? [parentRef.op] : [],
    };
    this.ops.push(op);
    this.planned.set(path, op.seq);
    return { op: op.seq };
  }

  /** The create_folder ops this path depends on. */
  dependencies(ref: Ref): number[] {
    return "op" in ref ? [ref.op] : [];
  }
}

function describeFacts(f: DocFacts): string {
  const bits = [f.issuer.value, f.reference.value, f.date.value].filter(Boolean);
  const type = f.docType === "unknown" ? "document" : f.revision.isRevision && f.docType === "quote" ? "revised quote" : f.docType;
  return bits.length ? `${type} (${bits.join(", ")})` : type;
}

function takenNames(files: PlanFile[], movingIds: Set<string>): Map<string, Set<string>> {
  const taken = new Map<string, Set<string>>();
  for (const f of files) {
    if (movingIds.has(f.fileId)) continue;
    const set = taken.get(f.path) ?? new Set<string>();
    set.add(f.name.toLowerCase());
    taken.set(f.path, set);
  }
  return taken;
}

function claimName(taken: Map<string, Set<string>>, path: string, name: string): string {
  const set = taken.get(path) ?? new Set<string>();
  const unique = deduplicateName(name, set);
  set.add(unique.toLowerCase());
  taken.set(path, set);
  return unique;
}

function indexOp(ops: PlannedOp[], folders: Folders, project: string, index: { fileId: string; version: string | null } | null, dependsOn: number[]): void {
  const folderPath = projectFolderPath(project, folders.files);
  const parentRef = folders.ensure(folderPath);
  ops.push({
    seq: ops.length + 1,
    kind: "write_index",
    fileId: index?.fileId ?? null,
    docId: null,
    folderPath,
    parentRef,
    newName: indexFileName(project),
    pre: index ? { name: indexFileName(project), parentId: null, version: index.version, path: folderPath } : null,
    newPath: folderPath,
    preStatus: null,
    targetStatus: null,
    targetSupersedesId: null,
    reason: index
      ? `Update the ${project} index.`
      : `Create a ${project} index listing every document.`,
    evidence: null,
    dependsOn: [...new Set([...folders.dependencies(parentRef), ...dependsOn])].sort((a, b) => a - b),
  });
}

/**
 * The first organizing pass: a folder per project and document type, readable names from
 * verified facts, and a reason for every change. Files Kiki can't place are left alone.
 */
export function buildOrganizePlan(input: {
  rootId: string;
  files: PlanFile[];
  docs: PlanDoc[];
  indexFiles: Record<string, { fileId: string; version: string | null } | null>;
}): PlanDraft {
  const ops: PlannedOp[] = [];
  const notes: PlanNote[] = [];
  const folders = new Folders(input.rootId, input.files, ops);
  const fileById = new Map(input.files.map((f) => [f.fileId, f]));
  const indexIds = new Set(Object.values(input.indexFiles).filter((x) => x).map((x) => x!.fileId));

  type Move = { file: PlanFile; doc: PlanDoc; targetPath: string; name: string; reason: string };
  const moves: Move[] = [];
  const projects = new Set<string>();

  // Suppliers Kiki already knows: an invoice that doesn't name its project goes where that
  // supplier's other documents are (only when they all point to one project).
  const supplierProjects = new Map<string, Set<string>>();
  for (const d of input.docs) {
    const key = issuerKey(d.facts?.issuer.value);
    const project = d.facts?.project.value;
    if (key && project) supplierProjects.set(key, (supplierProjects.get(key) ?? new Set()).add(project));
  }

  const docs = [...input.docs].sort((a, b) => a.fileId.localeCompare(b.fileId));
  // Exact copies (same content): Kiki files one and sets the others aside next to it.
  const copyOf = copyMap(
    docs.flatMap((d) => {
      const f = fileById.get(d.fileId);
      return f && d.readStatus === "read" && !f.isFolder && !f.isShortcut ? [{ docId: d.docId, fileId: f.fileId, name: f.name, path: f.path, contentKey: f.version, createdTime: f.createdTime }] : [];
    }),
  );
  const resolved = new Map<string, { targetPath: string; name: string }>();
  const setAside: PlanDoc[] = [];
  for (const doc of docs) {
    const file = fileById.get(doc.fileId);
    if (!file || file.isFolder || indexIds.has(file.fileId)) continue;
    const at = { fileId: file.fileId, name: file.name, path: file.path };
    if (file.isShortcut) {
      notes.push({ ...at, status: "left_in_place", reason: "It's a shortcut. Kiki doesn't move shortcuts because they can point outside this workspace." });
      continue;
    }
    if (doc.readStatus === "pending" || doc.readStatus === "reading") {
      notes.push({ ...at, status: "waiting", reason: "Kiki is still reading this file." });
      continue;
    }
    if (doc.readStatus !== "read" || !doc.facts) {
      notes.push({ ...at, status: "needs_review", reason: doc.readError ?? "Kiki couldn't read this file, so she won't guess where it goes." });
      continue;
    }
    if (copyOf.has(doc.docId)) {
      setAside.push(doc);
      continue;
    }
    let facts = doc.facts;
    let supplierNote: string | null = null;
    if (!facts.project.value && ["invoice", "quote", "receipt"].includes(facts.docType)) {
      const known = supplierProjects.get(issuerKey(facts.issuer.value) ?? "");
      if (known && known.size === 1) {
        const project = [...known][0]!;
        const count = input.docs.filter((d) => d.docId !== doc.docId && issuerKey(d.facts?.issuer.value) === issuerKey(facts.issuer.value)).length;
        facts = { ...facts, project: { value: project, quote: null, quoteFound: null } };
        supplierNote = `No project on it, but ${facts.issuer.value}'s other ${count === 1 ? "document is" : `${count} documents are`} in ${project}.`;
      }
    }
    const folder = targetFolder(facts, input.files);
    if (!folder) {
      notes.push({
        ...at,
        status: facts.docType === "unknown" ? "needs_review" : "left_in_place",
        reason: facts.docType === "unknown" ? "Kiki couldn't tell what kind of document this is." : `This ${describeFacts(facts)} doesn't identify a safe project or collection, so Kiki needs clarification before filing it.`,
      });
      continue;
    }
    projects.add(facts.project.value!);
    const targetPath = doc.versionStatus === "superseded" && facts.docType === "quote" ? `${folder}/${SUPERSEDED_FOLDER}` : folder;
    const suggested = proposedName(facts, file.name, file.mimeType);
    const name = suggested ?? file.name;
    if (file.path === targetPath && file.name === name) {
      resolved.set(doc.docId, { targetPath, name });
      notes.push({ ...at, status: "already_organized", reason: "Already in the right folder with a clear name." });
      continue;
    }
    if (file.path !== targetPath && !file.canMove) {
      notes.push({ ...at, status: "needs_review", reason: "Drive says you can't move this file, so Kiki left it." });
      continue;
    }
    if (name !== file.name && !file.canRename) {
      notes.push({ ...at, status: "needs_review", reason: "Drive says you can't rename this file, so Kiki left it." });
      continue;
    }
    const kind = describeFacts(facts);
    const article = /^[aeiou]/i.test(kind) ? "an" : "a";
    void article;
    const label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    const why = supplierNote ? [`${label}.`, supplierNote] : [`${label}, ${facts.project.value!.toLowerCase()}.`];
    if (!suggested) why.push("Keeps its name (not enough details to rename).");
    if (facts.aiDirectedText.length) why.push("Contains instructions aimed at AI tools; ignored.");
    resolved.set(doc.docId, { targetPath, name });
    moves.push({ file, doc, targetPath, name, reason: why.join(" ") });
  }

  // Shortcuts have no document of their own; say why they stay where they are.
  const withDoc = new Set(docs.map((d) => d.fileId));
  for (const f of input.files) {
    if (f.isShortcut && !withDoc.has(f.fileId)) {
      notes.push({ fileId: f.fileId, name: f.name, path: f.path, status: "left_in_place", reason: "It's a shortcut. Kiki doesn't move shortcuts because they can point outside this workspace." });
    }
  }

  for (const doc of setAside) {
    const file = fileById.get(doc.fileId)!;
    const keeperId = copyOf.get(doc.docId)!;
    const keeperFile = fileById.get(docs.find((d) => d.docId === keeperId)!.fileId)!;
    // Next to where the kept copy is (or is going), under the same clear name.
    const keeper = resolved.get(keeperId) ?? { targetPath: keeperFile.path, name: keeperFile.name };
    const targetPath = keeper.targetPath ? `${keeper.targetPath}/${DUPLICATES_FOLDER}` : DUPLICATES_FOLDER;
    const at = { fileId: file.fileId, name: file.name, path: file.path };
    if (file.path === targetPath && file.name === keeper.name) {
      notes.push({ ...at, status: "already_organized", reason: `An exact copy of "${keeper.name}", already set aside.` });
      continue;
    }
    if ((file.path !== targetPath && !file.canMove) || (file.name !== keeper.name && !file.canRename)) {
      notes.push({ ...at, status: "needs_review", reason: `An exact copy of "${keeper.name}", but Drive says Kiki can't move or rename it.` });
      continue;
    }
    moves.push({ file, doc, targetPath, name: keeper.name, reason: `An exact copy of "${keeper.name}" (same content). Kiki sets copies aside instead of deleting anything.` });
  }

  const taken = takenNames(input.files, new Set(moves.map((m) => m.file.fileId)));
  moves.sort((a, b) => a.targetPath.localeCompare(b.targetPath) || a.name.localeCompare(b.name) || a.file.fileId.localeCompare(b.file.fileId));
  // Folders first, in a stable order.
  for (const path of [...new Set(moves.map((m) => m.targetPath))].sort()) folders.ensure(path);
  for (const p of [...projects].sort()) folders.ensure(projectFolderPath(p, input.files));

  const moveSeqs: number[] = [];
  for (const m of moves) {
    const name = claimName(taken, m.targetPath, m.name);
    // Numbered because another file has the same name, and already exactly there: nothing to do.
    if (name === m.file.name && m.targetPath === m.file.path) {
      notes.push({ fileId: m.file.fileId, name: m.file.name, path: m.file.path, status: "already_organized", reason: "Already in the right folder; it's numbered because another file has the same name." });
      continue;
    }
    const parentRef = folders.ensure(m.targetPath);
    ops.push({
      seq: ops.length + 1,
      kind: "move_rename",
      fileId: m.file.fileId,
      docId: m.doc.docId,
      folderPath: null,
      parentRef,
      newName: name,
      pre: { name: m.file.name, parentId: m.file.parentId, version: m.file.version, path: m.file.path },
      newPath: m.targetPath,
      preStatus: null,
      targetStatus: null,
      targetSupersedesId: null,
      reason: name !== m.name ? `${m.reason} Name taken, so numbered.` : m.reason,
      evidence: m.doc.facts,
      dependsOn: folders.dependencies(parentRef),
    });
    moveSeqs.push(ops.length);
  }

  for (const project of [...projects].sort()) {
    const projectMoves = ops.filter((o) => o.kind === "move_rename" && o.newPath?.startsWith(`${projectFolderPath(project, input.files)}/`)).map((o) => o.seq);
    // Nothing moved and the index already exists: there's nothing to rewrite, so a replay stays empty.
    if (projectMoves.length === 0 && input.indexFiles[project]) continue;
    indexOp(ops, folders, project, input.indexFiles[project] ?? null, projectMoves);
  }
  void moveSeqs;
  return { ops, notes };
}

export interface VersionUpdateInput {
  rootId: string;
  files: PlanFile[];
  project: string;
  oldDoc: PlanDoc;
  newDoc: PlanDoc;
  indexFile: { fileId: string; version: string | null } | null;
  evidence: unknown;
  sourceLabel: string;
  statement: string;
}

/**
 * After a contractor points to a newer quote: file the new quote, move the old one to
 * Superseded (never deleted), and update the current-document pointer in the index.
 */
export function buildVersionUpdatePlan(input: VersionUpdateInput): PlanDraft {
  const ops: PlannedOp[] = [];
  const notes: PlanNote[] = [];
  const folders = new Folders(input.rootId, input.files, ops);
  const fileById = new Map(input.files.map((f) => [f.fileId, f]));
  const quotesPath = `${projectFolderPath(input.project, input.files)}/Quotes`;
  const supersededPath = `${quotesPath}/${SUPERSEDED_FOLDER}`;
  const newFile = fileById.get(input.newDoc.fileId);
  const oldFile = fileById.get(input.oldDoc.fileId);
  if (!newFile || !oldFile || !input.newDoc.facts || !input.oldDoc.facts) throw new Error("Both quotes must be in the inventory and read.");

  const moving = new Set<string>();
  const newName = proposedName(input.newDoc.facts, newFile.name, newFile.mimeType) ?? newFile.name;
  const moveNew = newFile.path !== quotesPath || newFile.name !== newName;
  const moveOld = oldFile.path !== supersededPath;
  if (moveNew) moving.add(newFile.fileId);
  if (moveOld) moving.add(oldFile.fileId);
  const taken = takenNames(input.files, moving);

  let newSeq: number | null = null;
  if (moveNew) {
    const parentRef = folders.ensure(quotesPath);
    ops.push({
      seq: ops.length + 1,
      kind: "move_rename",
      fileId: newFile.fileId,
      docId: input.newDoc.docId,
      folderPath: null,
      parentRef,
      newName: claimName(taken, quotesPath, newName),
      pre: { name: newFile.name, parentId: newFile.parentId, version: newFile.version, path: newFile.path },
      newPath: quotesPath,
      preStatus: null,
      targetStatus: null,
      targetSupersedesId: null,
      reason: `File the new quote with the ${input.project.toLowerCase()} quotes. ${input.sourceLabel}: "${input.statement}"`,
      evidence: input.evidence,
      dependsOn: folders.dependencies(parentRef),
    });
    newSeq = ops.length;
  } else notes.push({ fileId: newFile.fileId, name: newFile.name, path: newFile.path, status: "already_organized", reason: "The new quote is already filed." });

  let oldSeq: number | null = null;
  if (moveOld) {
    const parentRef = folders.ensure(supersededPath);
    ops.push({
      seq: ops.length + 1,
      kind: "move_rename",
      fileId: oldFile.fileId,
      docId: input.oldDoc.docId,
      folderPath: null,
      parentRef,
      newName: claimName(taken, supersededPath, oldFile.name),
      pre: { name: oldFile.name, parentId: oldFile.parentId, version: oldFile.version, path: oldFile.path },
      newPath: supersededPath,
      preStatus: null,
      targetStatus: null,
      targetSupersedesId: null,
      reason: "Keep the earlier quote, but move it to Superseded so nobody mistakes it for the current one. Nothing is deleted.",
      evidence: null,
      // Only once the new quote is actually filed: otherwise nothing would be current.
      dependsOn: [...folders.dependencies(parentRef), ...(newSeq ? [newSeq] : [])],
    });
    oldSeq = ops.length;
  }

  ops.push({
    seq: ops.length + 1,
    kind: "set_status",
    fileId: null,
    docId: input.newDoc.docId,
    folderPath: null,
    parentRef: null,
    newName: null,
    pre: null,
    newPath: null,
    preStatus: input.newDoc.versionStatus,
    targetStatus: "current",
    targetSupersedesId: input.oldDoc.docId,
    reason: `Mark the new quote as the current one. This records which quote is current; it doesn't mean you've accepted its price.`,
    evidence: input.evidence,
    dependsOn: newSeq ? [newSeq] : [],
  });
  const currentSeq = ops.length;
  ops.push({
    seq: ops.length + 1,
    kind: "set_status",
    fileId: null,
    docId: input.oldDoc.docId,
    folderPath: null,
    parentRef: null,
    newName: null,
    pre: null,
    newPath: null,
    preStatus: input.oldDoc.versionStatus,
    targetStatus: "superseded",
    targetSupersedesId: null,
    reason: "Mark the earlier quote as superseded by the new one.",
    evidence: input.evidence,
    // Superseded only by a quote that did become current.
    dependsOn: [...(oldSeq ? [oldSeq] : []), currentSeq],
  });
  indexOp(ops, folders, input.project, input.indexFile, [currentSeq, ops.length]);
  return { ops, notes };
}

/** The contractor confirms the quote Fo asked about is the final one: record it as current. */
export function buildConfirmCurrentPlan(input: { rootId: string; files: PlanFile[]; project: string; doc: PlanDoc; indexFile: { fileId: string; version: string | null } | null; evidence: unknown; sourceLabel: string; statement: string }): PlanDraft {
  const ops: PlannedOp[] = [];
  const folders = new Folders(input.rootId, input.files, ops);
  ops.push({
    seq: 1,
    kind: "set_status",
    fileId: null,
    docId: input.doc.docId,
    folderPath: null,
    parentRef: null,
    newName: null,
    pre: null,
    newPath: null,
    preStatus: input.doc.versionStatus,
    targetStatus: "current",
    targetSupersedesId: null,
    reason: `Mark this quote as the current one. ${input.sourceLabel}: "${input.statement}" Being final doesn't mean you've accepted the price.`,
    evidence: input.evidence,
    dependsOn: [],
  });
  indexOp(ops, folders, input.project, input.indexFile, [1]);
  return { ops, notes: [] };
}

export interface UndoSource {
  opSeq: number;
  kind: "move_rename" | "set_status";
  fileId: string | null;
  docId: string | null;
  beforeName: string | null;
  beforeParentId: string | null;
  beforePath: string | null;
  afterName: string | null;
  afterParentId: string | null;
  afterVersion: string | null;
  afterPath: string | null;
  statusBefore: string | null;
  supersedesBefore: string | null;
  statusAfter: string | null;
}

/** Reverses verified changes, newest first. Folders Kiki created stay; nothing is deleted. */
export function buildUndoPlan(input: { project: string | null; changes: UndoSource[]; indexFile: { fileId: string; version: string | null } | null; rootId: string; files: PlanFile[] }): PlanDraft {
  const ops: PlannedOp[] = [];
  const folders = new Folders(input.rootId, input.files, ops);
  for (const c of [...input.changes].sort((a, b) => b.opSeq - a.opSeq)) {
    if (c.kind === "move_rename" && c.fileId && c.beforeName && c.beforeParentId) {
      ops.push({
        seq: ops.length + 1,
        kind: "move_rename",
        fileId: c.fileId,
        docId: c.docId,
        folderPath: null,
        parentRef: { file: c.beforeParentId },
        newName: c.beforeName,
        pre: { name: c.afterName ?? "", parentId: c.afterParentId, version: c.afterVersion, path: c.afterPath ?? "" },
        newPath: c.beforePath,
        preStatus: null,
        targetStatus: null,
        targetSupersedesId: null,
        reason: `Put "${c.afterName}" back as "${c.beforeName}"${c.beforePath !== null ? ` in ${c.beforePath || "the workspace folder"}` : ""}. If it changed since, Kiki stops instead.`,
        evidence: null,
        dependsOn: [],
      });
    } else if (c.kind === "set_status" && c.docId) {
      ops.push({
        seq: ops.length + 1,
        kind: "set_status",
        fileId: null,
        docId: c.docId,
        folderPath: null,
        parentRef: null,
        newName: null,
        pre: null,
        newPath: null,
        preStatus: c.statusAfter,
        targetStatus: c.statusBefore,
        targetSupersedesId: c.supersedesBefore,
        reason: "Restore the index status this document had before.",
        evidence: null,
        dependsOn: [],
      });
    }
  }
  if (input.project && ops.length) indexOp(ops, folders, input.project, input.indexFile, ops.map((o) => o.seq));
  return { ops, notes: [] };
}
