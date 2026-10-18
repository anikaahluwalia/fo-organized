import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppView, LessonView, NotificationView, OpView, PlanView } from "../../shared/api.ts";
import { getState, newId, post, time } from "./api.ts";
import { Kiki } from "./Kiki.tsx";
import { AskContractor, AskForCopy, OutreachCard, UpdateCard } from "./Contractor.tsx";
import { ExtensionPairing } from "./ExtensionPairing.tsx";

/** A step's state, shown only once it isn't waiting for approval (the plan's chip says that). */
const OP_STATE: Record<string, string> = {
  running: "Applying…",
  verified: "Verified",
  failed: "Failed",
  stale: "Stopped: changed since preview",
  skipped: "Didn't run",
  uncertain: "Uncertain: checking Drive",
};

const PLAN_STATUS: Record<string, string> = {
  proposed: "Proposed",
  approved: "Approved",
  executing: "Applying",
  applied: "Applied and verified",
  partial: "Partly applied",
  stale: "Stopped: refresh needed",
  failed: "Failed",
  superseded: "Replaced by a newer version",
  discarded: "Set aside",
};

/** How long a finished plan, or a text about it, stays the news in the strip. */
const RECENT_MS = 30 * 60_000;

function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );
  return { busy, error, run, setError };
}

type Act = ReturnType<typeof useAction>;

function Badge({ kind, children }: { kind: "live" | "mock" | "demo" | "problem" | "plain"; children: React.ReactNode }) {
  return <span className={`badge ${kind === "plain" ? "" : `badge--${kind}`}`}>{children}</span>;
}

const connectGoogle = (act: Act, gmail = false) =>
  act.run(gmail ? "connect-gmail" : "connect-google", async () => {
    const r = await post<{ authorizationUrl: string }>("/api/google/connect", gmail ? { gmail: true } : {});
    window.location.href = r.authorizationUrl;
  });

function Integrations({ view, act }: { view: AppView; act: Act }) {
  const { drive, fo } = view.integrations;
  return (
    <div className="header-tools">
      {drive.mode === "mock" ? (
        <Badge kind="mock">Mock Drive</Badge>
      ) : drive.connection === "connected" ? (
        <Badge kind="live">Live Drive</Badge>
      ) : drive.connection === "not_configured" ? (
        <Badge kind="problem">Drive not set up</Badge>
      ) : (
        <button className="btn btn--small" onClick={() => connectGoogle(act)} disabled={act.busy !== null}>
          Connect Google Drive
        </button>
      )}
      {fo.mode === "mock" ? (
        <Badge kind="mock">Mock Fo</Badge>
      ) : fo.connection === "connected" ? (
        <Badge kind="live">Live Fo</Badge>
      ) : (
        <button
          className="btn btn--small"
          disabled={act.busy !== null}
          onClick={() =>
            act.run("connect-fo", async () => {
              const r = await post<{ authorizationUrl: string }>("/api/fo/connect");
              window.location.href = r.authorizationUrl;
            })
          }
        >
          Connect Fo
        </button>
      )}
    </div>
  );
}

/** No folder yet: the demo folder, or one you paste. */
function WorkspaceSetup({ view, act }: { view: AppView; act: Act }) {
  const [folder, setFolder] = useState("");
  const driveReady = view.integrations.drive.mode === "mock" || view.integrations.drive.connection === "connected";
  return (
    <section className="stack" aria-label="Choose a folder">
      {view.integrations.drive.connection === "not_configured" && (
        <div className="notice notice--warn">
          <strong>Google Drive isn't set up yet.</strong>
          <p>{view.integrations.drive.message}</p>
        </div>
      )}
      <div className="row">
        <button className="btn btn--primary" disabled={!driveReady || act.busy !== null} onClick={() => act.run("demo", () => post("/api/workspace/demo"))}>
          {act.busy === "demo" ? "Setting up…" : "Set up the demo folder"}
        </button>
        <Badge kind="demo">Staged demo files</Badge>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act.run("select", () => post("/api/workspace/select", { folder }));
        }}
      >
        <label htmlFor="folder">Or paste a Drive folder link</label>
        <div className="edit-row">
          <input id="folder" type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" />
          <button className="btn" disabled={!driveReady || !folder.trim() || act.busy !== null}>
            Use this folder
          </button>
        </div>
        <p className="hint">Kiki works only inside this folder.</p>
      </form>
    </section>
  );
}

const docWord = (t: string) => (t === "other" || t === "unknown" ? "Document" : t.charAt(0).toUpperCase() + t.slice(1));

function InventoryCard({ view }: { view: AppView }) {
  if (!view.workspace) return null;
  const files = view.inventory.files.filter((f) => f.kind !== "folder");
  // Kiki's own files say so on their row; the rest are either all staged for the demo or not.
  const allStaged = files.some((f) => f.origin === "staged_demo") && files.every((f) => f.origin === "staged_demo" || f.origin === "created_by_kiki");
  const mockReading = files.some((f) => f.doc?.readMode === "mock");
  return (
    <section>
      <details>
        <summary>
          Files ({files.length}) {allStaged && <Badge kind="demo">Staged demo files</Badge>} {mockReading && <Badge kind="mock">Mock reading</Badge>}{" "}
          {view.inventory.reading > 0 && <span className="hint">Reading {view.inventory.reading}…</span>}
        </summary>
        <ul className="item-list">
          {files.map((f) => {
            const d = f.doc;
            const unreadable = d?.readStatus === "failed" || d?.readStatus === "unreadable";
            return (
              <li key={f.fileId} className="item">
                <div className="item-head">
                  <span className="item-label">{f.name}</span>
                  <span className="row">
                    {f.isNew && <Badge kind="live">New</Badge>}
                    {f.origin === "created_by_kiki" && <Badge kind="plain">Made by Kiki</Badge>}
                    {f.origin === "staged_demo" && !allStaged && <Badge kind="demo">Staged demo file</Badge>}
                    {unreadable && <span className="chip chip--needs_review">Couldn't read</span>}
                  </span>
                </div>
                {d?.readStatus === "read" && <p className="hint">{[docWord(d.docType), d.issuer.value, d.total.value].filter(Boolean).join(", ")}</p>}
                {f.path && <p className="hint">{f.path}</p>}
                {d?.readError && <p className="error-text">{d.readError}</p>}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

const joinPath = (path: string, name: string) => (path ? `${path}/${name}` : name);

interface PlanGroup {
  path: string;
  /** The step that creates this folder, when the plan makes it. */
  folder: OpView | null;
  ops: OpView[];
}

/** A plan's steps by destination folder, in order of first appearance; new folders are tags on their group. */
function planGroups(plan: PlanView): { groups: PlanGroup[]; excluded: OpView[] } {
  const folders = new Map(plan.ops.filter((o) => o.kind === "create_folder" && o.after && o.state !== "excluded").map((o) => [joinPath(o.after!.path, o.after!.name), o]));
  const groups = new Map<string, PlanGroup>();
  const excluded: OpView[] = [];
  for (const op of plan.ops) {
    if (op.kind === "create_folder") continue;
    if (op.state === "excluded") {
      excluded.push(op);
      continue;
    }
    const path = op.after?.path ?? "";
    const group = groups.get(path) ?? { path, folder: folders.get(path) ?? null, ops: [] };
    group.ops.push(op);
    groups.set(path, group);
  }
  // A new folder shows as its own group only when no group path shows it, or when its step went wrong.
  for (const [path, op] of folders) {
    const shown = groups.has(path) || [...groups.keys()].some((g) => g.startsWith(`${path}/`));
    if (!shown || op.error || (op.state !== "pending" && op.state !== "verified")) if (!groups.has(path)) groups.set(path, { path, folder: op, ops: [] });
  }
  for (const g of groups.values()) g.ops.sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed"));
  return { groups: [...groups.values()], excluded };
}

function OpState({ op }: { op: OpView }) {
  const label = OP_STATE[op.state];
  if (!label) return null;
  return <span className={`chip ${op.state === "verified" ? "chip--confirmed" : "chip--needs_review"}`}>{label}</span>;
}

/** Rename a step's file, or leave it out of the plan (a new version either way). */
function OpEditor({ planId, op, act, onClose }: { planId: string; op: OpView; act: Act; onClose: () => void }) {
  const [value, setValue] = useState(op.after?.name ?? "");
  const revise = (key: string, edit: Record<string, unknown>) =>
    act.run(key, async () => {
      await post(`/api/plans/${planId}/revise`, { edits: [{ seq: op.seq, ...edit }] });
      onClose();
    });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void revise(`rename-${op.seq}`, { newName: value });
      }}
    >
      <label htmlFor={`name-${planId}-${op.seq}`}>New name</label>
      <div className="edit-row">
        <input id={`name-${planId}-${op.seq}`} type="text" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn btn--small" disabled={!value.trim() || act.busy !== null}>
          Save
        </button>
      </div>
      <div className="row">
        <button type="button" className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => void revise(`skip-${op.seq}`, { exclude: true })}>
          Skip this file
        </button>
        <button type="button" className="btn btn--quiet btn--small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PlanRow({ plan, op, act }: { plan: PlanView; op: OpView; act: Act | null }) {
  const [editing, setEditing] = useState(false);
  const before = op.before;
  const after = op.after;
  let lines: React.ReactNode;
  if (op.kind === "move_rename" && before && after) {
    const from = before.path ? ` from ${before.path}` : "";
    lines =
      before.name === after.name ? (
        <p>
          <strong>{after.name}</strong>
          {from && <span className="hint">{from}</span>}
        </p>
      ) : (
        <>
          <p className="hint">
            {before.name}
            {from}
          </p>
          <p>
            <strong>→ {after.name}</strong>
          </p>
        </>
      );
  } else if (op.kind === "write_index" && after) {
    lines = <p>{op.title.startsWith("Create") ? <strong>+ {after.name}</strong> : <><strong>{after.name}</strong> <span className="hint">updated</span></>}</p>;
  } else {
    lines = <p>{op.title}</p>;
  }
  return (
    <li className="plan-row">
      <div>{lines}</div>
      <div className="row">
        <OpState op={op} />
        {act && op.editable && op.state === "pending" && !editing && (
          <button className="btn btn--quiet btn--small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {act && editing && <OpEditor planId={plan.id} op={op} act={act} onClose={() => setEditing(false)} />}
      {op.error && <p className="error-text">{op.error}</p>}
    </li>
  );
}

/** For a file Kiki couldn't place: say where it goes, and Kiki adds it to the plan (a new version). */
function PlaceEditor({ planId, fileId, options, act }: { planId: string; fileId: string; options: string[]; act: Act }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) {
    return (
      <button className="btn btn--quiet btn--small" onClick={() => setOpen(true)}>
        Choose a folder
      </button>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(`place-${fileId}`, async () => {
          await post(`/api/plans/${planId}/place`, { fileId, place: value });
          setOpen(false);
        });
      }}
    >
      <label htmlFor={`place-${fileId}`}>Folder</label>
      <div className="edit-row">
        <input id={`place-${fileId}`} type="text" list={`places-${fileId}`} value={value} onChange={(e) => setValue(e.target.value)} />
        <datalist id={`places-${fileId}`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <button className="btn btn--small" disabled={!value.trim() || act.busy !== null}>
          Add
        </button>
        <button type="button" className="btn btn--quiet btn--small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Every step, grouped by the folder it ends up in, then what stays where it is. Read-only without `act`. */
function PlanSteps({ plan, act }: { plan: PlanView; act: Act | null }) {
  const { groups, excluded } = planGroups(plan);
  const placeable = act && plan.status === "proposed" && plan.kind === "organize";
  return (
    <>
      {groups.map((g) => (
        <div key={g.path} className="plan-group">
          <div className="item-head">
            <span className="item-label">{g.path || "Top level"}</span>
            {g.folder && (
              <span className="row">
                <span className="chip chip--not_searched">New folder</span>
                <OpState op={g.folder} />
              </span>
            )}
          </div>
          {g.folder?.error && <p className="error-text">{g.folder.error}</p>}
          {g.ops.length > 0 && (
            <ul className="plain-list">
              {g.ops.map((op) => (
                <PlanRow key={op.seq} plan={plan} op={op} act={act} />
              ))}
            </ul>
          )}
        </div>
      ))}
      {(plan.notes.length > 0 || excluded.length > 0) && (
        <div className="plan-group">
          <span className="item-label">Stays where it is</span>
          <ul className="plain-list">
            {excluded.map((op) => (
              <li key={`op-${op.seq}`} className="plan-row">
                <p>{op.before?.name ?? op.after?.name}</p>
              </li>
            ))}
            {plan.notes.map((n) => (
              <li key={n.fileId} className="plan-row">
                <p>{n.name}</p>
                {placeable && n.unplaced && <PlaceEditor planId={plan.id} fileId={n.fileId} options={n.options} act={act} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function planChip(status: PlanView["status"]): string {
  return `chip chip--${status === "applied" ? "confirmed" : status === "proposed" ? "not_searched" : "needs_review"}`;
}

/** A plan waiting for you, running, or stopped part-way. Approve sits in its own footer. */
function PlanCard({ plan, act, fo }: { plan: PlanView; act: Act; fo: AppView["integrations"]["fo"] }) {
  return (
    <section className="card" aria-labelledby={`plan-${plan.id}`}>
      <div className="card-head">
        <h2 id={`plan-${plan.id}`}>{plan.version > 1 ? `Plan, version ${plan.version}` : "Plan"}</h2>
        <span className={planChip(plan.status)}>{PLAN_STATUS[plan.status]}</span>
      </div>
      {plan.evidence && (
        <div className="notice notice--info">
          <strong>{plan.evidence.source}</strong>
          <p className="quote">“{plan.evidence.statement}”</p>
          {plan.evidence.candidateReasons.length > 0 && (
            <details>
              <summary>Why this file</summary>
              <p>{plan.evidence.candidateReasons.join(" ")}</p>
            </details>
          )}
        </div>
      )}
      {plan.diff && plan.diff.lines.length > 0 && (
        <div className="notice notice--warn">
          <strong>What changed</strong>
          {plan.diff.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          <p>Marking it current doesn't accept the price.</p>
        </div>
      )}
      {plan.conflict && (
        <div className="notice notice--bad">
          <strong>{plan.conflict}</strong>
        </div>
      )}
      <PlanSteps plan={plan} act={act} />
      {plan.status === "proposed" && <ApproveBlock plan={plan} act={act} fo={fo} />}
    </section>
  );
}

function ApproveBlock({ plan, act, fo }: { plan: PlanView; act: Act; fo: AppView["integrations"]["fo"] }) {
  // One request id per plan version: a double click resolves to the same approval on the server.
  const requestId = useMemo(() => newId(), [plan.id, plan.contentHash]);
  return (
    <div className="plan-footer">
      {plan.counts.total - plan.counts.excluded > 0 && (
        <button
          className="btn btn--primary"
          disabled={act.busy !== null}
          onClick={() => act.run(`approve-${plan.id}`, () => post(`/api/plans/${plan.id}/approve`, { contentHash: plan.contentHash, clientRequestId: requestId }))}
        >
          {act.busy === `approve-${plan.id}` ? "Approving…" : "Approve"}
        </button>
      )}
      <div className="secondary-actions">
        {fo.connection === "connected" && (
          <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run(`ask-fo-${plan.id}`, () => post(`/api/plans/${plan.id}/ask-fo`))}>
            {act.busy === `ask-fo-${plan.id}` ? "Asking…" : `Have ${fo.mode === "mock" ? "Mock Fo" : "Fo"} ask me`}
          </button>
        )}
        <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run(`discard-${plan.id}`, () => post(`/api/plans/${plan.id}/discard`))}>
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * Fo's latest text belongs next to the plan it was about: while Fo is still sending it, while
 * that plan is proposed or running, or for a while after a "done" or summary text. An older text
 * about a plan that's gone shouldn't read as being about the plan on screen now.
 */
function textIsCurrent(n: NotificationView, proposedId: string | null, runningId: string | null): boolean {
  // A text or request about a proposal shows only while that proposal is open or running.
  if (n.purpose === "find" || n.purpose === "decide") return Boolean(n.planId && (n.planId === proposedId || n.planId === runningId));
  if (n.state !== "complete") return true;
  return Date.now() - Date.parse(n.createdAt) < RECENT_MS;
}

/** Things Kiki noticed that need a person. Nothing here changes anything by itself. */
function AttentionCard({ view, act }: { view: AppView; act: Act }) {
  const [asking, setAsking] = useState<string | null>(null);
  // A file the plan on screen lists under "Stays where it is" is asked about there, not twice.
  const listed = view.plans.filter((p) => p.status === "proposed" && p.kind === "organize").flatMap((p) => p.notes.map((n) => `unplaced:${n.fileId}:`));
  const items = view.attention.filter((a) => !listed.some((k) => a.key.startsWith(k)));
  if (!items.length) return null;
  const rows = view.index.flatMap((p) => p.rows);
  return (
    <section aria-labelledby="attention-title">
      <h2 id="attention-title">Needs a look</h2>
      <ul className="item-list">
        {items.map((a) => {
          const row = a.askDocId ? rows.find((r) => r.docId === a.askDocId) : undefined;
          return (
            <li key={a.key} className="item">
              <span className="item-label">{a.title}</span>
              {a.detail && <p className="hint">{a.detail}</p>}
              {a.evidence && <p className="quote">“{a.evidence}”</p>}
              <div className="row">
                {row && asking !== a.key && (
                  <button className="btn btn--quiet btn--small" onClick={() => setAsking(a.key)}>
                    Ask {row.issuer ?? "the contractor"} if it's final
                  </button>
                )}
                {a.copy && !a.copy.asked && asking !== a.key && (
                  <button className="btn btn--quiet btn--small" onClick={() => setAsking(a.key)}>
                    Ask {a.copy.issuer ?? "them"} for a copy
                  </button>
                )}
                {a.copy?.asked && <span className="hint">Asked for a copy.</span>}
                {row && a.kind === "which_current" && (
                  <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`current-${row.docId}`, () => post(`/api/documents/${row.docId}/current`))}>
                    {row.reference ?? "The latest"} is the current one
                  </button>
                )}
                <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`dismiss-${a.key}`, () => post("/api/attention/dismiss", { key: a.key }))}>
                  Got it
                </button>
              </div>
              {row && asking === a.key && <AskContractor row={row} view={view} act={act} onDone={() => setAsking(null)} />}
              {a.copy && asking === a.key && <AskForCopy copy={a.copy} view={view} act={act} onDone={() => setAsking(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function IndexCard({ view, act }: { view: AppView; act: Act }) {
  const [asking, setAsking] = useState<string | null>(null);
  if (!view.index.length) return null;
  return (
    <>
      {view.index.map((p) => {
        const quotesFrom = (issuer: string | null) => (issuer ? p.rows.filter((r) => r.docType === "quote" && r.issuer === issuer).length : 0);
        return (
          <section key={p.name} aria-labelledby={`idx-${p.name}`}>
            <div className="card-head">
              <h2 id={`idx-${p.name}`}>{p.name} index</h2>
              {p.indexFileLink && (
                <a className="btn btn--quiet btn--small" href={p.indexFileLink} target="_blank" rel="noreferrer">
                  Open in Drive
                </a>
              )}
            </div>
            <ul className="item-list">
              {p.rows.map((r) => {
                const several = quotesFrom(r.issuer) >= 2;
                return (
                  <li key={r.docId} className="item">
                    <div className="item-head">
                      <span className="item-label">{[`${docWord(r.docType)}${r.reference ? ` ${r.reference}` : ""}`, r.issuer].filter(Boolean).join(", ")}</span>
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
                    <p className="hint">
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
      })}
    </>
  );
}

/** Messages Fo is carrying for you, and what Kiki picked up from the replies. */
function WithFo({ view, act }: { view: AppView; act: Act }) {
  const shown = view.updates.filter((u) => u.status !== "dismissed").slice(0, 4);
  const conversations = view.outreach.filter((o) => o.draft || o.dispatches.length);
  if (!shown.length && !conversations.length) return null;
  return (
    <section className="stack" aria-labelledby="with-fo">
      <h2 id="with-fo">With Fo</h2>
      {conversations.map((o) => (
        <OutreachCard key={o.documentId} o={o} view={view} act={act} />
      ))}
      {shown.map((u) => (
        <UpdateCard key={u.id} u={u} view={view} act={act} />
      ))}
    </section>
  );
}

function NotifyDecision({ view, act }: { view: AppView; act: Act }) {
  const [preview, setPreview] = useState<{ text: string; contentHash: string } | null>(null);
  const requestId = useMemo(() => newId(), [preview?.contentHash]);
  // Only a summary you asked for, while it's on its way or just sent; otherwise offer a new one.
  const latest: NotificationView | undefined = view.notifications.find((n) => n.purpose === "summary" && (n.state !== "complete" || Date.now() - Date.parse(n.createdAt) < RECENT_MS));
  const fo = view.integrations.fo;
  const foLabel = fo.mode === "mock" ? "Mock Fo" : "Fo";

  if (latest && preview === null) {
    const label =
      latest.outcome === "reported_sent"
        ? `${foLabel} reports it sent you the note.`
        : latest.outcome === "not_sent"
          ? `${foLabel} says it didn't send the note.`
          : latest.state === "needs_user_input"
            ? `${foLabel} has a question.`
            : latest.state === "failed"
              ? "The note wasn't sent."
              : latest.state === "uncertain"
                ? "Not sure the note went out."
                : latest.state === "working" && latest.pollPaused
                  ? `Kiki lost touch with ${foLabel} while it was sending your note.`
                  : latest.state === "complete"
                    ? `${foLabel} didn't say whether it sent the note.`
                    : `Waiting on ${foLabel}…`;
    return (
      <div className={`notice ${latest.outcome === "reported_sent" ? "notice--ok" : latest.state === "failed" || latest.state === "uncertain" ? "notice--bad" : "notice--info"}`}>
        <strong>{label}</strong>
        {latest.progress && latest.state === "working" && <p>{latest.progress}</p>}
        {latest.question && <p>{latest.question}</p>}
        {latest.failureDetail && <p>{latest.failureDetail}</p>}
        {latest.state === "working" && latest.pollPaused && latest.pollError && <p>{latest.pollError}</p>}
        {latest.text && <p className="hint">“{latest.text}”</p>}
        {(latest.outcome === "not_sent" || latest.state === "failed" || (latest.state === "complete" && latest.outcome === "unclear")) && (
          <button className="btn btn--small" style={{ marginTop: 8 }} disabled={act.busy !== null} onClick={() => act.run("notify-preview", async () => setPreview(await post<{ text: string; contentHash: string }>("/api/notify/preview")))}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (!preview) {
    return (
      <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("notify-preview", async () => setPreview(await post<{ text: string; contentHash: string }>("/api/notify/preview")))}>
        Text me a summary
      </button>
    );
  }
  return (
    <div className="stack">
      <p className="hint">Only you get this, from {foLabel}.</p>
      <pre className="message-preview">{preview.text}</pre>
      <div className="row">
        <button
          className="btn btn--primary"
          disabled={act.busy !== null}
          onClick={() =>
            act.run("notify-send", async () => {
              await post("/api/notify/send", { contentHash: preview.contentHash, clientRequestId: requestId });
              setPreview(null);
            })
          }
        >
          {act.busy === "notify-send" ? "Sending…" : "Send"}
        </button>
        <button className="btn btn--quiet" onClick={() => setPreview(null)}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** What a proposal Fo is bringing you here in Kiki is waiting on, in plain words. */
function decideLabel(n: NotificationView, fo: string): string {
  const r = n.reply;
  if (r?.status === "approved") return `You told ${fo} "${r.text}". Kiki is applying this version.`;
  if (r?.status === "declined") return `You told ${fo} "${r.text}". Kiki isn't applying it.`;
  if (r?.status === "adjusting") return `You asked for changes: "${r.text}". Kiki is preparing a new version…`;
  if (r?.status === "revised") return `Kiki made version ${r.revision?.version ?? ""}. ${fo} is bringing it to you.`;
  if (r?.status === "not_changed") return `Kiki didn't change the proposal. ${r.revision?.note ?? ""}`.trim();
  if (r?.status === "stale") return "This was about an earlier version of the proposal.";
  if (r?.status === "expired") return "This request expired. Ask again from the plan.";
  if (n.state === "failed") return `${fo} couldn't take the proposal.`;
  if (n.state === "uncertain") return `Not sure ${fo} got the proposal.`;
  if (n.state === "needs_user_input") return `${fo} is asking you about this proposal.`;
  if (n.state === "working" && n.pollPaused) return `Kiki lost touch with ${fo} while it was reading the proposal.`;
  if (n.state === "complete") return `${fo} hasn't asked you anything yet.`;
  return `${fo} is reading the proposal…`;
}

function FoTextStatus({ n, mock, act }: { n: NotificationView; mock: boolean; act: Act }) {
  const fo = mock ? "Mock Fo" : "Fo";
  const [answer, setAnswer] = useState("");
  const r = n.reply;
  const decide = n.purpose === "decide";
  const label = decide
    ? decideLabel(n, fo)
    : r?.status === "approved"
      ? `You replied "${r.text}". Kiki is filing it.`
      : r?.status === "declined"
        ? `You replied "${r.text}". Not filing it.`
        : r?.status === "stale"
          ? "The proposal changed since Fo asked. Review the new version."
          : n.purpose === "done" && n.outcome === "reported_sent"
            ? `${fo} texted you that it's done.`
            : r?.status === "expired"
              ? "This request expired. Ask again from the plan."
              : n.outcome === "reported_sent"
                ? `${fo} reports it texted you.`
                : n.state === "failed"
                  ? "The text wasn't sent."
                  : n.state === "uncertain"
                    ? "Not sure the text went out."
                    : n.state === "needs_user_input"
                      ? `${fo} has a question.`
                      : n.outcome === "not_sent"
                        ? `${fo} says it didn't send the text.`
                        : n.state === "working" && n.pollPaused
                          ? `Kiki lost touch with ${fo} while it was texting you.`
                          : n.state === "complete"
                            ? `${fo} didn't say whether it texted you.`
                            : `${fo} is texting you…`;
  return (
    <div className={`notice ${n.outcome === "reported_sent" || r?.status === "approved" ? "notice--ok" : n.state === "failed" || n.state === "uncertain" ? "notice--bad" : "notice--info"}`}>
      <strong>{label}</strong>
      {(n.question || n.failureDetail) && <p className="message-preview">{n.question ?? n.failureDetail}</p>}
      {n.state === "working" && n.pollPaused && n.pollError && <p>{n.pollError}</p>}
      {r?.clarification && <p>{fo} needs clarification: “{r.clarification}”</p>}
      {n.state === "working" && n.progress && <p>{n.progress}</p>}
      {/* Only when Fo actually asks you something: a texted proposal is answered by text, its link, or Approve below. */}
      {n.state === "needs_user_input" && r?.status !== "adjusting" && (r === null || r.status === "waiting") && (
        <form
          className="stack"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act.run("fo-answer", async () => {
              await post(`/api/tasks/${n.taskId}/reply`, { answer });
              setAnswer("");
            });
          }}
        >
          <label htmlFor={`ans-${n.taskId}`}>Your answer</label>
          <textarea id={`ans-${n.taskId}`} style={{ minHeight: 70 }} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={'Yes, no, or a change like "skip the Bright Floors quote"'} />
          <button className="btn btn--primary" disabled={!answer.trim() || act.busy !== null}>
            Send to {fo}
          </button>
        </form>
      )}
    </div>
  );
}

/** Kiki offered to file a kind of document on her own, and you haven't answered. */
function LessonOffer({ lesson, act }: { lesson: LessonView; act: Act }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="row">
      <span>{lesson.text}</span>
      <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run(`alone-${lesson.id}`, () => post(`/api/lessons/${lesson.id}/alone`, { on: true }))}>
        Yes, on her own
      </button>
      <button className="btn btn--quiet btn--small" onClick={() => setHidden(true)}>
        Not now
      </button>
    </div>
  );
}

/** The strip's one action: what you can do about the state Kiki is in. No hooks of its own. */
function Decisions({ view, act }: { view: AppView; act: Act }) {
  const proposed = view.plans.find((p) => p.status === "proposed");
  const running = view.plans.find((p) => p.status === "approved" || p.status === "executing");
  const applied = view.plans.find((p) => p.status === "applied" || p.status === "partial");
  const broken = view.plans.find((p) => p.status === "failed" || p.status === "partial" || p.status === "stale");
  const readingDone = view.workspace && view.inventory.files.length > 0 && view.inventory.reading === 0 && !view.busy.reading;
  const text = view.notifications[0];
  const offer = view.lessons.find((l) => l.offered && !l.auto);
  const counted = (p: PlanView) => `${p.counts.verified} of ${p.counts.total - p.counts.excluded} changes applied and verified in Drive.`;
  const undo = (p: PlanView) =>
    p.canUndo && (
      <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`undo-${p.id}`, () => post(`/api/plans/${p.id}/undo`))}>
        Undo…
      </button>
    );

  let action: React.ReactNode = null;
  if (text && text.purpose !== "summary" && textIsCurrent(text, proposed?.id ?? null, running?.id ?? null)) {
    action = <FoTextStatus n={text} mock={view.integrations.fo.mode === "mock"} act={act} />;
  } else if (broken && !proposed && !running) {
    const error = broken.ops.find((o) => o.error)?.error;
    action = (
      <>
        {broken.status === "partial" && <p>Only {counted(broken)}</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button
            className="btn btn--small"
            disabled={act.busy !== null}
            onClick={() => act.run("retry", () => post(broken.status === "stale" ? `/api/plans/${broken.id}/refresh` : `/api/plans/${broken.id}/resume`))}
          >
            {broken.status === "stale" ? "Refresh the plan" : "Try again"}
          </button>
        </div>
      </>
    );
  } else if (running) {
    action = (
      <div className="progress">
        <span className="dot" aria-hidden="true" />
        <span>
          Applying {running.counts.verified} of {running.counts.total - running.counts.excluded}…
        </span>
      </div>
    );
  } else if (applied && !proposed && applied.finishedAt && Date.now() - Date.parse(applied.finishedAt) < RECENT_MS) {
    action = (
      <>
        <p>{applied.status === "partial" ? `Only ${counted(applied)}` : counted(applied)}</p>
        <div className="row">
          <NotifyDecision view={view} act={act} />
          {undo(applied)}
        </div>
      </>
    );
  } else if (view.workspace && !proposed) {
    action = (
      <div className="row">
        <button className="btn btn--small" disabled={!readingDone || act.busy !== null} onClick={() => act.run("propose", () => post("/api/plans/organize"))}>
          {applied ? "Check for anything new" : "Propose a plan"}
        </button>
      </div>
    );
  }
  return (
    <>
      {act.error && (
        <p className="error-text" role="alert">
          {act.error}
        </p>
      )}
      {action}
      {offer && <LessonOffer key={offer.id} lesson={offer} act={act} />}
    </>
  );
}

/** Kiki, the state she's in, the folder, and the one thing to do next. The page's only live region. */
function Strip({ view, act }: { view: AppView; act: Act }) {
  const ws = view.workspace;
  return (
    <section className="strip" aria-live="polite">
      <Kiki state={view.kiki.state} size={72} />
      <div>
        <p className="kiki-status">{view.kiki.label}</p>
        {view.kiki.state === "error" && view.kiki.detail && <p className="hint">{view.kiki.detail}</p>}
        {ws && (
          <div className="row hint">
            <span>
              {ws.name}, {ws.lastInventoryAt ? `checked ${time(ws.lastInventoryAt)}` : "looking…"}
            </span>
            {ws.link && (
              <a className="btn btn--quiet btn--small" href={ws.link} target="_blank" rel="noreferrer">
                Open in Drive
              </a>
            )}
            <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run("refresh", () => post("/api/workspace/refresh"))}>
              Look again
            </button>
          </div>
        )}
        <Decisions view={view} act={act} />
      </div>
    </section>
  );
}

/** A finished plan: one line, with its steps a click away. */
function HistoryRow({ plan, act }: { plan: PlanView; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="item">
      <div className="item-head">
        <span className="item-label">
          {plan.title}
          {plan.finishedAt ? `, ${time(plan.finishedAt)}` : ""}
        </span>
        <span className={planChip(plan.status)}>{PLAN_STATUS[plan.status]}</span>
      </div>
      <div className="row">
        <span className="hint">
          {plan.counts.verified} of {plan.counts.total - plan.counts.excluded}
        </span>
        <button className="btn btn--quiet btn--small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide steps" : "Show steps"}
        </button>
        {plan.canUndo && (
          <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`undo-${plan.id}`, () => post(`/api/plans/${plan.id}/undo`))}>
            Undo…
          </button>
        )}
      </div>
      {open && <PlanSteps plan={plan} act={null} />}
    </li>
  );
}

function History({ view, act }: { view: AppView; act: Act }) {
  const finished = view.plans.filter((p) => p.status === "applied" || p.status === "partial").sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  return (
    <section>
      <details>
        <summary>History</summary>
        {finished.length > 0 && (
          <ul className="item-list">
            {finished.map((p) => (
              <HistoryRow key={p.id} plan={p} act={act} />
            ))}
          </ul>
        )}
        <ul className="timeline">
          {view.activity.events.map((e, i) => (
            <li key={i}>
              <time>{time(e.at)}</time>
              {e.message}
            </li>
          ))}
        </ul>
        {view.activity.turns.length > 0 && (
          <>
            <h3>Messages with Fo</h3>
            {view.activity.turns.map((t, i) => (
              <div className="turn" key={i}>
                <strong>{t.direction === "to_fo" ? "To Fo" : t.direction === "from_fo" ? "From Fo" : "Problem"}</strong> <span className="hint">{time(t.at)}</span>
                {t.text && <pre>{t.text}</pre>}
              </div>
            ))}
          </>
        )}
      </details>
    </section>
  );
}

function Settings({ view, act }: { view: AppView; act: Act }) {
  const { drive } = view.integrations;
  const ws = view.workspace;
  const liveDrive = drive.mode === "live" && drive.connection === "connected";
  return (
    <section>
      <details>
        <summary>Settings</summary>
        <ul className="item-list">
          {ws && (
            <li className="item">
              <label className="check">
                <input type="checkbox" checked={Boolean(view.settings.autoText)} disabled={act.busy !== null} onChange={(e) => act.run("auto-text", () => post("/api/settings", { autoText: e.target.checked }))} />
                <span>Text me when Kiki finds something new</span>
              </label>
            </li>
          )}
          <li className="item">
            <ExtensionPairing paired={view.extension?.paired} pairedAt={view.extension?.pairedAt ?? null} />
          </li>
          {liveDrive && drive.account && <li className="item">Google account: {drive.account}</li>}
          {liveDrive && (drive.gmail === "connected" || drive.gmail === "not_connected") && (
            <li className="item">
              {drive.gmail === "connected" ? (
                <Badge kind="live">Gmail: read-only</Badge>
              ) : (
                <button className="btn btn--small" title="Kiki only searches for attachments from a contractor she asked. She never sends, changes or deletes mail." disabled={act.busy !== null} onClick={() => connectGoogle(act, true)}>
                  Let Kiki look in Gmail (read-only)
                </button>
              )}
            </li>
          )}
          {ws && (
            <li className="item">
              <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("clear", () => post("/api/workspace/clear"))}>
                Change folder
              </button>
            </li>
          )}
          {ws?.mode === "mock" && (
            <li className="item">
              <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("stage-invoice", () => post("/api/workspace/stage-revision", { variant: "invoice" }))}>
                Add a staged demo invoice
              </button>
            </li>
          )}
          {view.lessons.length > 0 && (
            <li className="item">
              <h3>What Kiki learned</h3>
              <ul className="learned">
                {view.lessons.map((l) => (
                  <li key={l.id}>
                    <span>
                      {l.text} {l.auto && <Badge kind="plain">Files on her own</Badge>}
                    </span>
                    <span className="learned-actions">
                      {l.kind === "place" && (
                        <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run(`alone-${l.id}`, () => post(`/api/lessons/${l.id}/alone`, { on: !l.auto }))}>
                          {l.auto ? "Ask me first" : l.offered ? "Yes, on her own" : "File on her own"}
                        </button>
                      )}
                      <button className="btn btn--small btn--quiet" disabled={act.busy !== null} onClick={() => act.run(`forget-${l.id}`, () => post(`/api/lessons/${l.id}/forget`))}>
                        Forget
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          )}
          {view.signedIn && (
            <li className="item">
              <button className="btn btn--small btn--quiet" onClick={() => void post("/api/logout").finally(() => window.location.assign("/login"))}>
                Sign out
              </button>
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}

export function App() {
  const [view, setView] = useState<AppView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setView(await getState());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const act = useAction(refresh);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Only Kiki's own words: the link's text names which connection, and nothing else is shown.
    const known = (s: string | null) => (s === "Google Drive" || s === "Fo" ? s : null);
    const msg = known(params.get("connected")) ? `Connected ${params.get("connected")}.` : known(params.get("connectError")) ? `Couldn't connect ${params.get("connectError")}. Try again.` : null;
    if (msg) {
      setFlash(msg);
      window.history.replaceState(null, "", "/");
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!view) return <div className="page">{loadError ? <p className="error-text">Can't reach the Kiki server: {loadError}</p> : <p>Loading…</p>}</div>;
  const livePlans = view.plans.filter((p) => p.status !== "superseded" && p.status !== "discarded");
  const active = (p: PlanView) => p.status === "proposed" || p.status === "approved" || p.status === "executing";
  // Plans still open, then the latest finished one if it stopped part-way; applied plans live in History.
  const shownPlans = [...livePlans.filter(active), ...livePlans.filter((p) => !active(p)).slice(0, 1)].filter((p) => p.status !== "applied");

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <Kiki state={view.kiki.state} size={28} />
          <h1>Kiki</h1>
        </div>
        <Integrations view={view} act={act} />
      </header>
      {view.integrations.drive.missingScopes.length > 0 && (
        <div className="notice notice--warn toast" role="alert">
          <strong>Google didn't grant every permission. Connect again and tick every box.</strong>
          <button className="btn btn--small" onClick={() => connectGoogle(act)}>
            Connect Google Drive again
          </button>
        </div>
      )}
      {flash && (
        <div className="notice notice--info toast" role="status">
          {flash}
        </div>
      )}
      <main className="main">
        <Strip view={view} act={act} />
        {!view.workspace && <WorkspaceSetup view={view} act={act} />}
        {view.workspace && (
          <>
            {shownPlans.map((p) => (
              <PlanCard key={p.id} plan={p} act={act} fo={view.integrations.fo} />
            ))}
            <WithFo view={view} act={act} />
            <AttentionCard view={view} act={act} />
            <IndexCard view={view} act={act} />
            <InventoryCard view={view} />
            <History view={view} act={act} />
          </>
        )}
        <Settings view={view} act={act} />
      </main>
    </div>
  );
}
