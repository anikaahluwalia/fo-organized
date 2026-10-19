// Kiki's toolbar button (extension/background.js), run against a fake browser: a side panel where
// the browser shows one (Chrome), a window where it opens the panel but never shows it (Arc), and a
// popup where there's no side panel API at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SRC = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const FAST = 50; // timers run 50x faster than written

/** sidePanel: "shows" (Chrome), "never-shows" (API there, nothing displayed), "missing" (no API). */
function browser({ sidePanel = "shows", windows = "work" } = {}) {
  const on = { clicked: [], connect: [], removed: [] };
  const calls = [];
  const session = new Map();
  const chrome = {
    runtime: { onConnect: { addListener: (f) => on.connect.push(f) } },
    action: { onClicked: { addListener: (f) => on.clicked.push(f) }, setPopup: (o) => calls.push(["setPopup", o.popup]) },
    windows: {
      create: async (o) => {
        if (windows !== "work") throw new Error("no windows here");
        calls.push(["windows.create", o.url, o.type]);
        return { id: 99 };
      },
      update: async (id) => {
        calls.push(["windows.update", id]);
        return {};
      },
      onRemoved: { addListener: (f) => on.removed.push(f) },
    },
    tabs: { create: async (o) => calls.push(["tabs.create", o.url]) },
    storage: {
      session: {
        get: async (k) => ({ [k]: session.get(k) }),
        set: async (o) => Object.entries(o).forEach(([k, v]) => session.set(k, v)),
        remove: async (k) => session.delete(k),
      },
    },
  };
  /** A panel page loading in a window's side panel and reporting in. */
  const panelLoads = (windowId, visible = true) => {
    const msg = [];
    const gone = [];
    const port = { name: "kiki-panel", onMessage: { addListener: (f) => msg.push(f) }, onDisconnect: { addListener: (f) => gone.push(f) } };
    on.connect.forEach((f) => f(port));
    msg.forEach((f) => f({ view: "side", windowId, visible }));
    return { closes: () => gone.forEach((f) => f()) };
  };
  if (sidePanel !== "missing") {
    chrome.sidePanel = {
      setPanelBehavior: async (o) => calls.push(["setPanelBehavior", o.openPanelOnActionClick]),
      open: async ({ windowId }) => {
        calls.push(["sidePanel.open", windowId]);
        if (sidePanel === "shows") setTimeout(() => panelLoads(windowId), 10);
      },
      close: async ({ windowId }) => calls.push(["sidePanel.close", windowId]),
    };
  }
  const ctx = vm.createContext({ chrome, console, setTimeout: (f, ms) => setTimeout(f, ms / FAST), clearTimeout });
  vm.runInContext(SRC, ctx);
  const click = (windowId = 1) => on.clicked.forEach((f) => f({ windowId }));
  return { calls, click, panelLoads, session, windowClosed: (id) => on.removed.forEach((f) => f(id)) };
}

const settle = () => new Promise((r) => setTimeout(r, 2600 / FAST + 30));
const names = (calls) => calls.map((c) => c[0]);

test("Chrome: the button opens the side panel, and closes it when it's open", async () => {
  const b = browser();
  assert.deepEqual(b.calls[0], ["setPanelBehavior", false], "clicks come to Kiki, not straight to the panel");
  b.click(1);
  await settle();
  assert.deepEqual(names(b.calls).slice(1), ["sidePanel.open"]);
  b.click(1);
  await settle();
  assert.deepEqual(b.calls.at(-1), ["sidePanel.close", 1], "a second click closes it");
  assert.equal(b.calls.some((c) => c[0] === "windows.create"), false, "no extra window");
});

test("a browser that opens the side panel but never shows it (Arc) gets Kiki in a separate window, once", async () => {
  const b = browser({ sidePanel: "never-shows" });
  b.click(1);
  await settle();
  assert.deepEqual(b.calls.at(-1), ["windows.create", "panel.html?view=window", "popup"]);
  b.click(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(b.calls.at(-1), ["windows.update", 99], "the next click brings that window forward, without waiting");
  b.windowClosed(99);
  b.click(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(b.calls.at(-1), ["windows.create", "panel.html?view=window", "popup"], "closed: a new one opens");
});

test("a browser without the side panel API shows Kiki as the button's popup", () => {
  const b = browser({ sidePanel: "missing" });
  assert.deepEqual(b.calls, [["setPopup", "panel.html?view=popup"]]);
});

test("where windows can't be made, Kiki opens in a tab", async () => {
  const b = browser({ sidePanel: "never-shows", windows: "fail" });
  b.click(1);
  await settle();
  assert.deepEqual(b.calls.at(-1), ["tabs.create", "panel.html?view=window"]);
});

test("a panel that was closed is opened again (not 'closed' again) on the next click", async () => {
  const b = browser();
  const panel = b.panelLoads(1);
  b.click(1);
  await settle();
  assert.deepEqual(b.calls.at(-1), ["sidePanel.close", 1]);
  panel.closes();
  b.click(1);
  await settle();
  assert.deepEqual(b.calls.filter((c) => c[0] === "sidePanel.open").length, 1);
  assert.equal(b.calls.some((c) => c[0] === "windows.create"), false);
});

test("a panel that shows up after all clears Arc mode, so the next click goes back to the side panel", async () => {
  const b = browser({ sidePanel: "never-shows" });
  b.click(1);
  await settle();
  assert.equal(b.session.get("sidePanelNeverShows"), true);
  b.panelLoads(2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.session.has("sidePanelNeverShows"), false);
});
