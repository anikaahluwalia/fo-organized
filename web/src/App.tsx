import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppView, NotificationView, PlanView } from "../../shared/api.ts";
import { getState, newId, post, time } from "./api.ts";
import { Kiki } from "./Kiki.tsx";
import { AskContractor, OutreachCard, UpdateCard } from "./Contractor.tsx";

const KIKI_STATE_NAMES: Record<string, string> = {
  idle: "Idle",
  reading: "Reading",
  organizing: "Organizing",
  needs_approval: "Needs your approval",
  waiting: "Waiting for someone",
  needs_clarification: "Needs clarification",
  verified: "Verified",
  error: "Error",
};

const OP_STATE: Record<string, string> = {
  pending: "Proposed",
  running: "Applying…",
  verified: "Applied and verified",
  failed: "Failed",
  stale: "Stopped: changed since preview",
  skipped: "Didn't run",
  uncertain: "Uncertain: checking Drive",
  excluded: "Excluded",
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

function Badge({ kind, children }: { kind: "live" | "mock" | "demo" | "problem" | "plain"; children: React.ReactNode }) {
  return <span className={`badge ${kind === "plain" ? "" : `badge--${kind}`}`}>{children}</span>;
}

function Integrations({ view, act }: { view: AppView; act: ReturnType<typeof useAction> }) {
  const { drive, fo } = view.integrations;
  const connect = (name: "google" | "fo") =>
    act.run(`connect-${name}`, async () => {
      const r = await post<{ authorizationUrl: string }>(`/api/${name}/connect`);
      window.location.href = r.authorizationUrl;
    });
  return (
    <div className="header-tools">
      {drive.mode === "mock" ? (
        <Badge kind="mock">Google Drive: Mock</Badge>
      ) : drive.connection === "connected" ? (
        <Badge kind="live">Google Drive: Live{drive.account ? ` · ${drive.account}` : ""}</Badge>
      ) : drive.connection === "not_configured" ? (
        <Badge kind="problem">Google Drive: not configured</Badge>
      ) : (
        <button className="btn btn--small" onClick={() => connect("google")} disabled={act.busy !== null}>
          Connect Google Drive
        </button>
      )}
      {fo.mode === "mock" ? (
        <Badge kind="mock">Fo: Mock</Badge>
      ) : fo.connection === "connected" ? (
        <Badge kind="live">Fo: Live</Badge>
      ) : (
        <button className="btn btn--small" onClick={() => connect("fo")} disabled={act.busy !== null}>
          Connect Fo
        </button>
      )}
    </div>
  );
}

function WorkspaceCard({ view, act }: { view: AppView; act: ReturnType<typeof useAction> }) {
  const [folder, setFolder] = useState("");
  const ws = view.workspace;
  const driveReady = view.integrations.drive.mode === "mock" || view.integrations.drive.connection === "connected";
  if (!ws) {
    return (
      <section className="card" aria-labelledby="ws-title">
        <h2 id="ws-title">Workspace</h2>
        <p className="lede">Pick the folder Kiki should organize. She won't touch anything outside it.</p>
        {view.integrations.drive.connection === "not_configured" && (
          <div className="notice notice--warn" style={{ marginTop: 12 }}>
            <strong>Google Drive isn't set up yet.</strong>
            <p>{view.integrations.drive.message}</p>
          </div>
        )}
        <div className="stack" style={{ marginTop: 14 }}>
          <button className="btn btn--primary" disabled={!driveReady || act.busy !== null} onClick={() => act.run("demo", () => post("/api/workspace/demo"))}>
            {act.busy === "demo" ? "Setting up…" : "Set up the renovation folder in my Drive"}
          </button>
          <p className="hint">Adds the renovation invoices and quotes.</p>
          <form
            className="stack"
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
          </form>
        </div>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="ws-title">
      <div className="card-head">
        <div>
          <h2 id="ws-title">{ws.name}</h2>
        </div>
        <div className="row">
          <Badge kind={ws.mode === "live" ? "live" : "mock"}>{ws.mode === "live" ? "Live Drive" : "Mock Drive"}</Badge>
        </div>
      </div>
      <div className="row">
        {ws.link && (
          <a className="btn btn--small" href={ws.link} target="_blank" rel="noreferrer">
            Open in Drive
          </a>
        )}
        <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("refresh", () => post("/api/workspace/refresh"))}>
          Look again
        </button>
        <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run("clear", () => post("/api/workspace/clear"))}>
          Change folder
        </button>
        {ws.mode === "mock" && (
          <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("stage-invoice", () => post("/api/workspace/stage-revision", { variant: "invoice" }))}>
            Add an invoice
          </button>
        )}
        <span className="hint">{ws.lastInventoryAt ? `Watching · checked ${time(ws.lastInventoryAt)}` : "Looking…"}</span>
      </div>
    </section>
  );
}

function InventoryCard({ view }: { view: AppView }) {
  const files = view.inventory.files.filter((f) => f.kind !== "folder");
  if (!view.workspace) return null;
  return (
    <section className="card card--plain" aria-labelledby="inv-title">
      <div className="card-head">
        <h2 id="inv-title">Files</h2>
        <span className="hint">{view.inventory.reading ? `Reading ${view.inventory.reading}…` : `${files.length} files`}</span>
      </div>
      <ul className="item-list">
        {files.map((f) => (
          <li key={f.fileId} className="item">
            <div className="item-head">
              <span className="item-label">{f.name}</span>
              <span className="row">
                {f.isNew && <Badge kind="live">New</Badge>}
                {f.origin === "created_by_kiki" && <Badge kind="plain">Made by Kiki</Badge>}
                {f.doc && <span className={`chip chip--${f.doc.readStatus === "read" ? "confirmed" : f.doc.readStatus === "failed" || f.doc.readStatus === "unreadable" ? "needs_review" : "not_searched"}`}>{f.doc.readStatus === "read" ? f.doc.docType : f.doc.readStatus}</span>}
              </span>
            </div>
            <p className="hint">{f.path || "Top level"}</p>
            {f.doc?.readStatus === "read" && (
              <p>
                {[f.doc.issuer.value, f.doc.reference.value, f.doc.date.value, f.doc.total.value].filter(Boolean).join(" · ")}
                {f.doc.readMode === "mock" && <span className="hint"> (mock reading)</span>}
              </p>
            )}
            {f.doc?.readError && <p className="error-text">{f.doc.readError}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OpEditor({ planId, seq, name, act }: { planId: string; seq: number; name: string; act: ReturnType<typeof useAction> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  if (!open) {
    return (
      <div className="row">
        <button className="btn btn--quiet btn--small" onClick={() => setOpen(true)}>
          Rename
        </button>
        <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`skip-${seq}`, () => post(`/api/plans/${planId}/revise`, { edits: [{ seq, exclude: true }] }))}>
          Skip this
        </button>
      </div>
    );
  }
  return (
    <form
      className="edit-row"
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(`rename-${seq}`, async () => {
          await post(`/api/plans/${planId}/revise`, { edits: [{ seq, newName: value }] });
          setOpen(false);
        });
      }}
    >
      <input type="text" value={value} onChange={(e) => setValue(e.target.value)} aria-label="New file name" />
      <button className="btn btn--small" disabled={!value.trim() || act.busy !== null}>
        Save
      </button>
      <button type="button" className="btn btn--quiet btn--small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

function PlanCard({ plan, act }: { plan: PlanView; act: ReturnType<typeof useAction> }) {
  return (
    <section className="card card--plain" aria-labelledby={`plan-${plan.id}`}>
      <div className="card-head">
        <div>
          <h2 id={`plan-${plan.id}`}>{plan.title}</h2>
          <p className="lede">{plan.summary}</p>
        </div>
        <span className={`chip chip--${plan.status === "applied" ? "confirmed" : plan.status === "proposed" ? "not_searched" : "needs_review"}`}>
          {PLAN_STATUS[plan.status]} · v{plan.version}
        </span>
      </div>
      {plan.evidence && (
        <div className="notice notice--info" style={{ marginBottom: 12 }}>
          <strong>{plan.evidence.source}</strong>
          <p className="quote">“{plan.evidence.statement}”</p>
          {plan.evidence.candidateReasons.length > 0 && <p className="hint">Why this file: {plan.evidence.candidateReasons.join(" ")}</p>}
        </div>
      )}
      {plan.diff && plan.diff.lines.length > 0 && (
        <div className="notice notice--warn" style={{ marginBottom: 12 }}>
          <strong>What changed between the quotes</strong>
          {plan.diff.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          <p className="hint">Marking a quote current doesn't accept its price. You do that separately in the index.</p>
        </div>
      )}
      {plan.conflict && (
        <div className="notice notice--bad" style={{ marginBottom: 12 }}>
          <strong>{plan.conflict}</strong>
        </div>
      )}
      <ol className="item-list">
        {plan.ops.map((op) => (
          <li key={op.seq} className="item">
            <div className="item-head">
              <span className="item-label">
                {op.seq}. {op.title}
              </span>
              <span className={`chip chip--${op.state === "verified" ? "confirmed" : op.state === "pending" ? "not_searched" : "needs_review"}`}>{OP_STATE[op.state]}</span>
            </div>
            {op.before && op.kind === "move_rename" && (
              <p>
                <span className="hint">From</span> {op.before.path || "Top level"} / <strong>{op.before.name}</strong>
              </p>
            )}
            {op.after && (
              <p>
                <span className="hint">To</span> {op.after.path || "Top level"} / <strong>{op.after.name}</strong>
              </p>
            )}
            {op.kind !== "create_folder" && <p className="hint">{op.reason}</p>}
            {op.error && <p className="error-text">{op.error}</p>}
            {op.editable && op.state === "pending" && op.after && <OpEditor planId={plan.id} seq={op.seq} name={op.after.name} act={act} />}
          </li>
        ))}
      </ol>
      {plan.notes.length > 0 && (
        <>
          <h3>Not moved</h3>
          <ul className="plain-list">
            {plan.notes.map((n) => (
              <li key={n.name} className="hint">
                <strong>{n.name}</strong>: {n.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.canUndo && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run(`undo-${plan.id}`, () => post(`/api/plans/${plan.id}/undo`))}>
            Undo these changes…
          </button>
          <span className="hint">Kiki prepares the reversal for you to approve. Nothing is deleted.</span>
        </div>
      )}
    </section>
  );
}

function IndexCard({ view, act }: { view: AppView; act: ReturnType<typeof useAction> }) {
  const [asking, setAsking] = useState<string | null>(null);
  if (!view.index.length) return null;
  return (
    <>
      {view.index.map((p) => (
        <section key={p.name} className="card card--plain" aria-labelledby={`idx-${p.name}`}>
          <div className="card-head">
            <h2 id={`idx-${p.name}`}>{p.name} index</h2>
            {p.indexFileLink && (
              <a className="btn btn--small" href={p.indexFileLink} target="_blank" rel="noreferrer">
                Open index file
              </a>
            )}
          </div>
          <ul className="item-list">
            {p.rows.map((r) => (
              <li key={r.docId} className="item">
                <div className="item-head">
                  <span className="item-label">
                    {r.docType === "invoice" ? "Invoice" : r.docType === "quote" ? "Quote" : r.docType} · {r.issuer ?? "Unknown issuer"} {r.reference ?? ""}
                  </span>
                  <span className="row">
                    {r.total && <span className="chip chip--not_searched">{r.total}</span>}
                    {r.status === "current" && <span className="chip chip--confirmed">Current</span>}
                    {r.status === "superseded" && <span className="chip chip--needs_review">Superseded</span>}
                    {r.latestReceived && r.docType === "quote" && <span className="chip chip--not_searched">Latest received</span>}
                    {r.acceptedAt && <span className="chip chip--confirmed">Price accepted by you</span>}
                  </span>
                </div>
                <p className="hint">
                  {r.date ?? "No date"} · {r.folder} / {r.fileName}
                  {r.supersedes ? ` · replaces ${r.supersedes}` : ""}
                </p>
                {r.docType === "quote" && r.status !== "superseded" && (
                  <div className="row">
                    {r.canAsk && asking !== r.docId && (
                      <button className="btn btn--quiet btn--small" onClick={() => setAsking(r.docId)}>
                        Ask the contractor if this is final
                      </button>
                    )}
                    <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run(`accept-${r.docId}`, () => post(`/api/documents/${r.docId}/accept`, { accepted: !r.acceptedAt }))}>
                      {r.acceptedAt ? "Withdraw price acceptance" : "Mark price accepted"}
                    </button>
                  </div>
                )}
                {asking === r.docId && <AskContractor row={r} view={view} act={act} onDone={() => setAsking(null)} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function FoUpdates({ view, act }: { view: AppView; act: ReturnType<typeof useAction> }) {
  const shown = view.updates.filter((u) => u.status !== "dismissed").slice(0, 4);
  const conversations = view.outreach.filter((o) => o.draft || o.dispatches.length);
  if (!shown.length && !conversations.length) return null;
  return (
    <>
      {conversations.map((o) => (
        <OutreachCard key={o.documentId} o={o} view={view} act={act} />
      ))}
      {shown.length > 0 && (
        <section className="card decision" aria-labelledby="fo-updates">
          <h2 id="fo-updates">From Fo</h2>
          {shown.map((u) => (
            <UpdateCard key={u.id} u={u} view={view} act={act} />
          ))}
        </section>
      )}
    </>
  );
}

function NotifyDecision({ view, act }: { view: AppView; act: ReturnType<typeof useAction> }) {
  const [preview, setPreview] = useState<{ text: string; contentHash: string } | null>(null);
  const requestId = useMemo(() => newId(), [preview?.contentHash]);
  const latest: NotificationView | undefined = view.notifications[0];
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
                : `Waiting on ${foLabel}…`;
    return (
      <div className={`notice ${latest.outcome === "reported_sent" ? "notice--ok" : latest.state === "failed" || latest.state === "uncertain" ? "notice--bad" : "notice--info"}`}>
        <strong>{label}</strong>
        {latest.progress && latest.state === "working" && <p>{latest.progress}</p>}
        {latest.question && <p>{latest.question}</p>}
        {latest.failureDetail && <p>{latest.failureDetail}</p>}
        {latest.text && <p className="hint">“{latest.text}”</p>}
      </div>
    );
  }
  if (!preview) {
    return (
      <button className="btn btn--primary" disabled={act.busy !== null} onClick={() => act.run("notify-preview", async () => setPreview(await post<{ text: string; contentHash: string }>("/api/notify/preview")))}>
        Text me a summary
      </button>
    );
  }
  return (
    <div className="stack">
      <p className="hint">
        {foLabel} will text this to you. No one else.
      </p>
      <pre className="message-preview">{preview.text}</pre>
      <div className="approve-row">
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
        <div className="secondary-actions">
          <button className="btn btn--quiet" onClick={() => setPreview(null)}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

function FoTextStatus({ n, mock, act }: { n: NotificationView; mock: boolean; act: ReturnType<typeof useAction> }) {
  const fo = mock ? "Mock Fo" : "Fo";
  const [answer, setAnswer] = useState("");
  const r = n.reply;
  const label =
    r?.status === "approved"
      ? `You replied "${r.text}". Kiki is filing it.`
      : r?.status === "declined"
        ? `You replied "${r.text}". Not filing it.`
        : n.purpose === "done" && n.outcome === "reported_sent"
          ? `${fo} texted you that it's done.`
          : r?.status === "waiting" && n.outcome === "reported_sent"
            ? `${fo} texted you. Reply "go ahead" to file it, or approve here.`
            : r?.status === "expired"
              ? "No reply yet. You can approve here."
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
              : `${fo} is texting you…`;
  return (
    <div className={`notice ${n.outcome === "reported_sent" ? "notice--ok" : n.state === "failed" || n.state === "uncertain" ? "notice--bad" : "notice--info"}`} style={{ marginBottom: 14 }}>
      <strong>{label}</strong>
      {n.text && <p className="hint">“{n.text}”</p>}
      {(n.question || n.failureDetail) && <p>{n.question ?? n.failureDetail}</p>}
      {n.state === "working" && n.progress && <p>{n.progress}</p>}
      {n.state === "needs_user_input" && (
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
          <label htmlFor={`ans-${n.taskId}`}>Answer {fo}</label>
          <textarea id={`ans-${n.taskId}`} style={{ minHeight: 70 }} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <button className="btn btn--primary" disabled={!answer.trim() || act.busy !== null}>
            Send answer to {fo}
          </button>
        </form>
      )}
    </div>
  );
}

function ApproveBlock({ plan, act }: { plan: PlanView; act: ReturnType<typeof useAction> }) {
  // One request id per plan version: a double click resolves to the same approval on the server.
  const requestId = useMemo(() => newId(), [plan.id, plan.contentHash]);
  return (
    <div className="stack" style={{ marginBottom: 14 }}>
      <p>
        <strong>{plan.title}</strong> (version {plan.version})
      </p>
      <p className="lede">{plan.summary}</p>
      <div className="approve-row">
        <button
          className="btn btn--primary"
          disabled={act.busy !== null}
          onClick={() => act.run(`approve-${plan.id}`, () => post(`/api/plans/${plan.id}/approve`, { contentHash: plan.contentHash, clientRequestId: requestId }))}
        >
          {act.busy === `approve-${plan.id}` ? "Approving…" : "Approve"}
        </button>
        <div className="secondary-actions">
          <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run(`discard-${plan.id}`, () => post(`/api/plans/${plan.id}/discard`))}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

function Decisions({ view, act }: { view: AppView; act: ReturnType<typeof useAction> }) {
  const proposed = view.plans.find((p) => p.status === "proposed");
  const applied = view.plans.find((p) => p.status === "applied" || p.status === "partial");
  const readingDone = view.workspace && view.inventory.files.length > 0 && view.inventory.reading === 0 && !view.busy.reading;
  const broken = view.plans.find((p) => p.status === "failed" || p.status === "partial" || p.status === "stale");
  const brokenError = broken?.ops.find((o) => o.error)?.error ?? null;
  const running = view.plans.find((p) => p.status === "approved" || p.status === "executing");

  return (
    <section className="card decision" aria-labelledby="decide-title">
      <h2 id="decide-title">Decisions</h2>
      {view.workspace && (
        <label className="check" style={{ margin: "8px 0 14px" }}>
          <input
            type="checkbox"
            checked={Boolean(view.settings.autoText)}
            disabled={act.busy !== null}
            onChange={(e) => act.run("auto-text", () => post("/api/settings", { autoText: e.target.checked }))}
          />
          <span>
            <strong>Text me when Kiki finds something new</strong>
            <span className="hint" style={{ display: "block" }}>Reply "go ahead" to Fo and Kiki files it.</span>
          </span>
        </label>
      )}
      {view.notifications[0] && (proposed || running || view.notifications[0].state !== "complete" || view.notifications[0].purpose === "done") && (
        <FoTextStatus n={view.notifications[0]} mock={view.integrations.fo.mode === "mock"} act={act} />
      )}
      {!view.workspace && <p className="lede">Choose a workspace folder to begin.</p>}
      {broken && !proposed && !running && (
        <div className="notice notice--bad" style={{ marginBottom: 14 }}>
          <strong>{broken.status === "stale" ? "Something changed since the plan was made." : "Some changes didn't go through."}</strong>
          {brokenError && <p>{brokenError}</p>}
          <button
            className="btn btn--small"
            style={{ marginTop: 8 }}
            disabled={act.busy !== null}
            onClick={() => act.run("retry", () => post(broken.status === "stale" ? "/api/plans/organize" : `/api/plans/${broken.id}/resume`))}
          >
            {broken.status === "stale" ? "Refresh the plan" : "Try again"}
          </button>
        </div>
      )}
      {view.workspace && !proposed && !running && (
        <div className="stack">
          {!readingDone && <p className="lede">Reading files…</p>}
          <button className="btn" disabled={!readingDone || act.busy !== null} onClick={() => act.run("propose", () => post("/api/plans/organize"))}>
            {applied ? "Check for anything new" : "Propose a plan"}
          </button>
        </div>
      )}
      {view.plans
        .filter((p) => p.status === "proposed")
        .map((p) => (
          <ApproveBlock key={p.id} plan={p} act={act} />
        ))}
      {running && (
        <div className="progress">
          <span className="dot" aria-hidden="true" />
          <span>
            Applying {running.counts.verified} of {running.counts.total - running.counts.excluded}…
          </span>
        </div>
      )}
      {applied && !proposed && !running && (
        <div className="stack" style={{ marginTop: 14 }}>
          <div className={`notice ${applied.status === "applied" ? "notice--ok" : "notice--warn"}`}>
            <strong>
              {applied.status === "applied" ? "Done" : "Partly done"}: {applied.counts.verified} of {applied.counts.total - applied.counts.excluded} changes verified in Drive.
            </strong>
          </div>
          <NotifyDecision view={view} act={act} />
        </div>
      )}
      {act.error && (
        <p className="error-text" role="alert">
          {act.error}
        </p>
      )}
    </section>
  );
}

function Activity({ view }: { view: AppView }) {
  return (
    <section className="card card--plain">
      <details>
        <summary>Activity</summary>
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
    const msg = params.get("connected") ? `Connected ${params.get("connected")}.` : params.get("connectError");
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
  const shownPlans = [...livePlans.filter((p) => p.status === "proposed" || p.status === "approved" || p.status === "executing"), ...livePlans.filter((p) => !["proposed", "approved", "executing"].includes(p.status)).slice(0, 1)];

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <Kiki state={view.kiki.state} size={44} />
          <div>
            <h1>Kiki</h1>
            <p>Keeps your Drive organized. Fo keeps you posted.</p>
          </div>
        </div>
        <Integrations view={view} act={act} />
      </header>
      {view.integrations.drive.missingScopes.length > 0 && (
        <div className="notice notice--warn toast" role="alert">
          <strong>Google didn't grant every permission Kiki needs.</strong>
          <p>On Google's consent screen, tick every box. Disconnect isn't needed: just click Connect Google Drive again.</p>
          <button className="btn btn--small" onClick={() => act.run("connect-google", async () => { const r = await post<{ authorizationUrl: string }>("/api/google/connect"); window.location.href = r.authorizationUrl; })}>
            Connect Google Drive again
          </button>
        </div>
      )}
      {flash && (
        <div className="notice notice--info toast" role="status">
          {flash}
        </div>
      )}
      <div className="layout">
        <main className="main">
          <WorkspaceCard view={view} act={act} />
          <InventoryCard view={view} />
          {shownPlans.map((p) => (
            <PlanCard key={p.id} plan={p} act={act} />
          ))}
          <IndexCard view={view} act={act} />
          <Activity view={view} />
        </main>
        <aside className="companion" aria-label="Kiki and decisions">
          <section className="card kiki-card" aria-live="polite">
            <Kiki state={view.kiki.state} size={180} />
            <div>
              <p className="kiki-state-name">{KIKI_STATE_NAMES[view.kiki.state]}</p>
              <p className="kiki-status">{view.kiki.label}</p>
              {view.kiki.detail && <p className="kiki-detail">{view.kiki.detail}</p>}
            </div>
          </section>
          <Decisions view={view} act={act} />
          <FoUpdates view={view} act={act} />
        </aside>
      </div>
    </div>
  );
}
