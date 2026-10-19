// The Chrome side panel itself (extension/panel.js and ui.js), on a small fake DOM against a fake
// Kiki: pairing, approving the exact version on screen, answering Fo, correcting a texted plan,
// and forgetting the pairing from Settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../extension/panel.js";
import { fakeDocument } from "./fake-dom.mjs";

const KIKI = "http://localhost:8787";
const HTML = fs.readFileSync(new URL("../extension/panel.html", import.meta.url), "utf8");

/** The parts of panel.html the script uses (checked against the real file below). */
const page = () =>
  fakeDocument([
    [
      "div",
      { class: "app" },
      ["header", { class: "top" }, ["span", { id: "avatar" }], ["div", {}, ["h1", {}, "kiki"], ["p", { role: "status", "aria-live": "polite" }, ["span", { id: "status-text" }], ["span", { id: "status-said" }]]]],
      ["main", { id: "screen" }],
    ],
  ]);

function fakeChrome(initial = {}) {
  const data = new Map(Object.entries(initial));
  const listeners = [];
  const keys = (k) => (Array.isArray(k) ? k : [k]);
  const fire = (changes) => setTimeout(() => listeners.forEach((f) => f(changes, "local")), 0);
  return {
    data,
    storage: {
      local: {
        get: async (k) => Object.fromEntries(keys(k).filter((x) => data.has(x)).map((x) => [x, data.get(x)])),
        set: async (o) => {
          const changes = {};
          for (const [k, v] of Object.entries(o)) (changes[k] = { oldValue: data.get(k), newValue: v }), data.set(k, v);
          fire(changes);
        },
        remove: async (k) => {
          const changes = {};
          for (const x of keys(k)) if (data.has(x)) (changes[x] = { oldValue: data.get(x) }), data.delete(x);
          if (Object.keys(changes).length) fire(changes);
        },
      },
      onChanged: { addListener: (f) => listeners.push(f) },
    },
    tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  };
}

const PLAN = {
  id: "p1",
  version: 1,
  kind: "organize",
  status: "proposed",
  title: 'Organize "Receipts"',
  summary: "",
  contentHash: "h1",
  createdAt: new Date().toISOString(),
  approvedAt: null,
  finishedAt: null,
  ops: [{ seq: 1, kind: "move_rename", state: "pending", title: "Move and rename", before: { name: "scan.pdf", path: "" }, after: { name: "2026-10-01 Receipt.pdf", path: "Receipts" }, reason: "", error: null, editable: true }],
  notes: [],
  diff: null,
  evidence: null,
  conflict: null,
  counts: { pending: 1, running: 0, verified: 0, failed: 0, stale: 0, skipped: 0, uncertain: 0, excluded: 0, total: 1 },
  canUndo: false,
  canResume: false,
};

/** A Kiki with one pairing key, recording every request. */
function fakeKiki({ notifications = [] } = {}) {
  const sent = [];
  const approvals = [];
  const replies = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const view = () => ({
    notifications,
    integrations: { drive: { mode: "live", connection: "connected", missingScopes: [] }, fo: { mode: "live", connection: "connected" } },
    settings: { autoText: false },
    workspace: { name: "Receipts", mode: "live", link: "https://drive.google.com/drive/folders/AbCdEfGhIjKl", lastInventoryAt: new Date().toISOString() },
    inventory: { status: "done", reading: 0, files: [] },
    plans: [PLAN],
    attention: [],
    activity: { events: [] },
    busy: { inventory: false, reading: false, executing: false, interpreting: false },
    kiki: { state: "needs_approval", label: "I have a plan." },
    extension: { paired: true },
  });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    if (u.origin !== KIKI) throw new TypeError("Failed to fetch");
    const auth = init.headers?.authorization ?? null;
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push({ path: u.pathname, method: init.method, auth, body });
    if (init.method === "HEAD") return new Response(null, { status: 404 });
    if (u.pathname === "/api/extension/pair") return body?.code === "123456" ? json(200, { token: "key" }) : json(403, { error: "That code isn't right." });
    if (auth !== "Bearer key") return json(401, { error: "Pair this side panel with Kiki first.", code: "not_paired" });
    if (u.pathname === "/api/state") return json(200, view());
    if (u.pathname === "/api/plans/p1/approve") return approvals.push(body), json(200, { ok: true });
    const reply = /^\/api\/tasks\/([^/]+)\/reply$/.exec(u.pathname);
    if (reply) return replies.push({ taskId: reply[1], ...body }), json(200, { ok: true });
    return json(404, { error: "Not found." });
  }
  return { fetch, sent, approvals, replies };
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 4));
};
const $ = (doc, key) => doc.querySelector(`[data-key="${key}"]`);
const text = (doc, sel) => doc.querySelector(sel)?.textContent ?? "";

test("panel.html has what the script looks for: the screen, Kiki's face, and one live status line", () => {
  for (const id of ["screen", "avatar", "status-text", "status-said"]) assert.match(HTML, new RegExp(`id="${id}"`), id);
  assert.equal(HTML.match(/aria-live=/g)?.length, 1, "one live region");
  assert.match(HTML, /name="color-scheme" content="light dark"/, "follows the system theme");
});

test("the panel pairs, approves the exact version on screen with one request id, and forgets the pairing from Settings", async () => {
  const doc = page();
  const chrome = fakeChrome();
  const kiki = fakeKiki();
  const panel = start({ doc, chromeApi: chrome, fetchFn: kiki.fetch, refreshMs: 60_000 });
  try {
    await settle();
    assert.equal(text(doc, "#status-text"), "Let's pair this side panel.");
    doc.querySelector("#code").value = "123 456";
    $(doc, "pair").click();
    await settle();
    assert.deepEqual(
      kiki.sent.find((s) => s.path === "/api/extension/pair"),
      { path: "/api/extension/pair", method: "POST", auth: null, body: { code: "123456" } },
    );
    assert.equal(chrome.data.get("kikiToken"), "key");
    assert.equal(text(doc, "#status-text"), "I have a plan.");
    assert.match(text(doc, "#screen"), /Needs you.*Proposed plan.*scan\.pdf.*2026-10-01 Receipt\.pdf.*into Receipts.*Nothing changes until you approve/);

    const approve = $(doc, "approve");
    assert.equal(approve.textContent, "Approve 1 change");
    approve.click();
    approve.click();
    await settle();
    assert.equal(kiki.approvals.length, 1, "a double click sends one approval");
    assert.equal(kiki.approvals[0].contentHash, "h1");
    assert.match(text(doc, "#status-said"), /Approved/, "the result is announced in the one live region");
    $(doc, "approve").click();
    await settle();
    assert.equal(kiki.approvals[1].clientRequestId, kiki.approvals[0].clientRequestId, "approving the same version again is the same approval");

    $(doc, "settings").click();
    await settle();
    assert.equal(doc.activeElement, $(doc, "settings-title"), "focus moves to Settings");
    assert.match(text(doc, "#screen"), /Paired with Kiki on this computer/);
    $(doc, "forget").click();
    await settle();
    assert.equal(chrome.data.has("kikiToken"), false);
    assert.equal(text(doc, "#status-text"), "Let's pair this side panel.");
    assert.match(text(doc, "#screen"), /This browser forgot the pairing/);
  } finally {
    panel.stop();
  }
});

test("Fo's question is answered in the panel, and a correction to a texted plan goes back through Fo", async () => {
  const question = { taskId: "t9", purpose: "summary", planId: null, reply: null, mode: "live", state: "needs_user_input", outcome: null, question: "Which number should I text?", createdAt: new Date().toISOString() };
  const doc = page();
  const kiki = fakeKiki({ notifications: [question] });
  const panel = start({ doc, chromeApi: fakeChrome({ kikiToken: "key" }), fetchFn: kiki.fetch, refreshMs: 60_000 });
  try {
    await settle();
    assert.match(text(doc, "#screen"), /Fo has a question\..*Which number should I text\?/);
    $(doc, "send-answer").click();
    await settle();
    assert.equal(kiki.replies.length, 0, "an empty answer isn't sent");
    $(doc, "answer-t9").value = "The one ending 42";
    $(doc, "send-answer").click();
    await settle();
    assert.deepEqual(kiki.replies, [{ taskId: "t9", answer: "The one ending 42" }]);
    assert.equal(kiki.approvals.length, 0, "answering approves nothing");
  } finally {
    panel.stop();
  }

  const texted = { ...question, taskId: "t1", purpose: "find", planId: "p1", state: "complete", outcome: "reported_sent", question: null, reply: { status: "waiting", text: null, source: null } };
  const doc2 = page();
  const kiki2 = fakeKiki({ notifications: [texted] });
  const panel2 = start({ doc: doc2, chromeApi: fakeChrome({ kikiToken: "key" }), fetchFn: kiki2.fetch, refreshMs: 60_000 });
  try {
    await settle();
    assert.match(text(doc2, "#screen"), /Fo reports it texted you about it\. Reply there, or decide here\./);
    $(doc2, "correct").click();
    await settle();
    assert.equal(doc2.activeElement, $(doc2, "correction"));
    $(doc2, "correction").value = "Put it in Travel";
    $(doc2, "send-correction").click();
    await settle();
    assert.deepEqual(kiki2.replies, [{ taskId: "t1", answer: "Put it in Travel" }]);
    assert.equal(kiki2.approvals.length, 0, "a correction approves nothing");
  } finally {
    panel2.stop();
  }
});

test("without a request from Fo, the plan offers Open in Kiki; every link goes to Kiki or Drive", async () => {
  const doc = page();
  const kiki = fakeKiki();
  const panel = start({ doc, chromeApi: fakeChrome({ kikiToken: "key" }), fetchFn: kiki.fetch, refreshMs: 60_000 });
  try {
    await settle();
    assert.equal($(doc, "correct"), null);
    const links = doc.querySelectorAll("a").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("rel")]);
    assert.ok(links.some(([t, href]) => t === "Open in Kiki" && href === `${KIKI}/`), JSON.stringify(links));
    assert.ok(links.some(([t, href]) => t === "Open Kiki" && href === `${KIKI}/`));
    for (const [, href, rel] of links) {
      assert.match(href, /^(http:\/\/localhost:8787\/|https:\/\/drive\.google\.com\/)/);
      assert.equal(rel, "noopener noreferrer");
    }
  } finally {
    panel.stop();
  }
});
