// The Chrome side panel's pure helpers (extension/lib.js): Drive addresses, safe links, wording and the view model.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../extension/lib.js";

const { driveFolderId, folderLink, safeLink, tabFolderName, place, cleanCode, foText, buildModel, plural, formatTime } = lib;

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
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "waiting", text: null, source: null } })).label, 'Fo reports it texted you. Reply "go ahead" to file it, or approve here.');
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "approved", text: "go ahead", source: "text_reply" } })).label, 'You replied "go ahead". Kiki is filing it.');
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "declined", text: "not now", source: "text_reply" } })).label, 'You replied "not now". Not filing it.');
  assert.equal(foText(note({ purpose: "done", outcome: "reported_sent" })).label, "Fo reports it texted you that it's done.");
  assert.equal(foText(note({ purpose: "summary", outcome: "reported_sent" })).label, "Fo reports it sent you the note.");
  assert.equal(foText(note({ outcome: "reported_sent", reply: { status: "expired", text: null, source: null } })).label, "No reply yet. You can approve here.");
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

test("buildModel: approve label counts runnable steps; a running plan blocks switching", () => {
  const ops = [
    { seq: 1, kind: "create_folder", state: "pending", title: 'Create the "Invoices" folder', before: null, after: { name: "Invoices", path: "Renovations/Flooring" }, reason: "r1", error: null, editable: false },
    { seq: 2, kind: "move_rename", state: "pending", title: "Move and rename", before: { name: "a.pdf", path: "" }, after: { name: "b.pdf", path: "Renovations/Flooring/Invoices" }, reason: "Because.", error: null, editable: true },
    { seq: 3, kind: "move_rename", state: "excluded", title: "Rename", before: { name: "c.pdf", path: "" }, after: { name: "d.pdf", path: "" }, reason: "r3", error: null, editable: true },
  ];
  const plan = { id: "p1", version: 2, kind: "organize", status: "proposed", title: "File the new document", summary: "Kiki would move 1 file.", contentHash: "h1", createdAt: "", approvedAt: null, finishedAt: null, ops, notes: [], diff: null, evidence: null, conflict: null, counts: { pending: 2, running: 0, verified: 0, failed: 0, stale: 0, skipped: 0, uncertain: 0, excluded: 1, total: 3 }, canUndo: false, canResume: false };
  let m = buildModel(baseView({ plans: [plan] }));
  assert.equal(m.proposed.count, 2);
  assert.equal(m.proposed.key, "p1:h1");
  assert.deepEqual(m.proposed.steps[1], { seq: 2, title: "Move and rename", from: "a.pdf", to: "Renovations / Flooring / Invoices / b.pdf", reason: "Because.", state: "pending", stateLabel: "Proposed", tone: "plain", error: null });
  assert.equal(m.proposed.steps[0].reason, null, "folder steps don't repeat their title as a reason");
  assert.equal(m.check, null);
  const running = { ...plan, status: "executing", counts: { ...plan.counts, verified: 1 } };
  m = buildModel(baseView({ plans: [running] }), { tab: { url: "https://drive.google.com/drive/folders/OTHERfolder123" } });
  assert.equal(m.running.label, "Applying… 1 of 2 verified so far.");
  assert.equal(m.offer.state, "busy");
  const applied = { ...plan, status: "applied", finishedAt: new Date().toISOString(), counts: { ...plan.counts, pending: 0, verified: 2 } };
  m = buildModel(baseView({ plans: [applied] }));
  assert.equal(m.done.label, "Done: 2 of 2 changes verified in Drive.");
  assert.equal(m.check.label, "Check for anything new");
  const partial = { ...plan, status: "partial", canResume: true, ops: ops.map((o) => (o.seq === 2 ? { ...o, state: "failed", error: "Drive said no." } : { ...o, state: o.state === "excluded" ? "excluded" : "verified" })), counts: { ...plan.counts, pending: 0, verified: 1, failed: 1 } };
  m = buildModel(baseView({ plans: [partial] }));
  assert.equal(m.done.label, "Partly done: 1 of 2 changes verified in Drive.");
  assert.equal(m.broken.action, "resume");
  assert.equal(m.broken.error, "Drive said no.");
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
