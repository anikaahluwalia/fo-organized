// Pure helpers for Kiki's side panel: address checks, wording, and the view model built from the
// Kiki app's GET /api/state. No DOM and no chrome.* in here, so plain Node can check them.

export const KIKI_ORIGIN = "http://localhost:8787";
export const REFRESH_MS = 2000;
export const PAIRING_HINT = "In Kiki, open Settings. Under Chrome side panel, click Pair side panel, then type the code here.";
export const OFFLINE_HINT = "Start Kiki on your computer: npm start in the project folder. The panel keeps checking.";

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

/** A finished plan, as Recent says it. */
const FINISHED = {
  applied: { label: "Applied and verified", tone: "ok" },
  partial: { label: "Partly applied", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  stale: { label: "Stopped: files changed", tone: "warn" },
  discarded: { label: "You said no", tone: "muted" },
};

/** How long a finished text through Fo stays news. */
const RECENT_MS = 30 * 60_000;

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

/** "Projects / Flooring" for a folder path; "the main folder" for the top. */
const folderOf = (path) => place({ path, name: "" }) ?? "the main folder";
const joinPath = (path, name) => (path ? `${path}/${name}` : name);

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
  } else if (r?.status === "stale") {
    label = "The proposal changed since Fo asked. Review the new version.";
  } else if (r?.status === "waiting" && n.outcome === "reported_sent") {
    label = `${fo} reports it texted you about it. Reply there, or decide here.`;
  } else if (r?.status === "expired") {
    label = "This request expired before a decision came back. Ask again from the Kiki app.";
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
  } else if (n.state === "working" && n.pollPaused) {
    label = `Kiki lost touch with ${fo} while it was ${thing === "note" ? "sending your note" : "texting you"}.`;
    tone = "warn";
  } else if (n.state === "complete") {
    label = `${fo} didn't say whether it ${thing === "note" ? "sent the note" : "texted you"}.`;
    tone = "warn";
  } else {
    label = thing === "note" ? `${fo} is sending you the note…` : `${fo} is texting you…`;
  }
  return {
    fo,
    label,
    tone,
    more: n.question || n.failureDetail || (n.pollPaused ? n.pollError : null) || null,
    progress: n.state === "working" ? n.progress || null : null,
    time: formatTime(n.createdAt, now),
  };
}

/** Fo asked you something you can answer here, as in the app: not while Kiki is already acting on an answer. */
const answerable = (n) => n.state === "needs_user_input" && (!n.reply || n.reply.status === "waiting");

/** A text that went wrong, or that Kiki can't settle without you. */
const textNeedsYou = (n) =>
  n.state === "needs_user_input" || n.state === "failed" || n.state === "uncertain" || n.pollPaused || n.outcome === "not_sent" || ["stale", "expired", "not_changed"].includes(n.reply?.status);

const foBusy = (n) => n.state === "pending" || n.state === "asking" || n.state === "working";

/**
 * Fo's latest text belongs on screen while it's about the plan on screen (proposed or running),
 * while Fo is still on it, or for a while after it finished.
 */
function textIsCurrent(n, proposedId, runningId, now) {
  if (n.purpose === "find" || n.purpose === "decide") return Boolean(n.planId && (n.planId === proposedId || n.planId === runningId));
  if (n.state !== "complete") return true;
  return now.getTime() - Date.parse(n.createdAt) < RECENT_MS;
}

function opRow(op, title, from, to, where) {
  return {
    seq: op.seq,
    title,
    from,
    to,
    where,
    state: op.state,
    stateLabel: OP_STATE[op.state] ?? String(op.state ?? ""),
    tone: OP_TONE[op.state] ?? "plain",
    error: op.error || null,
  };
}

/**
 * A plan's changes in plain words, one row each, as in the app: "old → new" and the folder. A new
 * folder is folded into the moves into it; it gets a row of its own only when nothing moves into
 * it or its step went wrong.
 */
export function changeRows(plan) {
  const ops = (Array.isArray(plan?.ops) ? plan.ops : []).filter((o) => o.state !== "excluded");
  const folders = ops.filter((o) => o.kind === "create_folder" && o.after);
  const newFolders = new Set(folders.map((o) => joinPath(o.after.path, o.after.name)));
  const rows = [];
  const into = [];
  for (const op of ops) {
    const { before, after } = op;
    if (op.kind === "create_folder") continue;
    if (op.kind === "move_rename" && before && after) {
      const moved = before.path !== after.path;
      const renamed = before.name !== after.name;
      if (moved) into.push(after.path);
      const where = moved ? `into ${folderOf(after.path)}${newFolders.has(after.path) ? ", a new folder" : ""}` : null;
      rows.push(opRow(op, null, renamed ? String(before.name) : null, String(after.name), where));
    } else if (op.kind === "write_index" && after) {
      into.push(after.path);
      rows.push(opRow(op, String(op.title ?? "").startsWith("Create") ? "Create the project index" : "Update the project index", null, String(after.name), `in ${folderOf(after.path)}`));
    } else if (op.kind === "set_status") {
      rows.push(opRow(op, String(op.title ?? ""), before?.name ?? null, after?.name ?? null, op.reason || null));
    } else {
      rows.push(opRow(op, String(op.title ?? ""), null, null, null));
    }
  }
  for (const op of folders) {
    const path = joinPath(op.after.path, op.after.name);
    const used = into.some((p) => p === path || p.startsWith(`${path}/`));
    if (!used || op.error || (op.state !== "pending" && op.state !== "verified")) rows.push(opRow(op, "Make a new folder", null, folderOf(path), null));
  }
  return rows;
}

function totals(plan) {
  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  const excluded = plan.counts?.excluded ?? ops.filter((o) => o.state === "excluded").length;
  const total = (plan.counts?.total ?? ops.length) - excluded;
  const verified = plan.counts?.verified ?? ops.filter((o) => o.state === "verified").length;
  return { total, verified };
}

function driveMode(d) {
  if (d.mode === "mock") return { label: "Mock Drive", ok: true };
  if (d.connection === "connected") return { label: "Live Drive", ok: true };
  if (d.connection === "needs_auth") return { label: "Drive not connected", ok: false };
  if (d.connection === "not_configured") return { label: "Drive not set up", ok: false };
  return { label: "Drive problem", ok: false };
}

function foMode(f) {
  if (f.mode === "mock") return { label: "Mock Fo", ok: true };
  if (f.connection === "connected") return { label: "Live Fo", ok: true };
  if (f.connection === "needs_auth") return { label: "Fo not connected", ok: false };
  return { label: "Fo problem", ok: false };
}

/** The chip for each kind of thing Kiki points out, as in the app's "Needs a look". */
const ATTENTION_CHIP = {
  missing: { label: "Missing", tone: "bad" },
  expired: { label: "Expired", tone: "bad" },
  which_current: { label: "Unclear", tone: "warn" },
  duplicate: { label: "Copy?", tone: "warn" },
  expiring: { label: "Soon", tone: "warn" },
  undecided: { label: "Your call", tone: "" },
  unreadable: { label: "Couldn't read", tone: "warn" },
  unplaced: { label: "Where?", tone: "warn" },
};

function planType(p) {
  if (p.kind === "undo") return "Proposed undo";
  if (p.kind === "version_update") return "Proposed quote update";
  return p.version > 1 ? `Revised plan, version ${p.version}` : "Proposed plan";
}

/**
 * Everything the panel shows, from the app's view and the active tab ({ url, title } or null), in
 * the panel's order: what needs you, what Kiki is working on, and what happened recently. Plain
 * data only, so the panel can compare it between refreshes and skip redrawing.
 */
export function buildModel(view, { tab = null, now = new Date() } = {}) {
  const v = view ?? {};
  const drive = v.integrations?.drive ?? {};
  const fo = v.integrations?.fo ?? {};
  const ws = v.workspace ?? null;
  const plans = Array.isArray(v.plans) ? v.plans : [];
  const files = Array.isArray(v.inventory?.files) ? v.inventory.files : [];
  const notifications = Array.isArray(v.notifications) ? v.notifications : [];
  const reading = Number(v.inventory?.reading) || 0;
  const busy = v.busy ?? {};
  const mockDrive = drive.mode === "mock";
  const driveReady = mockDrive || drive.connection === "connected";
  const foReady = fo.mode === "mock" || fo.connection === "connected";
  const autoTextOn = Boolean(v.settings?.autoText);
  const inDrive = mockDrive ? "in the mock Drive" : "in Drive";

  const kiki = { state: v.kiki?.state ?? "idle", label: String(v.kiki?.label ?? "") };

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
  const workspace = ws ? { name: String(ws.name ?? ""), link: safeLink(ws.link), mock: ws.mode === "mock", files: ws.lastInventoryAt ? docs.length : null } : null;

  const proposedPlan = plans.find((p) => p.status === "proposed");
  const runningPlan = plans.find((p) => p.status === "approved" || p.status === "executing");
  const idle = !proposedPlan && !runningPlan;
  const brokenPlan = idle ? plans.find((p) => p.status === "failed" || p.status === "partial" || p.status === "stale") : undefined;

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

  // Fo's latest text goes where it matters: a question to answer here, a problem that needs you,
  // a line while Fo is on it, or next to the plan it's about.
  const latest = notifications[0];
  const text = latest && textIsCurrent(latest, proposedPlan?.id ?? null, runningPlan?.id ?? null, now) ? latest : null;
  const said = text ? foText(text, now) : null;
  let question = null;
  let foNeeds = null;
  let foWorking = null;
  let foNote = null;
  if (text && answerable(text)) {
    question = { taskId: String(text.taskId), fo: said.fo, question: text.question ? String(text.question) : null, time: said.time, planId: text.planId ?? null };
  } else if (text && textNeedsYou(text)) {
    foNeeds = { ...said, openKiki: text.state === "needs_user_input" };
  } else if (text && foBusy(text)) {
    foWorking = { label: said.label, detail: said.progress };
  } else if (text) {
    foNote = { planId: text.planId ?? null, label: said.label, tone: said.tone, time: said.time, at: text.createdAt };
  }

  let proposed = null;
  if (proposedPlan) {
    const ev = proposedPlan.evidence;
    const rows = changeRows(proposedPlan);
    // Fo's request about this plan that you can still answer: a correction goes back through it.
    const request = notifications.find((n) => n.planId === proposedPlan.id && (n.purpose === "find" || n.purpose === "decide") && n.reply?.status === "waiting");
    proposed = {
      id: proposedPlan.id,
      key: `${proposedPlan.id}:${proposedPlan.contentHash}`,
      contentHash: proposedPlan.contentHash,
      title: String(proposedPlan.title ?? ""),
      type: planType(proposedPlan),
      time: formatTime(proposedPlan.createdAt, now),
      rows,
      count: rows.length,
      notes: (Array.isArray(proposedPlan.notes) ? proposedPlan.notes : []).map((n) => ({
        name: String(n.name ?? ""),
        status: n.unplaced ? "Needs a folder" : (NOTE_STATUS[n.status] ?? String(n.status ?? "")),
        reason: String(n.reason ?? ""),
      })),
      evidence: ev?.statement ? { statement: String(ev.statement), source: ev.source ? String(ev.source) : null } : null,
      diff: Array.isArray(proposedPlan.diff?.lines) && proposedPlan.diff.lines.length ? proposedPlan.diff.lines.map(String) : null,
      conflict: proposedPlan.conflict ? String(proposedPlan.conflict) : null,
      fo: foNote?.planId === proposedPlan.id ? foNote.label : null,
      request: request && !foBusy(request) ? { taskId: String(request.taskId), fo: request.mode === "mock" ? "Mock Fo" : "Fo" } : null,
    };
  }

  let running = null;
  if (runningPlan) {
    const { total, verified } = totals(runningPlan);
    running = { id: runningPlan.id, title: String(runningPlan.title ?? ""), label: `Applying… ${verified} of ${plural(total, "step")} verified so far.` };
  }

  let broken = null;
  if (brokenPlan) {
    const stale = brokenPlan.status === "stale";
    const rows = changeRows(brokenPlan).filter((r) => r.state !== "verified");
    broken = {
      id: brokenPlan.id,
      title: String(brokenPlan.title ?? ""),
      type: FINISHED[brokenPlan.status].label,
      heading: stale ? "Something changed since the plan was made." : "Some changes didn't go through.",
      steps: rows,
      error: rows.find((r) => r.error)?.error ?? null,
      action: stale ? "refresh" : brokenPlan.canResume ? "resume" : null,
      actionLabel: stale ? "Refresh the plan" : "Try again",
    };
  }

  // One line while something is happening, the most specific first.
  let working = null;
  if (running) working = { label: running.label, detail: null };
  else if (foWorking) working = foWorking;
  else if (reading > 0) working = { label: `Reading ${plural(reading, "file")}…`, detail: null };
  else if (busy.reading) working = { label: "Reading your documents…", detail: null };
  else if (busy.interpreting) working = { label: "Reading Fo's update…", detail: null };
  else if (busy.inventory && ws && !files.length) working = { label: "Looking through the folder…", detail: null };

  // The last few finished plans, newest first, then Fo's latest report if it's about none of them.
  const finished = plans
    .filter((p) => FINISHED[p.status] && p.id !== brokenPlan?.id)
    .map((p) => ({ p, at: p.finishedAt ?? p.createdAt ?? "" }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 4);
  const recent = finished.map(({ p, at }) => {
    const counts = totals(p);
    const f = FINISHED[p.status];
    // Applied means every step was read back from Drive; anything less says exactly how many were.
    const label = p.status === "partial" || p.status === "failed" ? `${f.label}: ${counts.verified} of ${plural(counts.total, "step")} verified ${inDrive}` : f.label;
    return { id: p.id, kind: "plan", status: p.status, title: String(p.title ?? ""), label, counts, tone: f.tone, time: formatTime(at, now), fo: foNote?.planId === p.id ? foNote.label : null };
  });
  if (foNote && foNote.planId !== proposedPlan?.id && !recent.some((r) => r.id === foNote.planId)) {
    recent.unshift({ id: `fo:${foNote.at}`, kind: "fo", status: null, title: foNote.label, label: null, counts: null, tone: foNote.tone, time: foNote.time, fo: null });
  }

  const readingDone = Boolean(ws) && files.length > 0 && reading === 0 && !busy.reading;
  const anyApplied = plans.some((p) => p.status === "applied" || p.status === "partial");

  return {
    kiki,
    modes: { drive: driveMode(drive), fo: foMode(fo) },
    alerts,
    workspace,
    here,
    offer,
    question,
    fo: foNeeds,
    proposed,
    running,
    broken,
    working,
    recent,
    check: ws && idle ? { label: anyApplied ? "Check for anything new" : "Propose a plan", ready: readingDone } : null,
    // Without a connected Drive, the alert already says what to do.
    empty: ws ? null : mockDrive ? "Kiki is using a mock Drive. Open Kiki to set up the renovation folder." : driveReady ? "Open a Google Drive folder in this tab, and I'll offer to organize it." : null,
    autoText: ws ? { on: autoTextOn } : null,
    // What Kiki noticed in the folder; the app has the details and the actions.
    attention: (Array.isArray(v.attention) ? v.attention : []).slice(0, 4).map((a) => ({ title: String(a.title ?? ""), detail: a.detail ? String(a.detail) : null, chip: ATTENTION_CHIP[a.kind] ?? null })),
    attentionMore: Math.max(0, (Array.isArray(v.attention) ? v.attention.length : 0) - 4),
    events: (Array.isArray(v.activity?.events) ? v.activity.events : []).slice(0, 30).map((e) => ({ time: formatTime(e.at, now), message: String(e.message ?? "") })),
  };
}
