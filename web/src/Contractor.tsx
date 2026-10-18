import { useMemo, useState } from "react";
import type { AppView, DispatchView, IndexRowView, OutreachView, UpdateView } from "../../shared/api.ts";
import { newId, post, time } from "./api.ts";

export interface Act {
  busy: string | null;
  error: string | null;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}

/** From a quote in the index: who to ask, with explicit consent. Nothing is sent from here. */
export function AskContractor({ row, view, act, onDone }: { row: IndexRowView; view: AppView; act: Act; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [userName, setUserName] = useState(view.settings.userName ?? "");
  return (
    <form
      className="stack"
      style={{ marginTop: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(`ask-${row.docId}`, async () => {
          if (!view.settings.userName) await post("/api/settings", { userName });
          await post(`/api/documents/${row.docId}/outreach`, { contractorName: name, contractorEmail: email, consent });
          onDone();
        });
      }}
    >
      {!view.settings.userName && (
        <div>
          <label htmlFor={`me-${row.docId}`}>Your first name</label>
          <input id={`me-${row.docId}`} type="text" value={userName} onChange={(e) => setUserName(e.target.value)} />
        </div>
      )}
      <div>
        <label htmlFor={`cn-${row.docId}`}>Contractor's name</label>
        <input id={`cn-${row.docId}`} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana" />
      </div>
      <div>
        <label htmlFor={`ce-${row.docId}`}>Their email</label>
        <input id={`ce-${row.docId}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dana@example.com" />
      </div>
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>They've agreed to hear from my assistant.</span>
      </label>
      <div className="row">
        <button className="btn btn--primary" disabled={!name.trim() || !email.trim() || !consent || (!view.settings.userName && !userName.trim()) || act.busy !== null}>
          Draft the question
        </button>
        <button type="button" className="btn btn--quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DispatchStatus({ d, foLabel, act }: { d: DispatchView; foLabel: string; act: Act }) {
  const [answer, setAnswer] = useState("");
  const [ack, setAck] = useState(false);
  const t = d.task;
  const heading: Record<DispatchView["state"], string> = {
    approved: "Approved. Handing it to Fo…",
    dispatching: `Sending to ${foLabel}…`,
    working: `${foLabel} is working on it.`,
    needs_user_input: `${foLabel} has a question.`,
    reported_sent: `${foLabel} reports the email was sent.`,
    not_sent: `${foLabel} says it didn't send the email.`,
    failed: "The email wasn't sent.",
    uncertain: "Not sure the email went out.",
    retired: "You closed this attempt.",
  };
  const tone = d.state === "reported_sent" ? "notice--ok" : d.state === "failed" || d.state === "uncertain" || d.state === "not_sent" ? "notice--bad" : "notice--info";
  return (
    <div className={`notice ${tone}`} style={{ marginTop: 10 }}>
      <strong>{heading[d.state]}</strong>
      {t.progress && (d.state === "working" || d.state === "dispatching") && <p>{t.progress}</p>}
      {t.pollPaused && d.state === "working" && (
        <p>
          {foLabel} is still on it and keeps working even if you leave.{" "}
          <button className="btn btn--small" onClick={() => act.run("keep", () => post(`/api/tasks/${t.taskId}/keep-waiting`))}>
            Keep waiting
          </button>
        </p>
      )}
      {d.state === "needs_user_input" && (
        <form
          className="stack"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act.run("answer", async () => {
              await post(`/api/tasks/${t.taskId}/reply`, { answer });
              setAnswer("");
            });
          }}
        >
          <p>{t.question}</p>
          <textarea style={{ minHeight: 70 }} value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label={`Answer ${foLabel}`} />
          <p className="hint">Your answer can't change who gets the email or what it says. To change those, edit the message and approve again.</p>
          <div className="row">
            <button className="btn btn--primary" disabled={!answer.trim() || act.busy !== null}>
              Send answer
            </button>
            <button type="button" className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run("stop", () => post(`/api/dispatches/${d.id}/stop`))}>
              Don't send it
            </button>
          </div>
        </form>
      )}
      {(d.state === "failed" || d.state === "not_sent") && t.failureDetail && <p>{t.failureDetail}</p>}
      {d.state === "uncertain" && (
        <div className="stack" style={{ marginTop: 8 }}>
          {t.failureDetail && <p>{t.failureDetail}</p>}
          {!d.reconciledAt ? (
            <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("reconcile", () => post(`/api/dispatches/${d.id}/reconcile`))}>
              Check with Fo (read-only)
            </button>
          ) : (
            <>
              <p>{d.reconcileNote}</p>
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand it might already have been sent.</span>
              </label>
              <button className="btn btn--small" disabled={!ack || act.busy !== null} onClick={() => act.run("retire", () => post(`/api/dispatches/${d.id}/retire`, { acknowledge: true }))}>
                Close this attempt
              </button>
            </>
          )}
        </div>
      )}
      {d.state === "reported_sent" && <p className="hint">Not independently verified. It doesn't mean they've read it.</p>}
    </div>
  );
}

function WatchPanel({ d, foLabel, act }: { d: DispatchView; foLabel: string; act: Act }) {
  const [paste, setPaste] = useState("");
  const [ask, setAsk] = useState("");
  const [mode, setMode] = useState<"none" | "paste" | "ask">("none");
  const w = d.watch;
  if (!w) return null;
  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <p className="hint">
        {w.state === "watching"
          ? `Following the ${foLabel} conversation for ${d.recipientName}'s reply${w.lastCheckedAt ? ` · checked ${time(w.lastCheckedAt)}` : ""}.`
          : w.state === "paused"
            ? `Paused: ${w.lastError ?? "reconnect Fo"}.`
            : "Answered and applied. Kiki stopped following this conversation."}
      </p>
      <div className="row">
        {w.state === "watching" && (
          <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("check", () => post(`/api/watches/${w.id}/check`))}>
            Check now
          </button>
        )}
        {w.state !== "watching" && (
          <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("watch", () => post(`/api/watches/${w.id}/watching`, { watching: true }))}>
            Follow again
          </button>
        )}
        <button className="btn btn--quiet btn--small" onClick={() => setMode(mode === "paste" ? "none" : "paste")}>
          Paste their reply
        </button>
        <button className="btn btn--quiet btn--small" onClick={() => setMode(mode === "ask" ? "none" : "ask")}>
          Ask {foLabel}
        </button>
      </div>
      {mode === "paste" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run("paste", async () => {
              await post(`/api/watches/${w.id}/paste`, { text: paste });
              setPaste("");
              setMode("none");
            });
          }}
        >
          <textarea style={{ minHeight: 70 }} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Their reply" placeholder="Paste the reply you received" />
          <button className="btn btn--primary" disabled={!paste.trim() || act.busy !== null}>
            Use this reply
          </button>
        </form>
      )}
      {mode === "ask" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run("ask-fo", async () => {
              await post(`/api/watches/${w.id}/follow-up`, { text: ask });
              setAsk("");
              setMode("none");
            });
          }}
        >
          <textarea style={{ minHeight: 70 }} value={ask} onChange={(e) => setAsk(e.target.value)} aria-label={`Message to ${foLabel}`} placeholder={`Has ${d.recipientName} replied?`} />
          <button className="btn btn--primary" disabled={!ask.trim() || act.busy !== null}>
            Send to {foLabel}
          </button>
        </form>
      )}
    </div>
  );
}

/** The exact message, who it goes to, why, and that nothing else is shared or promised. */
export function OutreachCard({ o, view, act }: { o: OutreachView; view: AppView; act: Act }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ recipientName: "", recipientEmail: "", subject: "", body: "", consent: false });
  const [resend, setResend] = useState(false);
  const draft = o.draft;
  const requestId = useMemo(() => newId(), [draft?.versionId, draft?.contentHash]);
  const foLabel = view.integrations.fo.mode === "mock" ? "Mock Fo" : "Fo";
  const open = o.dispatches.find((d) => d.open);
  const latest = o.dispatches[o.dispatches.length - 1];
  const sentBefore = o.dispatches.some((d) => d.state === "reported_sent" || d.state === "retired");
  // A version that already went out (or is going out) isn't offered for approval again.
  const awaitingApproval = draft && !o.dispatches.some((d) => d.version === draft.version && !["failed", "not_sent", "retired"].includes(d.state));

  return (
    <section className="card decision" aria-label={`Question about ${o.quoteLabel}`}>
      <h2>Ask about {o.quoteLabel}</h2>
      {draft && awaitingApproval && !open && !editing && (
        <div className="stack">
          <dl className="facts">
            <dt>To</dt>
            <dd>
              {draft.recipientName} &lt;{draft.recipientEmail}&gt;
            </dd>
            <dt>Channel</dt>
            <dd>Email, sent by {foLabel}</dd>
            <dt>Purpose</dt>
            <dd>{draft.purpose}</dd>
            <dt>Subject</dt>
            <dd>{draft.subject}</dd>
          </dl>
          <pre className="message-preview">{draft.body}</pre>
          <p className="hint">No attachments, no file sharing, no other recipients, no commitments. Version {draft.version}.</p>
          {draft.problems.length > 0 && <p className="error-text">{draft.problems.join(" ")}</p>}
          {sentBefore && (
            <label className="check">
              <input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} />
              <span>Fo may already have sent a message about this quote. Send another one anyway.</span>
            </label>
          )}
          <div className="approve-row">
            <button
              className="btn btn--primary"
              disabled={draft.problems.length > 0 || (sentBefore && !resend) || act.busy !== null}
              onClick={() => act.run("send", () => post(`/api/outreach/${draft.versionId}/send`, { contentHash: draft.contentHash, clientRequestId: requestId, confirmResend: resend }))}
            >
              {act.busy === "send" ? "Approving…" : "Approve and send"}
            </button>
            <div className="secondary-actions">
              <button
                className="btn btn--quiet"
                onClick={() => {
                  setForm({ recipientName: draft.recipientName, recipientEmail: draft.recipientEmail, subject: draft.subject, body: draft.body, consent: false });
                  setEditing(true);
                }}
              >
                Change message
              </button>
              <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run("discard-outreach", () => post(`/api/outreach/${draft.versionId}/discard`))}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
      {draft && editing && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run("revise", async () => {
              await post(`/api/outreach/${draft.versionId}/revise`, form);
              setEditing(false);
            });
          }}
        >
          <label htmlFor="o-name">Name</label>
          <input id="o-name" type="text" value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} />
          <label htmlFor="o-email">Email</label>
          <input id="o-email" type="email" value={form.recipientEmail} onChange={(e) => setForm({ ...form, recipientEmail: e.target.value })} />
          {form.recipientEmail.trim().toLowerCase() !== draft.recipientEmail.toLowerCase() && (
            <label className="check">
              <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
              <span>The new recipient agreed to hear from my assistant.</span>
            </label>
          )}
          <label htmlFor="o-subject">Subject</label>
          <input id="o-subject" type="text" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <label htmlFor="o-body">Message</label>
          <textarea id="o-body" style={{ minHeight: 180 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          <p className="hint">Saving makes a new version; you'll approve it again.</p>
          <div className="row">
            <button className="btn btn--primary" disabled={act.busy !== null}>
              Save changes
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {(open ?? latest) && <DispatchStatus d={(open ?? latest)!} foLabel={foLabel} act={act} />}
      {latest?.state === "reported_sent" && <WatchPanel d={latest} foLabel={foLabel} act={act} />}
      {draft && !awaitingApproval && !editing && latest?.state === "reported_sent" && (
        <button
          className="btn btn--quiet btn--small"
          onClick={() => {
            setForm({ recipientName: draft.recipientName, recipientEmail: draft.recipientEmail, subject: draft.subject, body: draft.body, consent: false });
            setEditing(true);
          }}
        >
          Write a follow-up version
        </button>
      )}
    </section>
  );
}

/** What Kiki picked up from Fo's conversation, and what she needs from you. */
export function UpdateCard({ u, view, act }: { u: UpdateView; view: AppView; act: Act }) {
  const [picked, setChoice] = useState<string | null>(null);
  // A single candidate to confirm is preselected: the question is just yes or no.
  const choice = picked ?? (u.candidates.length === 1 ? u.candidates[0]!.docId : null);
  const foLabel = view.integrations.fo.mode === "mock" ? "Mock Fo" : "Fo";
  const tone = u.status === "needs_clarification" ? "notice--warn" : u.status === "failed" ? "notice--bad" : u.status === "proposed" || u.status === "resolved" ? "notice--ok" : "notice--info";
  const statusLine: Record<UpdateView["status"], string> = {
    interpreting: "Reading the message…",
    no_outcome: "Nothing to act on.",
    needs_clarification: "Kiki needs your help.",
    proposed: "Kiki prepared an update for your approval.",
    resolved: "Applied and verified in Drive.",
    dismissed: "Set aside.",
    failed: "Kiki couldn't read this message.",
  };
  return (
    <div className={`notice ${tone}`} style={{ marginBottom: 12 }}>
      <strong>{statusLine[u.status]}</strong>
      <p className="hint">
        {u.sourceLabel} · {time(u.createdAt)}
        {u.interpreter === "mock" ? " · mock reading" : ""}
      </p>
      {u.quote ? <p className="quote">“{u.quote}”</p> : <p className="quote">{u.message.replace(/^\(Mock Fo: simulated\. Nothing was sent and nobody was contacted\.\)\n/, "")}</p>}
      {u.statement && <p>{u.statement}</p>}
      {u.ignoredRequests.length > 0 && <p className="hint">It also asked for things Kiki won't do by herself: {u.ignoredRequests.join("; ")}.</p>}
      {u.status === "needs_clarification" && (
        <div className="stack" style={{ marginTop: 8 }}>
          {u.question && <p>{u.question}</p>}
          {u.candidates.length >= 1 && (
            <>
              {u.candidates.map((c) => (
                <label key={c.docId} className="check">
                  <input type="radio" name={`pick-${u.id}`} checked={choice === c.docId} onChange={() => setChoice(c.docId)} />
                  <span>
                    <strong>{c.name}</strong> {[c.reference, c.date, c.total].filter(Boolean).join(" · ")}
                    <span className="hint" style={{ display: "block" }}>
                      {c.reasons.join(" ")}
                    </span>
                  </span>
                </label>
              ))}
              <div className="row">
                <button className="btn btn--primary" disabled={!choice || act.busy !== null} onClick={() => act.run("resolve", () => post(`/api/updates/${u.id}/resolve`, { documentId: choice }))}>
                  {u.candidates.length === 1 ? "Yes, that's it" : "This one"}
                </button>
                <button className="btn btn--quiet" disabled={act.busy !== null} onClick={() => act.run("none", () => post(`/api/updates/${u.id}/resolve`, { documentId: null }))}>
                  {u.candidates.length === 1 ? "No" : "None of these"}
                </button>
              </div>
            </>
          )}
          {u.candidates.length === 0 && u.emailAttachments.length > 0 && (
            <div className="stack">
              {u.emailAttachments.map((a) => (
                <div key={a.index} className="item">
                  <div className="item-head">
                    <span className="item-label">{a.filename}</span>
                    {a.saved && <span className="chip chip--confirmed">Saved to folder</span>}
                  </div>
                  <p className="hint">
                    {a.subject || "(no subject)"} · {a.from}
                    {a.date ? ` · ${time(a.date)}` : ""}
                    {view.integrations.drive.gmail === "mock" ? " · mock Gmail" : ""}
                  </p>
                  {!a.saved && (
                    <button className="btn btn--primary btn--small" disabled={act.busy !== null} onClick={() => act.run(`save-att-${a.index}`, () => post(`/api/updates/${u.id}/gmail/save`, { index: a.index }))}>
                      Save to the folder
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {u.candidates.length === 0 && (
            <div className="row">
              {(view.integrations.drive.gmail === "connected" || view.integrations.drive.gmail === "mock") && u.emailAttachments.length === 0 && (
                <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("gmail-search", () => post(`/api/updates/${u.id}/gmail/search`))}>
                  Look in Gmail
                </button>
              )}
              {view.integrations.drive.gmail === "not_connected" && (
                <button
                  className="btn btn--small"
                  disabled={act.busy !== null}
                  onClick={() =>
                    act.run("gmail-connect", async () => {
                      const r = await post<{ authorizationUrl: string }>("/api/google/connect", { gmail: true });
                      window.location.href = r.authorizationUrl;
                    })
                  }
                >
                  Let Kiki look in Gmail (read-only)
                </button>
              )}
              <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("recheck", () => post(`/api/updates/${u.id}/recheck`))}>
                Check again
              </button>
              {view.workspace?.mode === "mock" && (
                <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run("stage-quote", () => post("/api/workspace/stage-revision", { variant: "single" }))}>
                  Add the revised quote
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {u.status === "failed" && (
        <>
          {u.error && <p>{u.error}</p>}
          <button className="btn btn--small" disabled={act.busy !== null} onClick={() => act.run("recheck", () => post(`/api/updates/${u.id}/recheck`))}>
            Try again
          </button>
        </>
      )}
      {(u.status === "no_outcome" || u.status === "needs_clarification") && (
        <button className="btn btn--quiet btn--small" disabled={act.busy !== null} onClick={() => act.run("dismiss", () => post(`/api/updates/${u.id}/dismiss`))}>
          Dismiss
        </button>
      )}
      {u.status === "proposed" && <p className="hint">Review the update under Decisions. {foLabel} reported what the contractor said; Kiki checks the files in Drive.</p>}
    </div>
  );
}
