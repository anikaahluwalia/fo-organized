// Pure helpers for Kiki's side panel: address checks, wording, and the view model built from the
// Kiki app's GET /api/state. No DOM and no chrome.* in here, so plain Node can check them.

export const KIKI_ORIGIN = "http://localhost:8787";
export const REFRESH_MS = 2000;
export const PAIRING_HINT = "In the Kiki app, click Pair side panel and type the 6-digit code here.";
export const OFFLINE_HINT = "Start Kiki on your computer: npm start in the project folder.";

export const STATE_NAMES = Object.freeze({
  idle: "Idle",
  reading: "Reading",
  organizing: "Organizing",
  needs_approval: "Needs your approval",
  waiting: "Waiting for someone",
  needs_clarification: "Needs clarification",
  verified: "Verified",
  error: "Error",
});

const OP_STATE = {
  pending: "Proposed",
  running: "Applying…",
  verified: "Applied and verified",
  failed: "Failed",
  stale: "Stopped: changed since preview",
  skipped: "Didn't run",
  uncertain: "Uncertain: checking Drive",
  excluded: "Excluded",
};

const OP_TONE = { pending: "plain", running: "busy", verified: "ok", failed: "bad", stale: "warn", skipped: "warn", uncertain: "warn", excluded: "muted" };

const NOTE_STATUS = { already_organized: "Already organized", needs_review: "Needs review", left_in_place: "Left in place", waiting: "Still reading" };

const PURPOSE = { find: "About a new find", done: "Done message", summary: "Summary note" };

const LINK_HOSTS = new Set(["drive.google.com", "docs.google.com"]);
const FOLDER_PATH = /^\/drive\/(?:u\/\d{1,3}\/)?folders\/([A-Za-z0-9_-]{10,200})\/?$/;

function parseUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The folder ID in a Google Drive folder address, or null. Accepts
 * https://drive.google.com/drive/folders/<id> and .../drive/u/<n>/folders/<id>, with any query or hash.
 */
export function driveFolderId(url) {
  const u = parseUrl(url);
  if (!u || u.protocol !== "https:" || u.hostname !== "drive.google.com" || u.port || u.username || u.password) return null;
  return FOLDER_PATH.exec(u.pathname)?.[1] ?? null;
}

/** The plain folder address Kiki is given: no account index, query or hash. */
export function folderLink(id) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

/** An address that is safe to put in a link: the Kiki app, or an https Google Drive or Docs page. */
export function safeLink(url) {
  const u = parseUrl(url);
  if (!u || u.username || u.password) return null;
  if (u.origin === KIKI_ORIGIN) return u.href;
  if (u.protocol === "https:" && !u.port && LINK_HOSTS.has(u.hostname)) return u.href;
  return null;
}

/** The folder name Drive puts in a tab title ("Receipts - Google Drive"), or null. */
export function tabFolderName(title) {
  if (typeof title !== "string") return null;
  const name = title.replace(/\s+[-–—]\s+Google Drive\s*$/u, "").trim();
  if (!name || name === "Google Drive") return null;
  return name.length > 120 ? `${name.slice(0, 119)}…` : name;
}

/** "Renovations / Flooring / Invoices / file.pdf" for a { name, path } location in the workspace. */
export function place(loc) {
  if (!loc) return null;
  const parts = String(loc.path ?? "")
    .split("/")
    .filter(Boolean);
  if (loc.name) parts.push(String(loc.name));
  return parts.length ? parts.join(" / ") : null;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "9:41 PM" today, "Oct 16, 9:41 PM" on other days, "" when there's no usable time. */
export function formatTime(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** The 6-digit pairing code from what was typed (spaces and dashes are fine), or null. */
export function cleanCode(input) {
  const s = String(input ?? "").replace(/[\s-]/g, "");
  return /^\d{6}$/.test(s) ? s : null;
}

/** What the latest message through Fo says. What Fo reports stays labelled as Fo's report. */
export function foText(n, now = new Date()) {
  const fo = n.mode === "mock" ? "Mock Fo" : "Fo";
  const r = n.reply ?? null;
  const thing = n.purpose === "summary" ? "note" : "text";
  let label;
  let tone = "info";
  if (r?.status === "approved") {
    label = `You replied "${r.text ?? ""}". Kiki is filing it.`;
    tone = "ok";
  } else if (r?.status === "declined") {
    label = `You replied "${r.text ?? ""}". Not filing it.`;
  } else if (n.purpose === "done" && n.outcome === "reported_sent") {
    label = `${fo} reports it texted you that it's done.`;
    tone = "ok";
  } else if (r?.status === "waiting" && n.outcome === "reported_sent") {
    label = `${fo} reports it texted you. Reply "go ahead" to file it, or approve here.`;
  } else if (r?.status === "expired") {
    label = "No reply yet. You can approve here.";
  } else if (n.outcome === "reported_sent") {
    label = thing === "note" ? `${fo} reports it sent you the note.` : `${fo} reports it texted you.`;
    tone = "ok";
  } else if (n.state === "failed") {
    label = `The ${thing} wasn't sent.`;
    tone = "bad";
  } else if (n.state === "uncertain") {
    label = `Not sure the ${thing} went out.`;
    tone = "bad";
  } else if (n.state === "needs_user_input") {
    label = `${fo} has a question. Answer it in the Kiki app.`;
    tone = "warn";
  } else if (n.outcome === "not_sent") {
    label = `${fo} says it didn't send the ${thing}.`;
    tone = "warn";
  } else {
    label = thing === "note" ? `${fo} is sending you the note…` : `${fo} is texting you…`;
  }
  return {
    fo,
    label,
    tone,
    text: n.text || null,
    more: n.question || n.failureDetail || null,
    progress: n.state === "working" ? n.progress || null : null,
    purpose: PURPOSE[n.purpose] ?? null,
    time: formatTime(n.createdAt, now),
  };
}

function stepModel(op) {
  const kind = op.kind;
  return {
    seq: op.seq,
    title: String(op.title ?? ""),
    from: kind === "move_rename" ? place(op.before) : kind === "set_status" ? (op.before?.name ?? null) : null,
    to: kind === "set_status" ? (op.after?.name ?? null) : place(op.after),
    reason: kind === "create_folder" ? null : op.reason || null,
    state: op.state,
    stateLabel: OP_STATE[op.state] ?? String(op.state ?? ""),
    tone: OP_TONE[op.state] ?? "plain",
    error: op.error || null,
  };
}

function totals(plan) {
  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  const excluded = plan.counts?.excluded ?? ops.filter((o) => o.state === "excluded").length;
  const total = (plan.counts?.total ?? ops.length) - excluded;
  const verified = plan.counts?.verified ?? ops.filter((o) => o.state === "verified").length;
  return { ops, total, verified };
}

function driveLabel(d) {
  if (d.mode === "mock") return "Mock";
  if (d.connection === "connected") return "Live";
  if (d.connection === "needs_auth") return "Not connected";
  if (d.connection === "not_configured") return "Not set up";
  return "Problem";
}

function foLabel(f) {
  if (f.mode === "mock") return "Mock";
  if (f.connection === "connected") return "Live";
  if (f.connection === "needs_auth") return "Not connected";
  return "Problem";
}

/**
 * Everything the panel shows, from the app's view and the active tab ({ url, title } or null).
 * Plain data only, so the panel can compare it between refreshes and skip redrawing.
 */
export function buildModel(view, { tab = null, now = new Date() } = {}) {
  const v = view ?? {};
  const drive = v.integrations?.drive ?? {};
  const fo = v.integrations?.fo ?? {};
  const ws = v.workspace ?? null;
  const plans = Array.isArray(v.plans) ? v.plans : [];
  const files = Array.isArray(v.inventory?.files) ? v.inventory.files : [];
  const reading = Number(v.inventory?.reading) || 0;
  const mockDrive = drive.mode === "mock";
  const driveReady = mockDrive || drive.connection === "connected";
  const foReady = fo.mode === "mock" || fo.connection === "connected";
  const autoTextOn = Boolean(v.settings?.autoText);

  const kiki = {
    state: v.kiki?.state ?? "idle",
    name: STATE_NAMES[v.kiki?.state] ?? "",
    label: String(v.kiki?.label ?? ""),
    detail: v.kiki?.detail ? String(v.kiki.detail) : null,
  };

  const alerts = [];
  if (!mockDrive && drive.connection === "needs_auth") alerts.push({ tone: "warn", title: "Google Drive isn't connected.", body: "Connect it in the Kiki app, then come back here.", openKiki: true });
  else if (!mockDrive && drive.connection === "not_configured") alerts.push({ tone: "warn", title: "Google Drive isn't set up yet.", body: drive.message || null, openKiki: false });
  else if (!mockDrive && drive.connection === "error") alerts.push({ tone: "bad", title: "Kiki can't reach Google Drive.", body: drive.message || null, openKiki: false });
  if (drive.connection === "connected" && Array.isArray(drive.missingScopes) && drive.missingScopes.length) {
    alerts.push({ tone: "warn", title: "Google didn't grant every permission Kiki needs.", body: "Connect Google Drive again in the Kiki app and tick every box.", openKiki: true });
  }
  if (autoTextOn && !foReady) {
    alerts.push(
      fo.connection === "error"
        ? { tone: "bad", title: "Kiki can't reach Fo right now.", body: fo.message || null, openKiki: false }
        : { tone: "warn", title: "Fo isn't connected, so it can't text you.", body: "Connect Fo in the Kiki app.", openKiki: true },
    );
  }

  const docs = files.filter((f) => f.kind !== "folder");
  const workspace = ws
    ? {
        name: String(ws.name ?? ""),
        link: safeLink(ws.link),
        mock: ws.mode === "mock",
        pill: reading > 0 ? `Reading ${reading}…` : ws.lastInventoryAt ? plural(docs.length, "file") : "Looking…",
      }
    : null;

  const proposedPlan = plans.find((p) => p.status === "proposed");
  const runningPlan = plans.find((p) => p.status === "approved" || p.status === "executing");
  const idle = !proposedPlan && !runningPlan;
  const brokenPlan = idle ? plans.find((p) => p.status === "failed" || p.status === "partial" || p.status === "stale") : undefined;
  const appliedPlan = idle ? plans.find((p) => p.status === "applied" || p.status === "partial") : undefined;

  // The active tab, when it's a Drive folder: where it sits relative to the workspace.
  let here = null;
  let offer = null;
  const tabFolder = tab ? driveFolderId(tab.url) : null;
  if (tabFolder) {
    const rootId = ws ? driveFolderId(ws.link) : null;
    const inside = ws ? files.find((f) => f.kind === "folder" && f.fileId === tabFolder) : undefined;
    if (rootId && rootId === tabFolder) here = "This tab shows the workspace folder.";
    else if (inside) here = `This tab shows ${place(inside)} in this workspace.`;
    else {
      offer = {
        folderId: tabFolder,
        url: folderLink(tabFolder),
        title: tabFolderName(tab.title),
        state: mockDrive ? "mock" : !driveReady ? "needs_drive" : runningPlan ? "busy" : ws ? "switch" : "ready",
        from: workspace?.name ?? null,
      };
    }
  }

  let proposed = null;
  if (proposedPlan) {
    const { ops } = totals(proposedPlan);
    const ev = proposedPlan.evidence;
    proposed = {
      id: proposedPlan.id,
      key: `${proposedPlan.id}:${proposedPlan.contentHash}`,
      contentHash: proposedPlan.contentHash,
      title: String(proposedPlan.title ?? ""),
      summary: proposedPlan.summary ? String(proposedPlan.summary) : null,
      version: Number(proposedPlan.version) || 1,
      eyebrow: proposedPlan.kind === "undo" ? "UNDO, IF YOU WANT IT" : proposedPlan.kind === "version_update" ? "AN UPDATE TO REVIEW" : "YOUR ORGANIZING PLAN",
      steps: ops.map(stepModel),
      count: ops.filter((o) => o.state !== "excluded").length,
      notes: (Array.isArray(proposedPlan.notes) ? proposedPlan.notes : []).map((n) => ({ name: String(n.name ?? ""), status: NOTE_STATUS[n.status] ?? String(n.status ?? ""), reason: String(n.reason ?? "") })),
      evidence: ev?.statement ? { statement: String(ev.statement), source: ev.source ? String(ev.source) : null } : null,
      diff: Array.isArray(proposedPlan.diff?.lines) && proposedPlan.diff.lines.length ? proposedPlan.diff.lines.map(String) : null,
      conflict: proposedPlan.conflict ? String(proposedPlan.conflict) : null,
    };
  }

  let running = null;
  if (runningPlan) {
    const { ops, total, verified } = totals(runningPlan);
    running = {
      id: runningPlan.id,
      title: String(runningPlan.title ?? ""),
      label: `Applying… ${verified} of ${total} verified so far.`,
      steps: ops.filter((o) => o.state !== "excluded").map(stepModel),
    };
  }

  let broken = null;
  if (brokenPlan) {
    const { ops } = totals(brokenPlan);
    const stale = brokenPlan.status === "stale";
    broken = {
      id: brokenPlan.id,
      title: String(brokenPlan.title ?? ""),
      heading: stale ? "Something changed since the plan was made." : "Some changes didn't go through.",
      error: ops.find((o) => o.error)?.error ?? null,
      action: stale ? "refresh" : brokenPlan.canResume ? "resume" : null,
      actionLabel: stale ? "Refresh the plan" : "Try again",
    };
  }

  let done = null;
  if (appliedPlan) {
    const { ops, total, verified } = totals(appliedPlan);
    const partial = appliedPlan.status === "partial";
    done = {
      id: appliedPlan.id,
      partial,
      label: `${partial ? "Partly done" : "Done"}: ${verified} of ${total} changes verified in ${mockDrive ? "the mock Drive" : "Drive"}.`,
      title: String(appliedPlan.title ?? ""),
      when: formatTime(appliedPlan.finishedAt, now),
      steps: ops.filter((o) => o.state !== "excluded").map(stepModel),
    };
  }

  const readingDone = Boolean(ws) && files.length > 0 && reading === 0 && !v.busy?.reading;
  const check = ws && idle ? { label: appliedPlan ? "Check for anything new" : "Propose a plan", ready: readingDone } : null;

  const latest = Array.isArray(v.notifications) ? v.notifications[0] : undefined;

  return {
    kiki,
    modes: `Drive: ${driveLabel(drive)} · Fo: ${foLabel(fo)}`,
    alerts,
    workspace,
    here,
    offer,
    fo: latest ? foText(latest, now) : null,
    proposed,
    running,
    broken,
    done,
    check,
    // Without a connected Drive, the alert above already says what to do.
    empty: ws ? null : mockDrive ? "Kiki is using a mock Drive. Open Kiki to set up the renovation folder." : driveReady ? "Open a Google Drive folder in this tab, and I'll offer to organize it." : null,
    autoText: ws ? { on: autoTextOn } : null,
    events: (Array.isArray(v.activity?.events) ? v.activity.events : []).slice(0, 50).map((e) => ({ time: formatTime(e.at, now), message: String(e.message ?? "") })),
  };
}
