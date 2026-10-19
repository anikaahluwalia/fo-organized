import { useState } from "react";
import type { AppView, FileView, ProjectIndexView } from "../../shared/api.ts";
import { post } from "./api.ts";
import { AskContractor } from "./Contractor.tsx";
import { Badge, docWord, Icon, joinPath, type Act } from "./ui.tsx";

export interface Collection {
  path: string;
  link: string | null;
  files: FileView[];
  index: ProjectIndexView | null;
}

/**
 * One entry per folder that holds files, with the project index that lives there, top level
 * first. A project whose folder doesn't exist yet (the plan would make it) isn't a folder here.
 */
export function collections(view: AppView): Collection[] {
  const folders = new Map(view.inventory.files.filter((f) => f.kind === "folder").map((f) => [joinPath(f.path, f.name), f]));
  const groups = new Map<string, Collection>();
  const ensure = (path: string) => {
    const found = groups.get(path);
    if (found) return found;
    const made: Collection = { path, link: path ? (folders.get(path)?.link ?? null) : (view.workspace?.link ?? null), files: [], index: null };
    groups.set(path, made);
    return made;
  };
  for (const f of view.inventory.files) if (f.kind !== "folder") ensure(f.path).files.push(f);
  for (const p of view.index) {
    const path = joinPath(p.category, p.name);
    if (groups.has(path) || folders.has(path)) ensure(path).index = p;
  }
  return [...groups.values()].sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.path.localeCompare(b.path)));
}

export const folderLabel = (path: string, workspace: string) => (path ? path.split("/").join(" / ") : workspace);

const fileType = (name: string) => /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toUpperCase() ?? "File";

function FileRow({ f, allStaged }: { f: FileView; allStaged: boolean }) {
  const d = f.doc;
  const unreadable = d?.readStatus === "failed" || d?.readStatus === "unreadable";
  const kind = d?.readStatus === "read" ? docWord(d.docType) : d?.readStatus === "reading" || d?.readStatus === "pending" ? "Not read yet" : null;
  return (
    <li className="file-row">
      <div className="file-row__main">
        <span className="file-row__name">{f.name}</span>
        <span className="muted small">{[kind, fileType(f.name), d?.readStatus === "read" ? d.total.value : null].filter(Boolean).join(" · ")}</span>
        {d?.readError && <span className="error-text">{d.readError}</span>}
      </div>
      <span className="row">
        {f.isNew && <Badge kind="plain">New</Badge>}
        {f.origin === "created_by_kiki" && <Badge kind="plain">Made by Kiki</Badge>}
        {f.origin === "staged_demo" && !allStaged && <Badge kind="demo">Staged demo file</Badge>}
        {unreadable && <span className="chip chip--needs_review">Couldn't read</span>}
      </span>
    </li>
  );
}

/** A project's index: every document Kiki keeps track of there, and what you can do about its quotes. */
function IndexBlock({ p, view, act }: { p: ProjectIndexView; view: AppView; act: Act }) {
  const [asking, setAsking] = useState<string | null>(null);
  const quotesFrom = (issuer: string | null) => (issuer ? p.rows.filter((r) => r.docType === "quote" && r.issuer === issuer).length : 0);
  return (
    <section className="index-block" aria-labelledby={`idx-${p.name}`}>
      <div className="section-head">
        <h3 id={`idx-${p.name}`}>{p.name} index</h3>
        {p.indexFileLink && (
          <a className="link-quiet" href={p.indexFileLink} target="_blank" rel="noreferrer">
            Open in Drive <Icon name="external" size={16} />
          </a>
        )}
      </div>
      <ul className="rows">
        {p.rows.map((r) => {
          const several = quotesFrom(r.issuer) >= 2;
          return (
            <li key={r.docId} className="index-row">
              <div className="index-row__head">
                <span className="strong">{[`${docWord(r.docType)}${r.reference ? ` ${r.reference}` : ""}`, r.issuer].filter(Boolean).join(", ")}</span>
                {r.total && <span>{r.total}</span>}
              </div>
              {(r.status === "current" || r.status === "superseded" || r.acceptedAt || (r.latestReceived && r.docType === "quote" && several)) && (
                <div className="row">
                  {r.status === "current" && <span className="chip chip--confirmed">Current</span>}
                  {r.status === "superseded" && <span className="chip chip--needs_review">Superseded</span>}
                  {r.latestReceived && r.docType === "quote" && several && <span className="chip chip--not_searched">Latest received</span>}
                  {r.acceptedAt && <span className="chip chip--confirmed">Price accepted by you</span>}
                </div>
              )}
              <p className="muted small">
                {[r.date && !r.fileName.startsWith(r.date) ? r.date : null, r.fileName].filter(Boolean).join(", ")}
                {r.supersedes ? `, replaces ${r.supersedes}` : ""}
              </p>
              {r.docType === "quote" && r.status !== "superseded" && (
                <div className="row">
                  {r.canAsk && asking !== r.docId && (
                    <button className="btn btn--quiet btn--small" onClick={() => setAsking(r.docId)}>
                      Ask if it's final
                    </button>
                  )}
                  {r.status !== "current" && several && (
                    <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`current-${r.docId}`, () => post(`/api/documents/${r.docId}/current`))}>
                      Mark current
                    </button>
                  )}
                  <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`accept-${r.docId}`, () => post(`/api/documents/${r.docId}/accept`, { accepted: !r.acceptedAt }))}>
                    {r.acceptedAt ? "Withdraw price acceptance" : "Mark price accepted"}
                  </button>
                </div>
              )}
              {asking === r.docId && <AskContractor row={r} view={view} act={act} onDone={() => setAsking(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CollectionRow({ c, view, act, allStaged }: { c: Collection; view: AppView; act: Act; allStaged: boolean }) {
  const [open, setOpen] = useState(false);
  const id = `col-${c.path || "top"}`.replace(/[^A-Za-z0-9_-]/g, "-");
  return (
    <li className="collection">
      <div className="collection__head">
        <button className="collection__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <Icon name="folder" />
          <span className="collection__name">{folderLabel(c.path, view.workspace?.name ?? "Top level")}</span>
          <span className="muted small nowrap">
            {c.files.length} file{c.files.length === 1 ? "" : "s"}
          </span>
          <span className={`chev ${open ? "chev--open" : ""}`}>
            <Icon name="chevronDown" size={18} />
          </span>
        </button>
        {c.link && (
          <a className="link-quiet nowrap" href={c.link} target="_blank" rel="noreferrer">
            Open in Drive <Icon name="external" size={16} />
            <span className="visually-hidden"> ({folderLabel(c.path, view.workspace?.name ?? "")})</span>
          </a>
        )}
      </div>
      {open && (
        <div id={id} className="collection__body">
          {c.files.length > 0 && (
            <ul className="rows">
              {c.files.map((f) => (
                <FileRow key={f.fileId} f={f} allStaged={allStaged} />
              ))}
            </ul>
          )}
          {c.index && <IndexBlock p={c.index} view={view} act={act} />}
        </div>
      )}
    </li>
  );
}

/** Every folder Kiki keeps, its files and project index, then everything Kiki sees in one list. */
export function Browse({ view, act }: { view: AppView; act: Act }) {
  if (!view.workspace) return <p className="muted">Choose a folder first. Kiki shows what's in it here.</p>;
  const files = view.inventory.files.filter((f) => f.kind !== "folder");
  // Kiki's own files say so on their row; the rest are either all staged for the demo or not.
  const allStaged = files.some((f) => f.origin === "staged_demo") && files.every((f) => f.origin === "staged_demo" || f.origin === "created_by_kiki");
  const mockReading = files.some((f) => f.doc?.readMode === "mock");
  const list = collections(view);
  const loose = view.index.filter((p) => !list.some((c) => c.index === p));
  return (
    <div className="stack-lg">
      <section aria-labelledby="folders-title">
        <div className="section-head">
          <h2 id="folders-title">Folders</h2>
          <span className="row">
            {allStaged && <Badge kind="demo">Staged demo files</Badge>}
            {mockReading && <Badge kind="mock">Mock reading</Badge>}
            {view.inventory.reading > 0 && <span className="muted small">Reading {view.inventory.reading}…</span>}
          </span>
        </div>
        {list.length ? (
          <ul className="collections">
            {list.map((c) => (
              <CollectionRow key={c.path} c={c} view={view} act={act} allStaged={allStaged} />
            ))}
          </ul>
        ) : (
          <p className="muted">The folder is empty.</p>
        )}
      </section>
      {loose.length > 0 && (
        <section aria-labelledby="loose-title">
          <h2 id="loose-title" className="section-head">
            Project indexes
          </h2>
          <div className="stack">
            {loose.map((p) => (
              <IndexBlock key={p.name} p={p} view={view} act={act} />
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="files-title">
        <details className="fold">
          <summary>
            <h2 id="files-title">All files ({files.length})</h2>
            <span className="chev">
              <Icon name="chevronDown" size={18} />
            </span>
          </summary>
          <ul className="rows">
            {files.map((f) => (
              <li key={f.fileId} className="file-row">
                <div className="file-row__main">
                  <span className="file-row__name">{f.name}</span>
                  <span className="muted small">{folderLabel(f.path, view.workspace!.name)}</span>
                  {f.doc?.readError && <span className="error-text">{f.doc.readError}</span>}
                </div>
                <span className="row">
                  {f.isNew && <Badge kind="plain">New</Badge>}
                  {f.origin === "created_by_kiki" && <Badge kind="plain">Made by Kiki</Badge>}
                  {f.origin === "staged_demo" && !allStaged && <Badge kind="demo">Staged demo file</Badge>}
                  {(f.doc?.readStatus === "failed" || f.doc?.readStatus === "unreadable") && <span className="chip chip--needs_review">Couldn't read</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </section>
    </div>
  );
}
