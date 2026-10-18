/**
 * Which collection each new document belongs to. Decided across the whole workspace, not one
 * document at a time, so one project spelled three ways ("CS245", "CS 245 - Logic and
 * Computation") is one collection, a launch's deck lands with its meeting notes, and a folder the
 * user already keeps ("School/CS 245", "Taxes") is used before Kiki invents one.
 *
 * Pure and deterministic: every assignment cites the fact it rests on, and a document with
 * nothing to go on gets no assignment (it stays where it is and Kiki asks).
 */
import type { DocFacts } from "./documents.ts";
import { issuerKey } from "./safety.ts";

/** Kiki's own top-level folders: collections live inside them. */
export const KIKI_ROOTS = ["Projects", "Renovations"];
const KIKI_INTERNAL = new Set(["Duplicates", "Superseded"]);

const STOP = new Set("the a an of and for to in on at by with re no number ref project course".split(" "));
/** Words that say what kind of thing something is, not which one: they can't identify a collection. */
const GENERIC = new Set(
  "note notes report invoice quote quotation estimate receipt letter document documents file files misc miscellaneous new folder stuff other others scan scans untitled copy final draft archive old general personal work school home shared inbox download downloads desktop"
    .split(" ")
    .map((w) => stem(w)),
);

function stem(w: string): string {
  if (w.length > 4 && /(x|s|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Comparable words: case, accents and punctuation ignored, letters and digits split ("CS245" = "CS 245"), simple plurals folded. */
export function words(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

/** The words that can identify a collection: not generic, and at least one of them not just a number. */
function identifying(name: string): string[] {
  const ws = words(name).filter((w) => !GENERIC.has(w));
  return ws.some((w) => /[a-z]/.test(w)) ? ws : [];
}

export interface CollectionDoc {
  docId: string;
  facts: DocFacts;
}

export interface Destination {
  /** "user": a folder the user keeps, filed into directly. "kiki": Projects/<name>/<type>. */
  kind: "user" | "kiki";
  /** Why: the folder's name is in the document, its stated project, its title, its supplier, the user chose it, or Kiki learned it from them. */
  how: "folder" | "project" | "title" | "supplier" | "choice" | "learned" | "suggested";
  name: string;
  /** The user's folder path; for Kiki's collections the path follows from the name. */
  path: string | null;
  /** The fact this rests on, for the reason shown to the user. */
  because: string;
}

interface Folder {
  path: string;
  name: string;
  isFolder: boolean;
  isShortcut: boolean;
}

/** Folder names that only say "not sorted yet". */
const CATCH_ALL = new Set(
  "old new folder scan scans download downloads desktop inbox misc miscellaneous stuff untitled unsorted sort temp tmp random other others copy file files document documents"
    .split(" ")
    .map((w) => stem(w)),
);

/**
 * Already filed: anywhere except the top of the workspace and catch-all folders ("Old scans",
 * "Downloads", "New folder"). A folder the user made ("School", "Taxes", "Archive") is where they
 * meant it to be, so Kiki leaves it there.
 */
export function isFiledPath(path: string, roots: string[] = KIKI_ROOTS): boolean {
  if (!path) return false;
  const segments = path.split("/");
  // Loose in Projects itself, outside any project, isn't filed: it was dropped there.
  if (roots.includes(segments[0]!)) return segments.length > 1;
  return segments.some((s) => !words(s).every((w) => CATCH_ALL.has(w)));
}

/** Folders the user keeps that can take documents: outside Kiki's own folders, named after something specific. */
export function userFolders(files: Folder[], roots: string[] = KIKI_ROOTS): { path: string; name: string; words: string[] }[] {
  const folders = files.filter((f) => f.isFolder && !f.isShortcut);
  const full = (f: Folder) => (f.path ? `${f.path}/${f.name}` : f.name);
  return folders
    .filter((f) => !roots.includes(full(f).split("/")[0]!) && !KIKI_INTERNAL.has(f.name))
    .map((f) => ({ path: full(f), name: f.name, words: identifying(f.name) }))
    .filter((f) => f.words.length > 0);
}

/** Collections Kiki already made: the folders directly inside Projects (or the earlier Renovations). */
export function kikiCollections(files: Folder[], roots: string[] = KIKI_ROOTS): string[] {
  return files.filter((f) => f.isFolder && !f.isShortcut && roots.includes(f.path)).map((f) => f.name);
}

/**
 * Where the user said a file goes ("Kitchen", "Taxes", "School/CS 245"): a folder they keep, by its
 * path or its name; a collection Kiki keeps, however it's spelled; or a new collection by that
 * name. Null when it climbs out of a folder, or more than one of their folders could be meant.
 */
export function choosePlace(place: string, files: Folder[], roots: string[] = KIKI_ROOTS): Destination | null {
  const wanted = place.trim().replace(/^\/+|\/+$/g, "");
  if (!wanted || wanted.split("/").some((s) => /^\s*\.+\s*$/.test(s))) return null;
  // A path inside Kiki's own folders ("Projects/Flooring/Invoices") names that collection.
  const [root, collection] = wanted.split("/");
  if (roots.includes(root!) && collection) {
    return { kind: "kiki", how: "choice", name: kikiCollections(files, roots).find((c) => c.toLowerCase() === collection.toLowerCase()) ?? collection, path: null, because: place };
  }
  const full = (f: Folder) => (f.path ? `${f.path}/${f.name}` : f.name);
  const theirs = files.filter((f) => f.isFolder && !f.isShortcut && !roots.includes(full(f).split("/")[0]!) && !KIKI_INTERNAL.has(f.name));
  const lower = wanted.toLowerCase();
  const byPath = theirs.filter((f) => full(f).toLowerCase() === lower);
  const named = byPath.length ? byPath : theirs.filter((f) => f.name.toLowerCase() === lower || isSameCollection(f.name, wanted));
  if (named.length > 1) return null;
  if (named.length === 1) return { kind: "user", how: "choice", name: named[0]!.name, path: full(named[0]!), because: place };
  const kept = kikiCollections(files, roots).filter((name) => isSameCollection(name, wanted));
  return { kind: "kiki", how: "choice", name: kept.length === 1 ? kept[0]! : wanted, path: null, because: place };
}

const isPrefix = (a: string[], b: string[]) => a.length > 0 && a.length <= b.length && a.every((w, i) => b[i] === w);
const sameCollection = (a: string[], b: string[]) => isPrefix(a, b) || isPrefix(b, a);

/** One project spelled two ways: "CS245" and "CS 245 - Logic and Computation", "Nimbus launch" and "Nimbus launch website". */
export const isSameCollection = (a: string, b: string) => sameCollection(words(a), words(b));

/** The shortest spelling that names the shared words, taken from the documents' own text ("CS 245", not "cs 245"). */
function displayName(members: string[], shared: string[]): string {
  let best: string | null = null;
  for (const m of members) {
    // Cut each member right after the shared words, keeping its own spelling.
    const re = /[A-Za-z0-9]+/g;
    let count = 0;
    let end = 0;
    for (let match = re.exec(m); match && count < shared.length; match = re.exec(m)) {
      count += words(match[0]).length;
      end = match.index + match[0].length;
    }
    if (count < shared.length) continue;
    const cut = m.slice(0, end).trim();
    if (!best || cut.length > best.length) best = cut;
  }
  return best ?? members[0]!;
}

/**
 * Assigns each new document a destination, or none. In order: a folder the user keeps whose
 * name is entirely in the document's facts; a collection named by the document's project (the
 * same project spelled differently is one collection, and an existing Kiki collection keeps its
 * name); a related collection named in the title (a deck titled "Nimbus - Investor update" joins
 * Nimbus launch); the collection holding the same supplier's other documents (invoices, quotes,
 * receipts only).
 */
export function assignCollections(input: {
  inbox: CollectionDoc[];
  /** Filed documents and where they are, so a supplier's next invoice goes where its others went. */
  filed: { facts: DocFacts | null; collection: string | null }[];
  files: Folder[];
  /** Kiki's own top-level folders here ("Renovations" only when she made it). */
  roots?: string[];
}): Map<string, Destination> {
  const out = new Map<string, Destination>();
  const users = userFolders(input.files, input.roots);
  const existing = kikiCollections(input.files, input.roots).map((name) => ({ name, words: words(name) }));
  const factWords = (f: DocFacts) => new Set([...words(f.project.value), ...words(f.title?.value), ...words(f.issuer.value)]);

  // 1. A folder the user keeps.
  for (const d of input.inbox) {
    const have = factWords(d.facts);
    const fits = users.filter((u) => u.words.every((w) => have.has(w)));
    const most = Math.max(0, ...fits.map((u) => u.words.length));
    const best = fits.filter((u) => u.words.length === most);
    if (best.length === 1) {
      const u = best[0]!;
      const source = [d.facts.project.value, d.facts.title?.value, d.facts.issuer.value].find((v) => v && u.words.every((w) => words(v).includes(w)));
      out.set(d.docId, { kind: "user", how: "folder", name: u.name, path: u.path, because: source ?? u.name });
    }
  }

  // 2. Collections named by the documents' projects, merging spellings of the same one.
  type Cluster = { words: string[]; names: string[]; docs: string[]; existing: string | null };
  const clusters: Cluster[] = existing.map((e) => ({ words: e.words, names: [e.name], docs: [], existing: e.name }));
  const join = (name: string, docId: string | null) => {
    const ws = words(name);
    if (ws.length === 0) return;
    const hit = clusters.find((c) => sameCollection(c.words, ws));
    if (hit) {
      hit.names.push(name);
      if (docId) hit.docs.push(docId);
      if (!hit.existing && ws.length < hit.words.length) hit.words = ws;
    } else clusters.push({ words: ws, names: [name], docs: docId ? [docId] : [], existing: null });
  };
  for (const d of input.inbox) if (!out.has(d.docId) && d.facts.project.value) join(d.facts.project.value, d.docId);
  const nameOf = (c: Cluster) => c.existing ?? (c.names.length === 1 ? c.names[0]! : displayName(c.names, c.words));

  // 3. A document alone in its collection, or with no project, whose title names a bigger one, joins it.
  const head = (c: Cluster) => c.words.find((w) => !GENERIC.has(w) && /[a-z]/.test(w)) ?? null;
  const byTitle = new Set<string>();
  for (const d of input.inbox) {
    if (out.has(d.docId)) continue;
    const own = clusters.find((c) => c.docs.includes(d.docId));
    if (own && (own.docs.length > 1 || own.existing)) continue;
    const titleWords = new Set(words(d.facts.title?.value));
    const others = clusters.filter((c) => c !== own && (c.docs.length > 0 || c.existing) && head(c) !== null && titleWords.has(head(c)!));
    if (others.length === 1) {
      if (own) own.docs.splice(own.docs.indexOf(d.docId), 1);
      others[0]!.docs.push(d.docId);
      byTitle.add(d.docId);
    }
  }
  for (const c of clusters) {
    for (const docId of c.docs) {
      const d = input.inbox.find((x) => x.docId === docId)!;
      out.set(
        docId,
        byTitle.has(docId)
          ? { kind: "kiki", how: "title", name: nameOf(c), path: null, because: d.facts.title!.value! }
          : { kind: "kiki", how: "project", name: nameOf(c), path: null, because: d.facts.project.value ?? nameOf(c) },
      );
    }
  }

  // 4. A supplier's invoice, quote or receipt goes where its other documents are, if that's one place.
  const supplierPlaces = new Map<string, Set<string>>();
  const supplierCount = new Map<string, number>();
  const note = (facts: DocFacts | null, place: string | null) => {
    const key = issuerKey(facts?.issuer.value);
    if (key && place) {
      supplierPlaces.set(key, (supplierPlaces.get(key) ?? new Set()).add(place));
      supplierCount.set(key, (supplierCount.get(key) ?? 0) + 1);
    }
  };
  for (const f of input.filed) note(f.facts, f.collection);
  for (const d of input.inbox) {
    const dest = out.get(d.docId);
    if (dest) note(d.facts, dest.kind === "user" ? `user:${dest.path}` : dest.name);
  }
  for (const d of input.inbox) {
    const key = issuerKey(d.facts.issuer.value);
    if (out.has(d.docId) || !key || !["invoice", "quote", "receipt"].includes(d.facts.docType)) continue;
    const places = supplierPlaces.get(key);
    if (!places || places.size !== 1) continue;
    const place = [...places][0]!;
    const n = supplierCount.get(key)!;
    const where = place.startsWith("user:") ? place.slice(5) : place;
    const because = `No project on it, but ${d.facts.issuer.value}'s other ${n === 1 ? "document is" : `${n} documents are`} in ${where}.`;
    out.set(d.docId, place.startsWith("user:") ? { kind: "user", how: "supplier", name: where.split("/").pop()!, path: where, because } : { kind: "kiki", how: "supplier", name: place, path: null, because });
  }
  return out;
}
