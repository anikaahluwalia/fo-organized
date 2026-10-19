import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppView, LessonView, NoteView, NotificationView, OpView, PlanView } from "../../shared/api.ts";
import { ago, getState, newId, post, time } from "./api.ts";
import { Kiki } from "./Kiki.tsx";
import { AskContractor, AskForCopy, OutreachCard, UpdateCard } from "./Contractor.tsx";
import { Browse, collections, folderLabel } from "./Browse.tsx";
import { Settings } from "./Settings.tsx";
import { applyTheme, Badge, connectFo, connectGoogle, Icon, initialTheme, joinPath, useAction, type Act, type IconName, type Theme } from "./ui.tsx";

/** A step's state, shown only once it isn't waiting for approval (the plan's badge says that). */
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

/** The plan page's badge: the same states, said to the person deciding. */
const PLAN_BADGE: Record<string, string> = { ...PLAN_STATUS, proposed: "Awaiting your approval", applied: "Applied and verified in Drive" };

/** How long a finished plan, or a text about it, stays the news. */
const RECENT_MS = 30 * 60_000;

const foName = (view: AppView) => (view.integrations.fo.mode === "mock" ? "Mock Fo" : "Fo");
const toRun = (p: PlanView) => p.counts.total - p.counts.excluded;

/** No folder yet: the demo folder, or one you paste. */
function WorkspaceSetup({ view, act }: { view: AppView; act: Act }) {
  const [folder, setFolder] = useState("");
  const driveReady = view.integrations.drive.mode === "mock" || view.integrations.drive.connection === "connected";
  return (
    <section className="card setup" aria-label="Choose a folder">
      {view.integrations.drive.connection === "not_configured" && (
        <div className="notice notice--warn">
          <strong>Google Drive isn't set up yet.</strong>
          <p>{view.integrations.drive.message}</p>
        </div>
      )}
      <div className="stack">
        <div className="row">
          <button className="btn btn--primary" disabled={!driveReady || act.busy !== null} onClick={() => act.run("select", () => post("/api/workspace/select", { folder: "root" }))}>
            Watch my whole Drive
          </button>
        </div>
        <p className="hint">Kiki organizes loose files and leaves what's in your own folders where it is.</p>
      </div>
      <div className="row">
        <button className="btn" disabled={!driveReady || act.busy !== null} onClick={() => act.run("demo", () => post("/api/workspace/demo"))}>
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
        <label htmlFor="folder">Or just one folder: paste its link</label>
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

// The plan, one change per row -------------------------------------------------------------------

interface Change {
  key: string;
  icon: IconName;
  title: string;
  lines: string[];
  op: OpView | null;
  note: NoteView | null;
}

const inDuplicates = (path: string) => path.split("/").includes("Duplicates");

/**
 * A plan's changes in plain words, one row each. New folders are folded into the moves that use
 * them; one shows on its own only when nothing moves into it or its step went wrong.
 */
function changesOf(plan: PlanView, view: AppView | null): { rows: Change[]; staying: { key: string; name: string; why: string }[] } {
  const files = view?.inventory.files ?? [];
  const docOf = (place: { name: string; path: string } | null) => (place ? files.find((f) => f.name === place.name && f.path === place.path)?.doc : undefined);
  const folders = plan.ops.filter((o) => o.kind === "create_folder" && o.after && o.state !== "excluded");
  const newFolders = new Set(folders.map((o) => joinPath(o.after!.path, o.after!.name)));
  const rows: Change[] = [];
  const staying: { key: string; name: string; why: string }[] = [];
  for (const op of plan.ops) {
    if (op.kind === "create_folder") continue;
    if (op.state === "excluded") {
      staying.push({ key: `op-${op.seq}`, name: op.before?.name ?? op.after?.name ?? "", why: "Left out of this plan." });
      continue;
    }
    const { before, after } = op;
    if (op.kind === "move_rename" && before && after) {
      const doc = docOf(before) ?? docOf(after);
      const amount = doc?.readStatus === "read" ? doc.total.value : null;
      const into = `into ${after.path ? folderLabel(after.path, "") : "the main folder"}${newFolders.has(after.path) ? ", a new folder" : ""}`;
      if (inDuplicates(after.path)) {
        rows.push({ key: `op-${op.seq}`, icon: "copy", title: "Set aside a copy", lines: [[before.name, amount].filter(Boolean).join(" · "), into], op, note: null });
        continue;
      }
      const moved = before.path !== after.path;
      const renamed = before.name !== after.name;
      const what = doc?.readStatus === "read" && doc.docType !== "other" && doc.docType !== "unknown" ? `the ${doc.docType}` : "a file";
      rows.push({
        key: `op-${op.seq}`,
        icon: "fileMove",
        title: `${moved && renamed ? "Move and rename" : moved ? "Move" : "Rename"} ${what}`,
        lines: [[renamed ? `${before.name} → ${after.name}` : after.name, amount].filter(Boolean).join(" · "), ...(moved ? [before.path ? `from ${folderLabel(before.path, "")} ${into}` : into] : [])],
        op,
        note: null,
      });
    } else if (op.kind === "write_index" && after) {
      rows.push({ key: `op-${op.seq}`, icon: "listCheck", title: op.title.startsWith("Create") ? "Create the project index" : "Update the project index", lines: [after.name, `in ${folderLabel(after.path, "the main folder")}`], op, note: null });
    } else if (op.kind === "set_status") {
      rows.push({ key: `op-${op.seq}`, icon: "history", title: op.title, lines: [op.reason], op, note: null });
    } else {
      rows.push({ key: `op-${op.seq}`, icon: "file", title: op.title, lines: [], op, note: null });
    }
  }
  // A new folder nothing moves into (or whose step went wrong) is a change of its own.
  for (const op of folders) {
    const path = joinPath(op.after!.path, op.after!.name);
    const used = rows.some((r) => r.op?.after && (r.op.after.path === path || r.op.after.path.startsWith(`${path}/`)));
    if (!used || op.error || (op.state !== "pending" && op.state !== "verified")) rows.push({ key: `op-${op.seq}`, icon: "folderPlus", title: "Make a new folder", lines: [folderLabel(path, "")], op, note: null });
  }
  rows.sort((a, b) => Number(b.op?.state === "failed") - Number(a.op?.state === "failed"));
  for (const n of plan.notes) {
    if (n.unplaced && plan.status === "proposed") rows.push({ key: `note-${n.fileId}`, icon: "folderQuestion", title: "Needs a folder", lines: [n.name, n.reason], op: null, note: n });
    else staying.push({ key: `note-${n.fileId}`, name: n.name, why: n.reason });
  }
  return { rows, staying };
}

function OpState({ op }: { op: OpView }) {
  const label = OP_STATE[op.state];
  if (!label) return null;
  return <span className={`chip ${op.state === "verified" ? "chip--confirmed" : "chip--needs_review"}`}>{label}</span>;
}

/** Rename a step's file, or leave it out of the plan (a new version either way). */
function OpEditor({ planId, op, act, onClose, onRevised }: { planId: string; op: OpView; act: Act; onClose: () => void; onRevised?: (planId: string) => void }) {
  const [value, setValue] = useState(op.after?.name ?? "");
  const revise = (key: string, edit: Record<string, unknown>) =>
    act.run(key, async () => {
      const r = await post<{ planId?: string }>(`/api/plans/${planId}/revise`, { edits: [{ seq: op.seq, ...edit }] });
      onClose();
      if (r.planId) onRevised?.(r.planId);
    });
  return (
    <form
      className="stack editor"
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

/** For a file Kiki couldn't place: say where it goes, and Kiki adds it to the plan (a new version). */
function PlaceEditor({ planId, fileId, options, act, onRevised }: { planId: string; fileId: string; options: string[]; act: Act; onRevised?: (planId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) {
    return (
      <button className="btn btn--small" onClick={() => setOpen(true)}>
        Choose a folder
      </button>
    );
  }
  return (
    <form
      className="stack editor"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(`place-${fileId}`, async () => {
          const r = await post<{ planId?: string }>(`/api/plans/${planId}/place`, { fileId, place: value });
          setOpen(false);
          if (r.planId) onRevised?.(r.planId);
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

function ChangeRow({ plan, c, act, onRevised }: { plan: PlanView; c: Change; act: Act | null; onRevised?: (planId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const op = c.op;
  const placeable = act && c.note && plan.status === "proposed" && plan.kind === "organize";
  return (
    <li className="change">
      <span className="change__icon">
        <Icon name={c.icon} size={22} />
      </span>
      <div className="change__body">
        <div className="change__head">
          <span className="change__title">{c.title}</span>
          <span className="row">
            {op && <OpState op={op} />}
            {act && op?.editable && op.state === "pending" && !editing && (
              <button className="btn btn--quiet btn--small" onClick={() => setEditing(true)}>
                Edit<span className="visually-hidden"> {op.before?.name}</span>
              </button>
            )}
          </span>
        </div>
        {c.lines.map((l, i) => (
          <p key={i} className="change__line">
            {l}
          </p>
        ))}
        {op?.error && <p className="error-text">{op.error}</p>}
        {act && op && editing && <OpEditor planId={plan.id} op={op} act={act} onClose={() => setEditing(false)} onRevised={onRevised} />}
        {placeable && act && c.note && <PlaceEditor planId={plan.id} fileId={c.note.fileId} options={c.note.options} act={act} onRevised={onRevised} />}
      </div>
    </li>
  );
}

/** Every change, then what stays where it is. Read-only without `act`. */
function ChangeList({ plan, act, view, onRevised }: { plan: PlanView; act: Act | null; view?: AppView; onRevised?: (planId: string) => void }) {
  const { rows, staying } = changesOf(plan, view ?? null);
  return (
    <>
      {rows.length > 0 && (
        <ul className="changes">
          {rows.map((c) => (
            <ChangeRow key={c.key} plan={plan} c={c} act={act} onRevised={onRevised} />
          ))}
        </ul>
      )}
      {staying.length > 0 && (
        <div className="staying">
          <h3>Stays where it is</h3>
          <ul className="rows">
            {staying.map((s) => (
              <li key={s.key}>
                <span className="strong">{s.name}</span>
                {s.why && <span className="muted small"> {s.why}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ApproveBlock({ plan, act, view, onCorrect }: { plan: PlanView; act: Act; view: AppView; onCorrect: () => void }) {
  // One request id per plan version: a double click resolves to the same approval on the server.
  const requestId = useMemo(() => newId(), [plan.id, plan.contentHash]);
  const fo = view.integrations.fo;
  // The changes as listed above (a new folder is part of the move into it); nothing to approve without one.
  const n = toRun(plan) > 0 ? changesOf(plan, view).rows.filter((r) => r.op).length : 0;
  const texted = view.notifications.some((x) => x.planId === plan.id && (x.purpose === "find" || x.purpose === "decide") && x.reply?.status === "waiting");
  return (
    <div className="decide">
      <div className="decide__main">
        {n > 0 && (
          <button
            className="btn btn--primary btn--large"
            disabled={act.busy !== null}
            onClick={() => act.run(`approve-${plan.id}`, () => post(`/api/plans/${plan.id}/approve`, { contentHash: plan.contentHash, clientRequestId: requestId }))}
          >
            {act.busy === `approve-${plan.id}` ? "Approving…" : `Approve ${n} change${n === 1 ? "" : "s"}`}
          </button>
        )}
        <button className="btn btn--large" onClick={onCorrect}>
          Request a change
        </button>
      </div>
      <div className="row">
        {fo.connection === "connected" && (
          <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run(`ask-fo-${plan.id}`, () => post(`/api/plans/${plan.id}/ask-fo`))}>
            {act.busy === `ask-fo-${plan.id}` ? "Asking…" : `Have ${fo.mode === "mock" ? "Mock Fo" : "Fo"} ask me`}
          </button>
        )}
        <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run(`discard-${plan.id}`, () => post(`/api/plans/${plan.id}/discard`))}>
          Not now
        </button>
      </div>
      <p className="footnote">Nothing changes until you approve.{texted ? ` ${foName(view)} will text you the result.` : ""}</p>
    </div>
  );
}

/** Where a plan's files end up, for its breadcrumb: the folder its moves share, or what kind of plan it is. */
function planPlace(plan: PlanView): string {
  const paths = plan.ops.filter((o) => o.kind === "move_rename" && o.state !== "excluded" && o.after).map((o) => o.after!.path.split("/"));
  const shared: string[] = [];
  for (let i = 0; paths.length && paths.every((p) => p[i] !== undefined && p[i] === paths[0]![i]); i++) shared.push(paths[0]![i]!);
  if (shared.length && shared[0]) return shared.join(" / ");
  return plan.kind === "undo" ? "Undo" : plan.kind === "version_update" ? "Quote update" : "Plan";
}

/** Fo's request about this plan that you can still answer, if there is one. */
function openRequest(view: AppView, plan: PlanView): NotificationView | undefined {
  return view.notifications.find((n) => n.planId === plan.id && (n.purpose === "find" || n.purpose === "decide") && n.reply?.status === "waiting");
}

const foBusy = (n: NotificationView) => n.state === "pending" || n.state === "asking" || n.state === "working";

function Crumbs({ items, onHome, home }: { items: string[]; onHome: () => void; home: string }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button className="crumbs__home" onClick={onHome}>
        {home}
      </button>
      {items.map((i, n) => (
        <span key={n} aria-current={n === items.length - 1 ? "page" : undefined}>
          {" / "}
          {i}
        </span>
      ))}
    </nav>
  );
}

/** A plan up close: exactly what Kiki will change (or changed), and the decision. */
function PlanDetail({ plan, view, act, onBack, onCorrect, onOpen }: { plan: PlanView; view: AppView; act: Act; onBack: () => void; onCorrect: () => void; onOpen: (id: string) => void }) {
  const text = view.notifications.find((n) => n.planId === plan.id && n.purpose !== "summary");
  const showText = text && textIsCurrent(text, plan.status === "proposed" ? plan.id : null, plan.status === "approved" || plan.status === "executing" ? plan.id : null);
  const lede: Record<string, string> = {
    proposed: "Review exactly what Kiki will change.",
    approved: "Kiki is applying these changes and checking each one in Drive.",
    executing: "Kiki is applying these changes and checking each one in Drive.",
    applied: "Kiki made these changes and checked each one in Drive.",
    partial: "Some of these changes didn't finish. The rest are checked in Drive.",
    stale: "Files changed since Kiki made this plan, so she stopped.",
    failed: "These changes didn't finish.",
    superseded: "A newer version of this plan replaced it.",
    discarded: "You set this plan aside. Nothing changed.",
  };
  const broken = plan.status === "failed" || plan.status === "partial" || plan.status === "stale";
  return (
    <article className="detail" aria-labelledby="plan-title">
      <Crumbs home={view.workspace?.name ?? "Workspace"} onHome={onBack} items={[planPlace(plan)]} />
      <div className="row">
        <span className="pill">{PLAN_BADGE[plan.status]}</span>
        {plan.version > 1 && <span className="muted small">Version {plan.version}</span>}
      </div>
      <h1 id="plan-title" className="display">
        {plan.title}
      </h1>
      <p className="lede">{lede[plan.status]}</p>
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
      {showText && <FoTextStatus n={text} mock={view.integrations.fo.mode === "mock"} act={act} />}
      <ChangeList plan={plan} act={act} view={view} onRevised={onOpen} />
      {plan.status === "proposed" && <ApproveBlock plan={plan} act={act} view={view} onCorrect={onCorrect} />}
      {(plan.status === "approved" || plan.status === "executing") && runningBody(plan)}
      {broken && brokenBody(plan, act)}
      {plan.canUndo && (
        <div className="row">
          <button className="btn" disabled={act.busy !== null} onClick={() => act.run(`undo-${plan.id}`, async () => onOpen((await post<{ planId: string }>(`/api/plans/${plan.id}/undo`)).planId))}>
            Undo…
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * A correction in your own words goes to Fo on the request it opened about this plan, like an
 * answer in the text conversation: Kiki makes a new version for you to review. Without such a
 * request, the per-file tools change the plan directly, and Fo can be asked to open one.
 */
function Correction({ plan, view, act, onBack, onDone, onOpen }: { plan: PlanView; view: AppView; act: Act; onBack: () => void; onDone: () => void; onOpen: (id: string) => void }) {
  const [text, setText] = useState("");
  const request = openRequest(view, plan);
  const fo = foName(view);
  const busy = request ? foBusy(request) : false;
  return (
    <article className="detail" aria-labelledby="fix-title">
      <Crumbs home={view.workspace?.name ?? "Workspace"} onHome={onBack} items={[planPlace(plan), "Correction"]} />
      <div className="row">
        <span className="pill">Nothing changed yet</span>
      </div>
      <h1 id="fix-title" className="display">
        A small correction?
      </h1>
      {request ? (
        <>
          <p className="lede">Tell Kiki what to adjust. You'll review the new plan before it runs.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run("correct", async () => {
                await post(`/api/tasks/${request.taskId}/reply`, { answer: text });
                setText("");
                onDone();
              });
            }}
          >
            <label htmlFor="correction" className="label-lg">
              Your correction
            </label>
            <textarea id="correction" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} placeholder="Put the licence in Business, and skip the second quote." />
            {busy && <p className="muted small">{fo} is still reading the proposal. You can send a correction once it's done.</p>}
            <div>
              <button className="btn btn--primary btn--large" disabled={!text.trim() || busy || act.busy !== null}>
                {act.busy === "correct" ? "Sending…" : "Send correction"}
              </button>
            </div>
            <p className="footnote">{fo} stays informed. Sending a correction doesn't approve any file changes.</p>
          </form>
        </>
      ) : (
        <>
          <p className="lede">Rename a file, leave one out, or choose a folder below. You'll review the new version before anything runs.</p>
          <ChangeList plan={plan} act={act} view={view} onRevised={onOpen} />
          {view.integrations.fo.connection === "connected" && (
            <div className="stack">
              <p className="muted">To describe a change in your own words, have {fo} ask you about this plan. Your correction goes back through {fo}.</p>
              <div>
                <button className="btn" disabled={act.busy !== null} onClick={() => act.run(`ask-fo-${plan.id}`, () => post(`/api/plans/${plan.id}/ask-fo`))}>
                  {act.busy === `ask-fo-${plan.id}` ? "Asking…" : `Have ${fo} ask me`}
                </button>
              </div>
            </div>
          )}
          <p className="footnote">Changing the plan doesn't approve any file changes.</p>
        </>
      )}
    </article>
  );
}

// What Kiki is doing now -------------------------------------------------------------------------

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

/** Whether a text needs you (Fo asked, or it went wrong) rather than just being on its way. */
function textNeedsYou(n: NotificationView): boolean {
  return (
    n.state === "needs_user_input" ||
    n.state === "failed" ||
    n.state === "uncertain" ||
    n.pollPaused ||
    n.outcome === "not_sent" ||
    n.reply?.status === "not_changed" ||
    n.reply?.status === "stale" ||
    n.reply?.status === "expired"
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
          <div className="row">
            <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("notify-preview", async () => setPreview(await post<{ text: string; contentHash: string }>("/api/notify/preview")))}>
              Try again
            </button>
          </div>
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
    <div className="stack grow">
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
      {/* Only when Fo actually asks you something: a texted proposal is answered by text, its link, or Approve. */}
      {n.state === "needs_user_input" && r?.status !== "adjusting" && (r === null || r.status === "waiting") && (
        <form
          className="stack answer"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run("fo-answer", async () => {
              await post(`/api/tasks/${n.taskId}/reply`, { answer });
              setAnswer("");
            });
          }}
        >
          <label htmlFor={`ans-${n.taskId}`}>Your answer</label>
          <textarea id={`ans-${n.taskId}`} className="short" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={'Yes, no, or a change like "skip the Bright Floors quote"'} />
          <div>
            <button className="btn btn--primary" disabled={!answer.trim() || act.busy !== null}>
              Send to {fo}
            </button>
          </div>
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
    <div className="lesson">
      <p>{lesson.text}</p>
      <div className="row">
        <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run(`alone-${lesson.id}`, () => post(`/api/lessons/${lesson.id}/alone`, { on: true }))}>
          Yes, on her own
        </button>
        <button className="btn btn--quiet btn--small" onClick={() => setHidden(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}

type Now =
  | { kind: "text"; n: NotificationView }
  | { kind: "broken"; plan: PlanView }
  | { kind: "running"; plan: PlanView }
  | { kind: "applied"; plan: PlanView }
  | { kind: "propose"; again: boolean; ready: boolean }
  | null;

/** The one thing happening now that you can act on, in priority order. */
function nowFor(view: AppView): Now {
  const proposed = view.plans.find((p) => p.status === "proposed");
  const running = view.plans.find((p) => p.status === "approved" || p.status === "executing");
  const applied = view.plans.find((p) => p.status === "applied" || p.status === "partial");
  const broken = view.plans.find((p) => p.status === "failed" || p.status === "partial" || p.status === "stale");
  const readingDone = Boolean(view.workspace && view.inventory.files.length > 0 && view.inventory.reading === 0 && !view.busy.reading);
  const text = view.notifications[0];
  if (text && text.purpose !== "summary" && textIsCurrent(text, proposed?.id ?? null, running?.id ?? null)) return { kind: "text", n: text };
  if (broken && !proposed && !running) return { kind: "broken", plan: broken };
  if (running) return { kind: "running", plan: running };
  if (applied && !proposed && applied.finishedAt && Date.now() - Date.parse(applied.finishedAt) < RECENT_MS) return { kind: "applied", plan: applied };
  if (view.workspace && !proposed) return { kind: "propose", again: Boolean(applied), ready: readingDone };
  return null;
}

const counted = (p: PlanView) => `${p.counts.verified} of ${toRun(p)} changes applied and verified in Drive.`;

/** A plan that stopped: what went wrong, and the way on. Plain JSX (no hooks), so it can sit in Decisions. */
function brokenBody(plan: PlanView, act: Act) {
  const error = plan.ops.find((o) => o.error)?.error;
  return (
    <div className="notice notice--bad">
      <strong>{plan.status === "stale" ? "Files changed since the plan was made." : plan.status === "partial" ? `Only ${counted(plan)}` : "Some changes didn't finish."}</strong>
      {error && <p>{error}</p>}
      <div className="row">
        <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("retry", () => post(plan.status === "stale" ? `/api/plans/${plan.id}/refresh` : `/api/plans/${plan.id}/resume`))}>
          {plan.status === "stale" ? "Refresh the plan" : "Try again"}
        </button>
      </div>
    </div>
  );
}

function runningBody(plan: PlanView) {
  return (
    <div className="progress">
      <span className="dot" aria-hidden="true" />
      <span>
        Applying {plan.counts.verified} of {toRun(plan)}…
      </span>
    </div>
  );
}

function undoButton(p: PlanView, act: Act) {
  return (
    p.canUndo && (
      <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`undo-${p.id}`, () => post(`/api/plans/${p.id}/undo`))}>
        Undo…
      </button>
    )
  );
}

function appliedActions(plan: PlanView, view: AppView, act: Act) {
  return (
    <div className="row">
      <NotifyDecision view={view} act={act} />
      {undoButton(plan, act)}
    </div>
  );
}

function appliedBody(plan: PlanView, view: AppView, act: Act) {
  return (
    <>
      <p>{plan.status === "partial" ? `Only ${counted(plan)}` : counted(plan)}</p>
      {appliedActions(plan, view, act)}
    </>
  );
}

function proposeBody(now: { again: boolean; ready: boolean }, act: Act) {
  return (
    <div className="row">
      <button className="btn btn--small" disabled={!now.ready || act.busy !== null} onClick={() => act.run("propose", () => post("/api/plans/organize"))}>
        {now.again ? "Check for anything new" : "Propose a plan"}
      </button>
    </div>
  );
}

function nowBody(now: Now, view: AppView, act: Act): React.ReactNode {
  if (!now) return null;
  if (now.kind === "text") return <FoTextStatus n={now.n} mock={view.integrations.fo.mode === "mock"} act={act} />;
  if (now.kind === "broken") return brokenBody(now.plan, act);
  if (now.kind === "running") return runningBody(now.plan);
  if (now.kind === "applied") return appliedBody(now.plan, view, act);
  return proposeBody(now, act);
}

/**
 * Everything Kiki is doing now that you can act on, together: the error from your last action,
 * the one current thing, and an offer Kiki made. The Activity view places these same pieces in
 * its tabs. No hooks of its own.
 */
function Decisions({ view, act }: { view: AppView; act: Act }) {
  const offer = view.lessons.find((l) => l.offered && !l.auto);
  return (
    <>
      {act.error && (
        <p className="error-text" role="alert">
          {act.error}
        </p>
      )}
      {nowBody(nowFor(view), view, act)}
      {offer && <LessonOffer key={offer.id} lesson={offer} act={act} />}
    </>
  );
}

// Activity ---------------------------------------------------------------------------------------

function Card({ icon, type, at, children, foot }: { icon: IconName; type: string; at?: string | null; children: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <article className="card">
      <p className="card__meta">
        <Icon name={icon} />
        <span>
          {type}
          {at ? ` · ${ago(at)}` : ""}
        </span>
      </p>
      <div className="card__body">{children}</div>
      {foot && <div className="card__foot">{foot}</div>}
    </article>
  );
}

function FoAvatar() {
  return (
    <span className="mini-avatar" aria-hidden="true">
      fo
    </span>
  );
}

function PlanSummaryCard({ plan, view, onOpen }: { plan: PlanView; view: AppView; onOpen: (id: string) => void }) {
  const fo = foName(view);
  const text = view.notifications.find((n) => n.planId === plan.id && (n.purpose === "find" || n.purpose === "decide"));
  const type = plan.kind === "undo" ? "Undo" : plan.kind === "version_update" ? "Quote update" : plan.version > 1 ? "Revised plan" : "Proposed plan";
  const with_ = text
    ? text.purpose === "decide"
      ? `${fo} is bringing it to you`
      : text.outcome === "reported_sent"
        ? `${fo} texted you about it`
        : `${fo} is texting you about it`
    : "Waiting for your approval";
  return (
    <Card
      icon={plan.kind === "undo" ? "undo" : "file"}
      type={type}
      at={plan.createdAt}
      foot={
        <>
          <span className="with">
            {text ? (
              <FoAvatar />
            ) : (
              <span className="mini-avatar mini-avatar--kiki" aria-hidden="true">
                <Kiki state="needs_approval" size={20} />
              </span>
            )}
            {with_}
          </span>
          <button className="link-btn" onClick={() => onOpen(plan.id)}>
            View details<span className="visually-hidden">: {plan.title}</span> <Icon name="chevronDown" size={18} />
          </button>
        </>
      }
    >
      <h3 className="card__title">{plan.title}</h3>
      <p className="card__text">{plan.summary}</p>
    </Card>
  );
}

/** Things Kiki noticed that need a person. Nothing here changes anything by itself. */
function NeedsALook({ view, act }: { view: AppView; act: Act }) {
  const [asking, setAsking] = useState<string | null>(null);
  // A file the plan on screen lists under "Needs a folder" is asked about there, not twice.
  const listed = view.plans.filter((p) => p.status === "proposed" && p.kind === "organize").flatMap((p) => p.notes.map((n) => `unplaced:${n.fileId}:`));
  const items = view.attention.filter((a) => !listed.some((k) => a.key.startsWith(k)));
  if (!items.length) return null;
  const rows = view.index.flatMap((p) => p.rows);
  return (
    <section className="block" aria-labelledby="attention-title">
      <h2 id="attention-title">Needs a look</h2>
      <ul className="looks">
        {items.map((a) => {
          const row = a.askDocId ? rows.find((r) => r.docId === a.askDocId) : undefined;
          return (
            <li key={a.key} className="look">
              <span className="look__icon">
                <Icon name="alert" />
              </span>
              <div className="look__body">
                <span className="strong">{a.title}</span>
                {a.detail && <p className="muted">{a.detail}</p>}
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
                  {a.copy?.asked && <span className="muted small">Asked for a copy.</span>}
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
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const approvedVia = (view: AppView, p: PlanView) => (view.notifications.some((n) => n.planId === p.id && n.reply?.status === "approved") ? "Approved through Fo" : "Approved");

/** A finished plan: one line, with its changes a click away. */
function HistoryRow({ plan, act, view }: { plan: PlanView; act: Act; view?: AppView }) {
  const [open, setOpen] = useState(false);
  const n = toRun(plan);
  return (
    <li className="history">
      <div className="history__head">
        <span className="history__icon">
          <Icon name={plan.status === "applied" ? "check" : "alert"} />
        </span>
        <div className="history__text">
          <span className="history__title">{plan.title}</span>
          <span className="muted">
            {plan.status === "applied" ? `Applied and verified in Drive: ${plan.counts.verified} of ${n} changes` : `${PLAN_STATUS[plan.status]}: ${plan.counts.verified} of ${n} changes verified in Drive`}
          </span>
        </div>
        {plan.finishedAt && <time className="muted nowrap">{ago(plan.finishedAt)}</time>}
      </div>
      <div className="row history__actions">
        <button className="btn btn--quiet btn--small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide steps" : "Show steps"}
        </button>
        {undoButton(plan, act)}
      </div>
      {open && <ChangeList plan={plan} act={null} view={view} />}
    </li>
  );
}

function Timeline({ view }: { view: AppView }) {
  return (
    <details className="fold">
      <summary>
        <h3>Everything Kiki did</h3>
        <span className="chev">
          <Icon name="chevronDown" size={18} />
        </span>
      </summary>
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
  );
}

function WorkspaceMenu({ view, act, onBrowse }: { view: AppView; act: Act; onBrowse: () => void }) {
  const [open, setOpen] = useState(false);
  const ws = view.workspace!;
  const list = collections(view);
  return (
    <div className="ws">
      <button className="ws__toggle" aria-expanded={open} aria-controls="ws-panel" onClick={() => setOpen(!open)}>
        <Icon name="folderCheck" size={22} />
        <span>{ws.whole ? "Watching your whole Drive" : `Watching "${ws.name}"`}{list.length > 0 && <span className="muted">{`, ${list.length} folder${list.length === 1 ? "" : "s"} organized`}</span>}</span>
        <span className={`chev ${open ? "chev--open" : ""}`}>
          <Icon name="chevronDown" size={18} />
        </span>
      </button>
      {open && (
        <div id="ws-panel" className="ws__panel">
          <ul className="rows">
            {list.map((c) => (
              <li key={c.path} className="ws__folder">
                <Icon name="folder" size={18} />
                <span className="grow">{folderLabel(c.path, ws.name)}</span>
                <span className="muted small nowrap">
                  {c.files.length} file{c.files.length === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn btn--small" onClick={onBrowse}>
              Browse folders
            </button>
            {ws.link && (
              <a className="btn btn--quiet btn--small" href={ws.link} target="_blank" rel="noreferrer">
                Open in Drive <Icon name="external" size={16} />
              </a>
            )}
            <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run("clear", () => post("/api/workspace/clear"))}>
              Change folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Activity({ view, act, onOpen, onBrowse }: { view: AppView; act: Act; onOpen: (id: string) => void; onBrowse: () => void }) {
  const ws = view.workspace;
  const fo = foName(view);
  const now = nowFor(view);
  const mock = view.integrations.fo.mode === "mock";
  const live = view.plans.filter((p) => p.status !== "superseded" && p.status !== "discarded");
  const finished = view.plans.filter((p) => p.status === "applied" || p.status === "partial").sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  const offer = view.lessons.find((l) => l.offered && !l.auto);

  const withFo: React.ReactNode[] = [];
  const inProgress: React.ReactNode[] = [];
  const completed: React.ReactNode[] = [];

  for (const p of live.filter((x) => x.status === "proposed")) withFo.push(<PlanSummaryCard key={p.id} plan={p} view={view} onOpen={onOpen} />);
  if (now?.kind === "text") {
    const n = now.n;
    const plan = n.planId ? live.find((p) => p.id === n.planId) : undefined;
    const card = (
      <Card
        key={`text-${n.taskId}`}
        icon="message"
        type={n.purpose === "decide" ? `${fo} is asking` : `Text from ${fo}`}
        at={n.createdAt}
        foot={
          plan && (
            <>
              <span className="with">
                <FoAvatar />
                {plan.title}
              </span>
              <button className="link-btn" onClick={() => onOpen(plan.id)}>
                View details <Icon name="chevronDown" size={18} />
              </button>
            </>
          )
        }
      >
        <FoTextStatus n={n} mock={mock} act={act} />
      </Card>
    );
    (textNeedsYou(n) ? withFo : inProgress).push(card);
  }
  if (now?.kind === "broken") {
    withFo.push(
      <Card
        key={`broken-${now.plan.id}`}
        icon="alert"
        type={PLAN_STATUS[now.plan.status]!}
        at={now.plan.finishedAt ?? now.plan.createdAt}
        foot={
          <button className="link-btn push" onClick={() => onOpen(now.plan.id)}>
            View details <Icon name="chevronDown" size={18} />
          </button>
        }
      >
        <h3 className="card__title">{now.plan.title}</h3>
        {brokenBody(now.plan, act)}
      </Card>,
    );
  }
  if (offer)
    withFo.push(
      <Card key={`offer-${offer.id}`} icon="listCheck" type="Kiki learned something">
        <LessonOffer lesson={offer} act={act} />
      </Card>,
    );
  for (const o of view.outreach.filter((x) => x.draft || x.dispatches.length)) {
    const latest = o.dispatches[o.dispatches.length - 1];
    const open = o.dispatches.find((d) => d.open);
    const draftWaiting = o.draft && !open && !o.dispatches.some((d) => d.version === o.draft!.version && !["failed", "not_sent", "retired"].includes(d.state));
    const needs = draftWaiting || (open ?? latest)?.state === "needs_user_input" || (open ?? latest)?.state === "uncertain" || latest?.state === "failed" || latest?.state === "not_sent";
    const card = <OutreachCard key={`o-${o.documentId}`} o={o} view={view} act={act} />;
    if (needs) withFo.push(card);
    else if (latest?.watch?.state === "closed") completed.push(card);
    else inProgress.push(card);
  }
  for (const u of view.updates.filter((x) => x.status !== "dismissed").slice(0, 4)) {
    const card = (
      <article key={`u-${u.id}`} className="card">
        <UpdateCard u={u} view={view} act={act} />
      </article>
    );
    if (u.status === "interpreting") inProgress.push(card);
    else if (u.status === "resolved") completed.push(card);
    else withFo.push(card);
  }
  if (now?.kind === "running") {
    inProgress.push(
      <Card
        key={`run-${now.plan.id}`}
        icon="refresh"
        type="Applying"
        at={now.plan.approvedAt}
        foot={
          <button className="link-btn push" onClick={() => onOpen(now.plan.id)}>
            View details <Icon name="chevronDown" size={18} />
          </button>
        }
      >
        <h3 className="card__title">{now.plan.title}</h3>
        {runningBody(now.plan)}
      </Card>,
    );
  }
  if (view.inventory.reading > 0 || view.busy.reading) {
    inProgress.push(
      <Card key="reading" icon="file" type="Reading">
        <h3 className="card__title">{view.inventory.reading > 0 ? `Kiki is reading ${view.inventory.reading} file${view.inventory.reading === 1 ? "" : "s"}.` : "Kiki is reading your files."}</h3>
        <p className="card__text">She proposes a plan once she knows what each one is.</p>
      </Card>,
    );
  }

  const appliedNow = now?.kind === "applied" ? now.plan : null;

  return (
    <>
      <Crumbs home="Workspace" onHome={() => window.scrollTo({ top: 0 })} items={["Activity"]} />
      <header className="hero">
        <h1 className="display">Your Drive, organized.</h1>
        <p className="lede">{ws ? "Kiki proposes, you approve, and she checks every change in Drive." : "Choose a folder and Kiki will propose how to organize it."}</p>
        {view.kiki.state === "error" && view.kiki.detail && <p className="error-text">{view.kiki.detail}</p>}
      </header>
      {!ws ? (
        <WorkspaceSetup view={view} act={act} />
      ) : (
        <>
          <WorkspaceMenu view={view} act={act} onBrowse={onBrowse} />
          {/* One page, no tabs: what needs you, what's happening, what happened. */}
          <section className="block" aria-labelledby="needs-title">
            <h2 id="needs-title">Needs you</h2>
            <div className="panel">
              {withFo.length ? withFo : <p className="empty">Nothing needs you right now.</p>}
              {now?.kind === "propose" && proposeBody(now, act)}
            </div>
          </section>
          <NeedsALook view={view} act={act} />
          {inProgress.length > 0 && (
            <section className="block" aria-labelledby="working-title">
              <h2 id="working-title">Working on it</h2>
              <div className="panel">{inProgress}</div>
            </section>
          )}
          {(finished.length > 0 || completed.length > 0 || (view.earlier?.length ?? 0) > 0) && (
            <section className="block" aria-labelledby="recent-title">
              <h2 id="recent-title">Recent</h2>
              {completed}
              <ul className="recent-list">
                {finished.slice(0, 5).map((p) => (
                  <li key={p.id} className="recent">
                    <span className="recent__icon">
                      <Icon name={p.status === "applied" ? "check" : "alert"} />
                    </span>
                    <div className="recent__text">
                      <button className="recent__title link-btn" onClick={() => onOpen(p.id)}>
                        {p.title}
                      </button>
                      <span className="muted">
                        {approvedVia(view, p)} · {p.status === "applied" ? "Verified in Drive" : `Partly applied, ${p.counts.verified} of ${toRun(p)} verified in Drive`}
                      </span>
                      {appliedNow?.id === p.id && <div className="recent__now">{appliedActions(p, view, act)}</div>}
                    </div>
                    {p.finishedAt && <time className="muted nowrap">{ago(p.finishedAt)}</time>}
                  </li>
                ))}
              </ul>
              {/* Finished for a folder you chose before: still yours to see. */}
              {(view.earlier?.length ?? 0) > 0 && (
                <ul className="recent-list">
                  {view.earlier!.map((p) => (
                    <li key={p.id} className="recent">
                      <span className="recent__icon">
                        <Icon name={p.status === "applied" ? "check" : "alert"} />
                      </span>
                      <div className="recent__text">
                        <span className="recent__title">{p.title}</span>
                        <span className="muted">
                          {`In "${p.workspace}" · `}
                          {p.status === "applied" ? "Verified in Drive" : p.status === "stale" ? `Stopped: something changed, ${p.verified} of ${p.total} steps verified` : `${p.status === "failed" ? "Failed" : "Partly applied"}, ${p.verified} of ${p.total} steps verified in Drive`}
                        </span>
                      </div>
                      {p.finishedAt && <time className="muted nowrap">{ago(p.finishedAt)}</time>}
                    </li>
                  ))}
                </ul>
              )}
              <details className="fold">
                <summary>Everything Kiki did</summary>
                <ul className="history-list">
                  {finished.map((p) => (
                    <HistoryRow key={p.id} plan={p} act={act} view={view} />
                  ))}
                </ul>
                <Timeline view={view} />
              </details>
            </section>
          )}
          <footer className="foot">
            <span className="foot__checked">
              <span className={`status-dot ${ws.lastInventoryAt ? "status-dot--ok" : ""}`} aria-hidden="true" />
              {ws.lastInventoryAt ? `Last checked ${ago(ws.lastInventoryAt)}` : "Looking through the folder…"}
              <button className="icon-btn" aria-label="Look again" title="Look again" disabled={act.busy !== null} onClick={() => act.run("refresh", () => post("/api/workspace/refresh"))}>
                <Icon name="refresh" size={18} />
              </button>
            </span>
            <button className="link-btn" onClick={onBrowse}>
              Find a file <Icon name="arrowRight" size={18} />
            </button>
          </footer>
        </>
      )}
    </>
  );
}

// The app ----------------------------------------------------------------------------------------

type Page = { name: "activity" } | { name: "browse" } | { name: "settings" } | { name: "plan"; id: string } | { name: "correction"; id: string };

function Connection({ view, act }: { view: AppView; act: Act }) {
  const { drive, fo } = view.integrations;
  return (
    <div className="connection">
      {fo.connection === "connected" ? (
        <p className="connection__line">
          <span className="status-dot status-dot--ok" aria-hidden="true" />
          {fo.mode === "mock" ? "Connected to Mock Fo" : "Connected to Fo"}
        </p>
      ) : (
        <p className="connection__line">
          <span className="status-dot" aria-hidden="true" />
          Fo isn't connected
          <button className="link-btn" disabled={act.busy !== null} onClick={() => connectFo(act)}>
            Connect
          </button>
        </p>
      )}
      {drive.mode === "mock" ? (
        <p className="connection__line">
          <span className="status-dot status-dot--ok" aria-hidden="true" />
          Mock Drive
        </p>
      ) : drive.connection === "connected" ? (
        <p className="connection__line">
          <span className="status-dot status-dot--ok" aria-hidden="true" />
          <span>
            Connected to Drive
            {drive.account && <span className="connection__account">{drive.account}</span>}
          </span>
        </p>
      ) : drive.connection === "not_configured" ? (
        <p className="connection__line">
          <span className="status-dot status-dot--bad" aria-hidden="true" />
          Drive isn't set up
        </p>
      ) : (
        <p className="connection__line">
          <span className="status-dot" aria-hidden="true" />
          <button className="link-btn" disabled={act.busy !== null} onClick={() => connectGoogle(act)}>
            Connect Google Drive
          </button>
        </p>
      )}
    </div>
  );
}

const NAV: { name: "activity" | "browse" | "settings"; label: string; icon: "activity" | "search" | "settings" }[] = [
  { name: "activity", label: "Activity", icon: "activity" },
  { name: "browse", label: "Browse", icon: "search" },
  { name: "settings", label: "Settings", icon: "settings" },
];

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
  const [page, setPage] = useState<Page>({ name: "activity" });
  const [theme, setThemeState] = useState<Theme>(() => initialTheme());
  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t, true);
  };

  useEffect(() => {
    applyTheme(theme, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // A new page starts at its top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page.name, "id" in page ? page.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return <div className="loading">{loadError ? <p className="error-text">Can't reach the Kiki server: {loadError}</p> : <p>Loading…</p>}</div>;

  const go = (p: Page) => {
    act.setError(null);
    setPage(p);
  };
  const openPlan = (id: string) => go({ name: "plan", id });
  // A plan you're looking at that got a newer version (an edit, or a correction through Fo): show that one.
  let plan = "id" in page ? view.plans.find((p) => p.id === page.id) : undefined;
  if (plan?.status === "superseded") {
    const old = plan;
    plan = view.plans.filter((p) => p.status === "proposed" && p.kind === old.kind && p.version > old.version).sort((a, b) => b.version - a.version)[0] ?? old;
  }
  const section = page.name === "plan" || page.name === "correction" ? "activity" : page.name;

  let content: React.ReactNode;
  if ((page.name === "plan" || page.name === "correction") && !plan) content = <p className="empty">That plan is gone. Go back to Activity.</p>;
  else if (page.name === "plan" && plan) content = <PlanDetail plan={plan} view={view} act={act} onBack={() => go({ name: "activity" })} onCorrect={() => go({ name: "correction", id: plan.id })} onOpen={openPlan} />;
  else if (page.name === "correction" && plan)
    content = (
      <Correction
        plan={plan}
        view={view}
        act={act}
        onBack={() => go({ name: "activity" })}
        onDone={() => setPage({ name: "plan", id: plan.id })}
        onOpen={(id) => setPage({ name: "correction", id })}
      />
    );
  else if (page.name === "browse")
    content = (
      <>
        <Crumbs home="Workspace" onHome={() => go({ name: "activity" })} items={["Browse"]} />
        <h1 className="display display--md">Browse</h1>
        <Browse view={view} act={act} />
      </>
    );
  else if (page.name === "settings")
    content = (
      <>
        <Crumbs home="Workspace" onHome={() => go({ name: "activity" })} items={["Settings"]} />
        <h1 className="display display--md">Settings</h1>
        <Settings view={view} act={act} theme={theme} setTheme={setTheme} />
      </>
    );
  else content = <Activity view={view} act={act} onOpen={openPlan} onBrowse={() => go({ name: "browse" })} />;

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="avatar">
            <Kiki state={view.kiki.state} size={52} />
          </span>
          <div className="brand__text">
            <span className="brand__name">kiki</span>
            <p className="brand__status" aria-live="polite">
              {view.kiki.label}
            </p>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <button key={n.name} className="nav__item" aria-current={section === n.name ? "page" : undefined} onClick={() => go({ name: n.name })}>
              <Icon name={n.icon} size={22} />
              {n.label}
            </button>
          ))}
        </nav>
        <Connection view={view} act={act} />
      </aside>
      <main id="main" className="content">
        <div className="content__inner">
          {view.integrations.drive.missingScopes.length > 0 && (
            <div className="notice notice--warn" role="alert">
              <strong>Google didn't grant every permission. Connect again and tick every box.</strong>
              <div className="row">
                <button className="btn btn--small" onClick={() => connectGoogle(act)}>
                  Connect Google Drive again
                </button>
              </div>
            </div>
          )}
          {flash && (
            <div className="notice notice--info" role="status">
              {flash}
            </div>
          )}
          {act.error && (
            <p className="error-text" role="alert">
              {act.error}
            </p>
          )}
          {content}
        </div>
      </main>
    </div>
  );
}
