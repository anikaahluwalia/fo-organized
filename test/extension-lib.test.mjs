// The Chrome side panel's pure helpers (extension/lib.js): Drive addresses, safe links, wording and the view model.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../extension/lib.js";

const { driveFolderId, folderLink, safeLink, tabFolderName, place, cleanCode, foText, buildModel, changeRows, plural, formatTime } = lib;

const ID = "1AbCdEfGhIjKlMnOp_qr-ST";

test("driveFolderId reads the folder ID from Drive folder addresses only", () => {
  const yes = [
    `https://drive.google.com/drive/folders/${ID}`,
    `https://drive.google.com/drive/folders/${ID}/`,
    `https://drive.google.com/drive/folders/${ID}?usp=sharing`,
    `https://drive.google.com/drive/folders/${ID}?resourcekey=0-abc#grid`,
    `https://drive.google.com/drive/u/0/folders/${ID}`,
    `https://drive.google.com/drive/u/12/folders/${ID}?ths=true`,
  ];
  for (const url of yes) assert.equal(driveFolderId(url), ID, url);
  const no = [
    null,
    undefined,
    "",
    "not a url",
    "https://drive.google.com/drive/my-drive",
    "https://drive.google.com/drive/u/0/my-drive",
    "https://drive.google.com/drive/shared-with-me",
    `https://drive.google.com/file/d/${ID}/view`,
    `https://drive.google.com/open?id=${ID}`,
    `http://drive.google.com/drive/folders/${ID}`,
    `https://drive.google.com.evil.example/drive/folders/${ID}`,
    `https://evil.example/drive.google.com/drive/folders/${ID}`,
    `https://user@drive.google.com/drive/folders/${ID}`,
    `https://drive.google.com:8443/drive/folders/${ID}`,
    `https://docs.google.com/drive/folders/${ID}`,
    "https://drive.google.com/drive/folders/short",
    `https://drive.google.com/drive/folders/${ID}/extra`,
    `https://drive.google.com/drive/u/x/folders/${ID}`,
    `https://drive.google.com/drive/folders/${ID}%2F..`,
    `javascript:alert(1)//drive.google.com/drive/folders/${ID}`,
  ];
  for (const url of no) assert.equal(driveFolderId(url), null, String(url));
});

test("folderLink builds the plain folder address the server parses", () => {
  assert.equal(folderLink(ID), `https://drive.google.com/drive/folders/${ID}`);
  assert.equal(driveFolderId(folderLink(ID)), ID);
});

test("safeLink only lets Kiki and https Drive or Docs pages become links", () => {
  assert.equal(safeLink(`https://drive.google.com/drive/folders/${ID}`), `https://drive.google.com/drive/folders/${ID}`);
  assert.equal(safeLink("https://docs.google.com/document/d/x/edit"), "https://docs.google.com/document/d/x/edit");
  assert.equal(safeLink("http://localhost:8787/"), "http://localhost:8787/");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "http://drive.google.com/x", "https://drive.google.com.evil.example/", "https://evil.example/", "http://localhost:8788/", "http://127.0.0.1:8787/", "https://a@drive.google.com/", "//drive.google.com/x", null, 42]) {
    assert.equal(safeLink(bad), null, String(bad));
  }
});

test("tabFolderName strips Drive's suffix and refuses empty titles", () => {
  assert.equal(tabFolderName("Q3 receipts - Google Drive"), "Q3 receipts");
  assert.equal(tabFolderName("Q3 receipts – Google Drive"), "Q3 receipts");
  assert.equal(tabFolderName("Google Drive"), null);
  assert.equal(tabFolderName("  - Google Drive"), null);
  assert.equal(tabFolderName(null), null);
  assert.equal(tabFolderName("x".repeat(300)).length, 120);
});

test("place joins a workspace path and name for display", () => {
  assert.equal(place({ name: "a.pdf", path: "" }), "a.pdf");
  assert.equal(place({ name: "a.pdf", path: "Renovations/Flooring/Invoices" }), "Renovations / Flooring / Invoices / a.pdf");
  assert.equal(place(null), null);
});

test("cleanCode accepts six digits with spaces or a dash, nothing else", () => {
  assert.equal(cleanCode("123456"), "123456");
  assert.equal(cleanCode(" 123 456 "), "123456");
  assert.equal(cleanCode("123-456"), "123456");
  for (const bad of ["12345", "1234567", "12a456", "", null, "１２３４５６"]) assert.equal(cleanCode(bad), null, String(bad));
});

test("plural and formatTime", () => {
  assert.equal(plural(1, "change"), "1 change");
  assert.equal(plural(3, "change"), "3 changes");
  assert.equal(formatTime(null), "");
  assert.equal(formatTime("nope"), "");
  const now = new Date("2026-10-17T21:00:00");
  assert.doesNotMatch(formatTime("2026-10-17T20:41:00", now), /Oct/);
  assert.match(formatTime("2026-10-16T20:41:00", now), /Oct 16/);
});

const note = (over) => ({ taskId: "t", purpose: "find", reply: null, mode: "live", state: "complete", outcome: null, text: "Kiki: a new invoice…", progress: null, question: null, failureDetail: null, finalResponse: null, createdAt: new Date().toISOString(), ...over });

test("foText keeps Fo's reports labelled as reports, and names Mock Fo", () => {
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "waiting", text: null, source: null } })).label, "Fo reports it texted you about it. Reply there, or decide here.");
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "approved", text: "go ahead", source: "text_reply" } })).label, 'You replied "go ahead". Kiki is filing it.');
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "declined", text: "not now", source: "text_reply" } })).label, 'You replied "not now". Not filing it.');
  assert.equal(foText(note({ purpose: "done", outcome: "reported_sent" })).label, "Fo reports it texted you that it's done.");
  assert.equal(foText(note({ purpose: "summary", outcome: "reported_sent" })).label, "Fo reports it sent you the note.");
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "expired", text: null, source: null } })).label, "This request expired before a decision came back. Ask again from the Kiki app.");
  assert.equal(foText(note({ state: "failed", failureDetail: "Fo is offline" })).label, "The text wasn't sent.");
  assert.equal(foText(note({ state: "failed", failureDetail: "Fo is offline" })).more, "Fo is offline");
  assert.equal(foText(note({ state: "uncertain" })).label, "Not sure the text went out.");
  assert.equal(foText(note({ state: "needs_user_input", question: "Which number?" })).more, "Which number?");
  assert.equal(foText(note({ state: "complete", outcome: "not_sent" })).label, "Fo says it didn't send the text.");
  const working = foText(note({ mode: "mock", state: "working", progress: "Sending the text" }));
  assert.equal(working.label, "Mock Fo is texting you…");
  assert.equal(working.progress, "Sending the text");
  assert.equal(working.fo, "Mock Fo");
});

const baseView = (over = {}) => ({
  notifications: [],
  integrations: { drive: { mode: "live", connection: "connected", account: "a@b.c", scopes: "full", missingScopes: [] }, claude: { mode: "live", credentialsDetected: true, model: "m" }, fo: { mode: "live", connection: "connected" } },
  settings: { userName: null, autoText: false },
  workspace: { name: "Renovation paperwork", origin: "selected", mode: "live", link: `https://drive.google.com/drive/folders/${ID}`, lastInventoryAt: new Date().toISOString() },
  inventory: { status: "done", lastError: null, reading: 0, files: [{ fileId: "F1sub0000000", name: "Invoices", path: "Renovations/Flooring", kind: "folder", origin: "created_by_kiki", link: null, doc: null, isNew: false }, { fileId: "f2", name: "a.pdf", path: "", kind: "file", origin: "found", link: null, doc: null, isNew: false }] },
  plans: [],
  index: [],
  outreach: [],
  updates: [],
  activity: { events: [{ at: new Date().toISOString(), kind: "plan", message: "Kiki proposed." }], turns: [] },
  busy: { inventory: false, reading: false, executing: false, interpreting: false },
  kiki: { state: "idle", label: "Ready when you are." },
  ...over,
});

test("buildModel: the Drive tab offer depends on where the tab is", () => {
  const other = `https://drive.google.com/drive/u/0/folders/OTHERfolder123`;
  let m = buildModel(baseView(), { tab: { url: other, title: "Q3 receipts - Google Drive" } });
  assert.deepEqual(m.offer, { folderId: "OTHERfolder123", url: "https://drive.google.com/drive/folders/OTHERfolder123", title: "Q3 receipts", state: "switch", from: "Renovation paperwork" });
  m = buildModel(baseView({ workspace: null }), { tab: { url: other, title: null } });
  assert.equal(m.offer.state, "ready");
  m = buildModel(baseView(), { tab: { url: `https://drive.google.com/drive/folders/${ID}`, title: "Renovation paperwork - Google Drive" } });
  assert.equal(m.offer, null);
  assert.equal(m.here, "This tab shows the workspace folder.");
  m = buildModel(baseView(), { tab: { url: "https://drive.google.com/drive/folders/F1sub0000000", title: "Invoices - Google Drive" } });
  assert.equal(m.offer, null);
  assert.equal(m.here, "This tab shows Renovations / Flooring / Invoices in this workspace.");
  m = buildModel(baseView(), { tab: { url: "https://example.com/", title: "x" } });
  assert.equal(m.offer, null);
  assert.equal(m.here, null);
  const mock = baseView({ integrations: { ...baseView().integrations, drive: { mode: "mock", connection: "connected", account: null, scopes: "narrow", missingScopes: [] } } });
  assert.equal(buildModel(mock, { tab: { url: other } }).offer.state, "mock");
  const noAuth = baseView({ integrations: { ...baseView().integrations, drive: { mode: "live", connection: "needs_auth", account: null, scopes: "full", missingScopes: [] } } });
  assert.equal(buildModel(noAuth, { tab: { url: other } }).offer.state, "needs_drive");
  assert.equal(buildModel(noAuth).alerts[0].title, "Google Drive isn't connected.");
});

const OPS = [
  { seq: 1, kind: "create_folder", state: "pending", title: 'Create the "Invoices" folder', before: null, after: { name: "Invoices", path: "Renovations/Flooring" }, reason: "r1", error: null, editable: false },
  { seq: 2, kind: "move_rename", state: "pending", title: "Move and rename", before: { name: "a.pdf", path: "" }, after: { name: "b.pdf", path: "Renovations/Flooring/Invoices" }, reason: "Because.", error: null, editable: true },
  { seq: 3, kind: "move_rename", state: "excluded", title: "Rename", before: { name: "c.pdf", path: "" }, after: { name: "d.pdf", path: "" }, reason: "r3", error: null, editable: true },
];
const PLAN = { id: "p1", version: 2, kind: "organize", status: "proposed", title: "File the new document", summary: "Kiki would move 1 file.", contentHash: "h1", createdAt: "", approvedAt: null, finishedAt: null, ops: OPS, notes: [], diff: null, evidence: null, conflict: null, counts: { pending: 2, running: 0, verified: 0, failed: 0, stale: 0, skipped: 0, uncertain: 0, excluded: 1, total: 3 }, canUndo: false, canResume: false };

test("buildModel: a proposed plan is one row per change, old name → new name and folder, as in the app", () => {
  const m = buildModel(baseView({ plans: [PLAN] }));
  assert.equal(m.proposed.key, "p1:h1");
  assert.equal(m.proposed.contentHash, "h1", "approving sends the exact version on screen");
  assert.equal(m.proposed.type, "Revised plan, version 2", "labelled as proposed, not done");
  assert.deepEqual(m.proposed.rows, [{ seq: 2, title: null, from: "a.pdf", to: "b.pdf", where: "into Renovations / Flooring / Invoices, a new folder", state: "pending", stateLabel: "Proposed", tone: "plain", error: null }], "the new folder is folded into the move; the excluded step isn't listed");
  assert.equal(m.proposed.count, 1, "Approve counts the changes listed, like the app's Approve N changes");
  assert.equal(m.check, null);
  // A move into a folder that already exists says so plainly; a rename alone has no folder line.
  const plain = changeRows({ ops: [{ ...OPS[1], after: { name: "b.pdf", path: "Receipts" } }, { ...OPS[2], state: "pending" }] });
  assert.equal(plain[0].where, "into Receipts");
  assert.deepEqual([plain[1].from, plain[1].to, plain[1].where], ["c.pdf", "d.pdf", null]);
  // A new folder nothing moves into is a change of its own.
  assert.deepEqual(changeRows({ ops: [OPS[0]] }).map((r) => [r.title, r.to]), [["Make a new folder", "Renovations / Flooring / Invoices"]]);
});

test("buildModel: while Kiki applies a plan, one Working on it line, and switching folders waits", () => {
  const running = { ...PLAN, status: "executing", counts: { ...PLAN.counts, verified: 1 } };
  const m = buildModel(baseView({ plans: [running] }), { tab: { url: "https://drive.google.com/drive/folders/OTHERfolder123" } });
  assert.equal(m.running.label, "Applying… 1 of 2 steps verified so far.", "the excluded step isn't counted");
  assert.deepEqual(m.working, { label: "Applying… 1 of 2 steps verified so far.", detail: null });
  assert.equal(m.proposed, null);
  assert.equal(m.offer.state, "busy");
  assert.equal(buildModel(baseView({ inventory: { ...baseView().inventory, reading: 3 } })).working.label, "Reading 3 files…");
  assert.equal(buildModel(baseView()).working, null, "nothing happening, no line");
});

test("buildModel: Recent says honestly how each finished plan ended, newest first", () => {
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const applied = { ...PLAN, id: "a", status: "applied", finishedAt: at(1), counts: { ...PLAN.counts, pending: 0, verified: 2 } };
  const declined = { ...PLAN, id: "d", status: "discarded", finishedAt: at(5) };
  const failed = { ...PLAN, id: "f", status: "failed", finishedAt: at(9), counts: { ...PLAN.counts, pending: 0, failed: 2 } };
  const replaced = { ...PLAN, id: "s", status: "superseded", finishedAt: at(2) };
  let m = buildModel(baseView({ plans: [declined, replaced, failed, applied], kiki: { state: "verified", label: "All done." } }));
  assert.deepEqual(
    m.recent.map((r) => [r.id, r.label, r.tone]),
    [
      ["a", "Applied and verified", "ok"],
      ["d", "You said no", "muted"],
    ],
    "the failed plan needs you (Try again), so it's under Needs you, not Recent; a replaced version isn't listed",
  );
  assert.deepEqual(m.recent[0].counts, { verified: 2, total: 2 }, "applied: every step meant to run was read back (the excluded one isn't counted)");
  assert.equal(m.broken.id, "f");
  assert.equal(m.check.label, "Check for anything new");
  // With a plan waiting, a stopped one is history: Recent says it didn't finish.
  const partial = { ...PLAN, id: "p", status: "partial", finishedAt: at(3), counts: { ...PLAN.counts, pending: 0, verified: 1, failed: 1 } };
  m = buildModel(baseView({ plans: [{ ...PLAN, id: "new" }, partial, failed] }));
  assert.equal(m.broken, null);
  assert.deepEqual(
    m.recent.map((r) => r.label),
    ["Partly applied: 1 of 2 steps verified in Drive", "Failed: 0 of 2 steps verified in Drive"],
  );
  const mock = baseView({ plans: [{ ...PLAN, id: "new" }, partial], integrations: { ...baseView().integrations, drive: { mode: "mock", connection: "connected", account: null, scopes: "narrow", missingScopes: [] } } });
  assert.equal(buildModel(mock).recent[0].label, "Partly applied: 1 of 2 steps verified in the mock Drive");
  const many = Array.from({ length: 7 }, (_, i) => ({ ...applied, id: `x${i}`, finishedAt: at(i) }));
  assert.equal(buildModel(baseView({ plans: many })).recent.length, 4, "the last few, not all");
});

test("buildModel: a plan that stopped needs you, with the steps that didn't finish", () => {
  const partial = { ...PLAN, status: "partial", canResume: true, ops: OPS.map((o) => (o.seq === 2 ? { ...o, state: "failed", error: "Drive said no." } : { ...o, state: o.state === "excluded" ? "excluded" : "verified" })), counts: { ...PLAN.counts, pending: 0, verified: 1, failed: 1 } };
  const m = buildModel(baseView({ plans: [partial] }));
  assert.equal(m.broken.type, "Partly applied");
  assert.equal(m.broken.action, "resume");
  assert.equal(m.broken.actionLabel, "Try again");
  assert.equal(m.broken.error, "Drive said no.");
  assert.deepEqual(
    m.broken.steps.map((s) => [s.from, s.stateLabel, s.error]),
    [["a.pdf", "Failed", "Drive said no."]],
    "the verified folder isn't listed as unfinished",
  );
  assert.deepEqual(m.recent, []);
  const stale = buildModel(baseView({ plans: [{ ...partial, status: "stale", canResume: false }] }));
  assert.deepEqual([stale.broken.heading, stale.broken.action, stale.broken.actionLabel], ["Something changed since the plan was made.", "refresh", "Refresh the plan"]);
});

test("buildModel: Fo's question is answered here; a problem with a text needs you; a text on its way is a Working line", () => {
  const ask = note({ taskId: "t9", purpose: "summary", planId: null, state: "needs_user_input", question: "Which number should I text?" });
  let m = buildModel(baseView({ notifications: [ask] }));
  assert.deepEqual(m.question, { taskId: "t9", fo: "Fo", question: "Which number should I text?", time: m.question.time, planId: null });
  assert.equal(m.fo, null);
  // Kiki is already acting on an answer: nothing to answer here, and the app has the details.
  m = buildModel(baseView({ notifications: [{ ...ask, purpose: "decide", planId: "p1", reply: { status: "adjusting", text: "skip it", source: null } }], plans: [PLAN] }));
  assert.equal(m.question, null);
  assert.equal(m.fo.label, "Fo has a question. Answer it in the Kiki app.");
  assert.equal(m.fo.openKiki, true);
  m = buildModel(baseView({ notifications: [note({ purpose: "summary", state: "failed", failureDetail: "Fo is offline" })] }));
  assert.deepEqual([m.fo.label, m.fo.more, m.fo.tone], ["The note wasn't sent.", "Fo is offline", "bad"]);
  m = buildModel(baseView({ notifications: [note({ purpose: "summary", mode: "mock", state: "working", progress: "Getting your number" })] }));
  assert.deepEqual(m.working, { label: "Mock Fo is sending you the note…", detail: "Getting your number" });
  assert.equal(m.fo, null);
  // A finished report shows with its plan, still as Fo's report.
  const applied = { ...PLAN, status: "applied", finishedAt: new Date().toISOString(), counts: { ...PLAN.counts, pending: 0, verified: 2 } };
  m = buildModel(baseView({ plans: [applied], notifications: [note({ purpose: "done", planId: "p1", outcome: "reported_sent" })] }));
  assert.equal(m.recent[0].fo, "Fo reports it texted you that it's done.");
  // A text about a plan that's gone isn't shown as if it were about the one on screen.
  m = buildModel(baseView({ plans: [{ ...PLAN, id: "p2" }], notifications: [note({ planId: "p1", state: "failed" })] }));
  assert.equal(m.fo, null);
  assert.equal(m.proposed.fo, null);
});

test("buildModel: a plan Fo texted you about can be decided here, and corrected through Fo", () => {
  const texted = note({ taskId: "t1", planId: "p1", outcome: "reported_sent", reply: { status: "waiting", text: null, source: null } });
  let m = buildModel(baseView({ plans: [PLAN], notifications: [texted] }));
  assert.equal(m.proposed.fo, "Fo reports it texted you about it. Reply there, or decide here.");
  assert.deepEqual(m.proposed.request, { taskId: "t1", fo: "Fo" });
  // While Fo is still reading the proposal, a correction can't go in yet.
  m = buildModel(baseView({ plans: [PLAN], notifications: [{ ...texted, state: "working", outcome: null }] }));
  assert.equal(m.proposed.request, null);
  m = buildModel(baseView({ plans: [PLAN] }));
  assert.equal(m.proposed.request, null, "no request from Fo: Open in Kiki instead");
});

test("buildModel: Live and Mock are labelled, for Drive and for Fo", () => {
  assert.deepEqual(buildModel(baseView()).modes, { drive: { label: "Live Drive", ok: true }, fo: { label: "Live Fo", ok: true } });
  const mock = baseView({ integrations: { drive: { mode: "mock", connection: "connected" }, fo: { mode: "mock", connection: "connected" } } });
  assert.deepEqual(buildModel(mock).modes, { drive: { label: "Mock Drive", ok: true }, fo: { label: "Mock Fo", ok: true } });
  const off = baseView({ integrations: { drive: { mode: "live", connection: "needs_auth" }, fo: { mode: "live", connection: "error" } } });
  assert.deepEqual(buildModel(off).modes, { drive: { label: "Drive not connected", ok: false }, fo: { label: "Fo problem", ok: false } });
});

test("the panel lists what Kiki noticed, with the same labels as the app, and points to the app for more", () => {
  const attention = [
    { key: "a", kind: "missing", title: "Quote Q-1042 isn't in the folder", detail: "Invoice INV-3307 refers to it." },
    { key: "b", kind: "expiring", title: "Licence BL-1 is valid until 2026-12-31", detail: "That's in 75 days." },
    { key: "c", kind: "undecided", title: "Flooring: quotes from 2 contractors", detail: null },
    { key: "d", kind: "duplicate", title: "2 files look like the same Quote Q-1", detail: null },
    { key: "e", kind: "unreadable", title: "Kiki couldn't read \"x.pdf\"", detail: null },
  ];
  const m = buildModel({ attention });
  assert.deepEqual(m.attention.map((a) => a.chip.label), ["Missing", "Soon", "Your call", "Copy?"]);
  assert.equal(m.attention[0].detail, "Invoice INV-3307 refers to it.");
  assert.equal(m.attentionMore, 1);
  assert.deepEqual(buildModel({}).attention, []);
});
