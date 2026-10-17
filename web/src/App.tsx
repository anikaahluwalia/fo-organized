import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppView, NotificationView, PlanView } from "../../shared/api.ts";
import { getState, newId, post, time } from "./api.ts";
import { Kiki } from "./Kiki.tsx";

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
  const { drive, claude, fo } = view.integrations;
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
      <Badge kind={claude.mode === "live" ? "live" : "mock"}>{claude.mode === "live" ? "Claude reading: Live" : "Reading: Mock"}</Badge>
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
        <p className="lede">Kiki organizes one folder you choose. She only touches files inside it.</p>
        {view.integrations.drive.connection === "not_configured" && (
          <div className="notice notice--warn" style={{ marginTop: 12 }}>
            <strong>Google Drive isn't set up yet.</strong>
            <p>{view.integrations.drive.message}</p>
          </div>
        )}
        <div className="stack" style={{ marginTop: 14 }}>
          <button className="btn btn--primary" disabled={!driveReady || act.busy !== null} onClick={() => act.run("demo", () => post("/api/workspace/demo"))}>
            {act.busy === "demo" ? "Creating…" : "Create a staged demo folder in my Drive"}
          </button>
          <p className="hint">Makes "{"Fo-rganized demo - renovation paperwork (synthetic)"}" with synthetic invoices and quotes. Labelled as staged input.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run("select", () => post("/api/workspace/select", { folder }));
            }}
          >
            <label htmlFor="folder">Or paste a Google Drive folder link</label>
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
          <p className="lede">The one folder Kiki is allowed to organize.</p>
        </div>
        <div className="row">
          {ws.origin === "staged_demo" && <Badge kind="demo">Staged input</Badge>}
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
        <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("stage-invoice", () => post("/api/workspace/stage-revision", { variant: "invoice" }))}>
          Staged: drop a new invoice for me
        </button>
        <span className="hint">{ws.lastInventoryAt ? `Kiki keeps watching this folder · last looked ${time(ws.lastInventoryAt)}` : "Looking now…"}</span>
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
        <h2 id="inv-title">What's in the folder</h2>
        <span className="hint">Read-only. {view.inventory.reading ? `Reading ${view.inventory.reading}…` : `${files.length} files`}</span>
      </div>
      <ul className="item-list">
        {files.map((f) => (
          <li key={f.fileId} className="item">
            <div className="item-head">
              <span className="item-label">{f.name}</span>
              <span className="row">
                {f.isNew && <Badge kind="live">New</Badge>}
                {f.origin === "staged_demo" && <Badge kind="demo">Staged demo file</Badge>}
                {f.origin === "created_by_kiki" && <Badge kind="plain">Made by Kiki</Badge>}
                {f.doc && <span className={`chip chip--${f.doc.readStatus === "read" ? "confirmed" : f.doc.readStatus === "failed" || f.doc.readStatus === "unreadable" ? "needs_review" : "not_searched"}`}>{f.doc.readStatus === "read" ? f.doc.docType : f.doc.readStatus}</span>}
              </span>
            </div>
            <p className="hint">{f.path ? `${f.path}/` : "Top of the folder"}</p>
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

function PlanCard({ plan }: { plan: PlanView }) {
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
                <span className="hint">Before:</span> {op.before.path || "Top of the folder"} / <strong>{op.before.name}</strong>
              </p>
            )}
            {op.after && (
              <p>
                <span className="hint">After:</span> {op.after.path || "Top of the folder"} / <strong>{op.after.name}</strong>
              </p>
            )}
            <p className="hint">{op.reason}</p>
            {op.error && <p className="error-text">{op.error}</p>}
          </li>
        ))}
      </ol>
      {plan.notes.length > 0 && (
        <>
          <h3>Left alone</h3>
          <ul className="plain-list">
            {plan.notes.map((n) => (
              <li key={n.name} className="hint">
                <strong>{n.name}</strong>: {n.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function IndexCard({ view }: { view: AppView }) {
  if (!view.index.length) return null;
  return (
    <>
      {view.index.map((p) => (
        <section key={p.name} className="card card--plain" aria-labelledby={`idx-${p.name}`}>
          <div className="card-head">
            <h2 id={`idx-${p.name}`}>
              {p.category} / {p.name} index
            </h2>
            {p.indexFileLink && (
              <a className="btn btn--small" href={p.indexFileLink} target="_blank" rel="noreferrer">
                Open the index file
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
                    {r.acceptedAt && <span className="chip chip--confirmed">Accepted by you</span>}
                  </span>
                </div>
                <p className="hint">
                  {r.date ?? "No date"} · {r.folder} / {r.fileName}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
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
        {latest.outcome === "reported_sent" && <p>{fo.mode === "mock" ? "Mock mode: nothing was actually sent." : "Reported by Fo, not independently verified."}</p>}
        {latest.text && <p className="hint">“{latest.text}”</p>}
      </div>
    );
  }
  if (!preview) {
    return (
      <button className="btn btn--primary" disabled={act.busy !== null} onClick={() => act.run("notify-preview", async () => setPreview(await post<{ text: string; contentHash: string }>("/api/notify/preview")))}>
        Let Fo tell me what Kiki did
      </button>
    );
  }
  return (
    <div className="stack">
      <p className="hint">
        Channel: {foLabel} will message <strong>you</strong> (the account holder) the way it normally reaches you. Nobody else is contacted.
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
          {act.busy === "notify-send" ? "Sending…" : `Approve and ask ${foLabel} to send it`}
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

function FoTextStatus({ n, mock }: { n: NotificationView; mock: boolean }) {
  const fo = mock ? "Mock Fo" : "Fo";
  const label =
    n.outcome === "reported_sent"
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
      {mock && n.outcome === "reported_sent" && <p>Mock mode: no text was actually sent.</p>}
    </div>
  );
}

function Decisions({ view, act }: { view: AppView; act: ReturnType<typeof useAction> }) {
  const proposed = view.plans.find((p) => p.status === "proposed");
  const requestId = useMemo(() => newId(), [proposed?.id]);
  const applied = view.plans.find((p) => p.status === "applied" || p.status === "partial");
  const readingDone = view.workspace && view.inventory.status === "done" && view.inventory.reading === 0 && !view.busy.reading && !view.busy.inventory;
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
            <strong>Fo texts me when Kiki finds something to file.</strong>
            <span className="hint" style={{ display: "block" }}>
              Only you are texted. Nothing moves until you approve here.
            </span>
          </span>
        </label>
      )}
      {view.notifications[0] && (proposed || running) && <FoTextStatus n={view.notifications[0]} mock={view.integrations.fo.mode === "mock"} />}
      {!view.workspace && <p className="lede">Choose a workspace folder to begin.</p>}
      {view.workspace && !proposed && !running && (
        <div className="stack">
          <p className="lede">{readingDone ? "Kiki has read the folder." : "Kiki is reading the folder…"}</p>
          <button className="btn" disabled={!readingDone || act.busy !== null} onClick={() => act.run("propose", () => post("/api/plans/organize"))}>
            {applied ? "Check again for anything to organize" : "Ask Kiki for an organizing plan"}
          </button>
        </div>
      )}
      {proposed && (
        <div className="stack">
          <p>
            <strong>{proposed.title}</strong> (version {proposed.version})
          </p>
          <p className="lede">{proposed.summary} Each step is checked against Drive right before it runs, then read back to verify.</p>
          <div className="approve-row">
            <button
              className="btn btn--primary"
              disabled={act.busy !== null}
              onClick={() => act.run("approve", () => post(`/api/plans/${proposed.id}/approve`, { contentHash: proposed.contentHash, clientRequestId: requestId }))}
            >
              {act.busy === "approve" ? "Approving…" : "Approve this plan"}
            </button>
            <div className="secondary-actions">
              <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run("discard", () => post(`/api/plans/${proposed.id}/discard`))}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
      {running && (
        <div className="progress">
          <span className="dot" aria-hidden="true" />
          <span>
            Applying {running.counts.verified} of {running.counts.total - running.counts.excluded} steps, checking each one in Drive…
          </span>
        </div>
      )}
      {applied && !proposed && !running && (
        <div className="stack" style={{ marginTop: 14 }}>
          <div className={`notice ${applied.status === "applied" ? "notice--ok" : "notice--warn"}`}>
            <strong>{applied.status === "applied" ? "Applied and verified in Drive." : "Partly applied."}</strong>
            <p>
              {applied.counts.verified} of {applied.counts.total - applied.counts.excluded} steps confirmed by reading Drive back.
            </p>
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
        <summary>Evidence and activity</summary>
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
  const latestPlan = view.plans.find((p) => p.status !== "superseded" && p.status !== "discarded");

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <Kiki state={view.kiki.state} size={44} />
          <div>
            <h1>Fo-rganized</h1>
            <p>Kiki keeps your workspace organized, and Fo keeps you posted.</p>
          </div>
        </div>
        <Integrations view={view} act={act} />
      </header>
      {flash && (
        <div className="notice notice--info toast" role="status">
          {flash}
        </div>
      )}
      <div className="layout">
        <main className="main">
          <WorkspaceCard view={view} act={act} />
          <InventoryCard view={view} />
          {latestPlan && <PlanCard plan={latestPlan} />}
          <IndexCard view={view} />
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
        </aside>
      </div>
      <p className="footer-note">Kiki never deletes files. Every change is previewed, approved by you, checked against Drive right before it runs, and verified afterwards.</p>
    </div>
  );
}
