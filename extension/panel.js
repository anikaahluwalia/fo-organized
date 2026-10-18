// Kiki's side panel: a client of the Kiki app running on this computer. It shows Kiki's status,
// her latest plan and what Fo last texted you, and lets you approve or set aside a plan. The app
// does all the work; this panel never touches Google Drive itself.

import { createApi } from "./api.js";
import { KIKI_ORIGIN, REFRESH_MS, buildModel, cleanCode } from "./lib.js";
import { renderMain, renderOffline, renderPairing, renderProblem } from "./ui.js";

const TOKEN_KEY = "kikiToken";
const FLASH_MS = 8000;
/** A plan that replaced the one on screen this recently can't be approved yet: look first. */
const JUST_CHANGED_MS = 1500;

/**
 * Starts the panel in `doc`. Everything it talks to is passed in: chromeApi (storage.local and
 * tabs), fetchFn and base (the Kiki app). Returns { refresh, stop }.
 */
export function start({ doc, chromeApi, fetchFn, base = KIKI_ORIGIN, refreshMs = REFRESH_MS }) {
  const $ = (sel) => doc.querySelector(sel);
  // How this page was opened: in the browser's side panel (the default), in Kiki's own window
  // (browsers that never show extension side panels, like Arc), or as the toolbar button's popup.
  const openedAs = (() => {
    const v = new URLSearchParams(doc.location?.search ?? "").get("view");
    return v === "window" || v === "popup" ? v : "side";
  })();
  doc.documentElement?.classList.add(`as-${openedAs}`);
  const el = {
    screen: $("#screen"),
    modes: $("#modes"),
    state: $("#state-name"),
    status: $("#status"),
    detail: $("#detail"),
    foot: $("#foot"),
    kiki: $("#kiki"),
    dialog: $("#dialog"),
    forget: $("#forget"),
  };

  let token; // undefined until read from storage, then a string or null
  let screen = "loading"; // loading | pairing | offline | problem | main
  let view = null;
  let tab = null;
  let problem = null;
  let checking = false;
  const ui = { tab: "organize", busy: null, error: null, loadError: null, flash: null, flashAt: 0, confirmSwitch: null };
  const pairing = { busy: false, error: null, info: null, offline: false };
  const requestIds = new Map(); // plan id + hash -> clientRequestId, so a repeated approve is the same approval
  let shownPlan = null;
  let replacedAt = 0;
  let lastSig = null;
  let lastKiki = null;
  let pendingFocus = null;
  let timer = null;
  let stopped = false;
  let inflight = null;
  let again = false;

  // Pairing token: kept only in chrome.storage.local -------------------------------------------

  async function loadToken() {
    if (token !== undefined) return token;
    try {
      const got = await chromeApi.storage.local.get(TOKEN_KEY);
      token = typeof got?.[TOKEN_KEY] === "string" && got[TOKEN_KEY] ? got[TOKEN_KEY] : null;
    } catch {
      token = null;
    }
    return token;
  }

  async function saveToken(value) {
    await chromeApi.storage.local.set({ [TOKEN_KEY]: value });
    token = value;
  }

  async function clearToken() {
    token = null;
    try {
      await chromeApi.storage.local.remove(TOKEN_KEY);
    } catch {
      // Nothing stored, or storage is unavailable: either way there's no token now.
    }
  }

  const api = createApi({ base, fetch: fetchFn, getToken: loadToken });

  async function readTab() {
    try {
      let query = { active: true, currentWindow: true };
      // In Kiki's own window, the tab you're looking at is in your browser window, not in hers.
      if (openedAs === "window" && typeof chromeApi.windows?.getLastFocused === "function") {
        const w = await chromeApi.windows.getLastFocused({ windowTypes: ["normal"] });
        if (typeof w?.id === "number") query = { active: true, windowId: w.id };
      }
      const [t] = await chromeApi.tabs.query(query);
      // Chrome only fills in url and title for tabs this extension has host access to (Drive).
      return t && typeof t.url === "string" ? { url: t.url, title: typeof t.title === "string" ? t.title : null } : null;
    } catch {
      return null;
    }
  }

  // Drawing -------------------------------------------------------------------------------------

  const setText = (node, text) => {
    if (!node) return;
    const value = text ?? "";
    if (node.textContent !== value) node.textContent = value;
    node.hidden = !value;
  };

  function setHero(hero) {
    setText(el.modes, hero.modes);
    setText(el.state, hero.name);
    setText(el.status, hero.label);
    el.status.hidden = false;
    setText(el.detail, hero.detail);
    setText(el.foot, hero.foot);
    if (hero.state && lastKiki && hero.state !== lastKiki && el.kiki) {
      const motion = hero.state === "verified" ? "bob" : hero.state === "needs_approval" || hero.state === "needs_clarification" ? "tilt" : null;
      el.kiki.classList.remove("bob", "tilt");
      if (motion) {
        void el.kiki.offsetWidth; // restart the one-time animation
        el.kiki.classList.add(motion);
      }
    }
    if (hero.state) lastKiki = hero.state;
  }

  /**
   * Swaps the screen's content, keeping focus, typed text and open <details> by data-key. A control
   * that had focus when it was disabled (during an action) gets it back once it's enabled again.
   */
  function replaceScreen(nodes) {
    const root = el.screen;
    const active = doc.activeElement;
    const lost = !active || active === doc.body;
    const focusKey = active && root.contains(active) ? (active.closest("[data-key]")?.dataset.key ?? null) : lost ? pendingFocus : null;
    const typed = new Map([...root.querySelectorAll("input[type=text][data-key]")].map((i) => [i.dataset.key, { value: i.value, start: i.selectionStart, end: i.selectionEnd }]));
    const open = new Set([...root.querySelectorAll("details[open][data-key]")].map((d) => d.dataset.key));
    root.replaceChildren(...nodes);
    for (const input of root.querySelectorAll("input[type=text][data-key]")) {
      const t = typed.get(input.dataset.key);
      if (!t) continue;
      input.value = t.value;
      if (doc.activeElement !== input && focusKey === input.dataset.key) input.focus();
      try {
        input.setSelectionRange(t.start ?? t.value.length, t.end ?? t.value.length);
      } catch {
        // Not every input type supports a selection.
      }
    }
    for (const d of root.querySelectorAll("details[data-key]")) if (open.has(d.dataset.key)) d.open = true;
    pendingFocus = null;
    if (focusKey) {
      const target = [...root.querySelectorAll("[data-key]")].find((n) => n.dataset.key === focusKey);
      if (target && target.disabled) pendingFocus = focusKey;
      else if (target && doc.activeElement !== target) target.focus();
    }
  }

  function trackPlan(proposed) {
    const key = proposed?.key ?? null;
    if (key === shownPlan) return;
    replacedAt = key && shownPlan ? Date.now() : 0;
    shownPlan = key;
  }

  function render() {
    if (stopped) return;
    try {
      draw();
    } catch (err) {
      console.error("Kiki side panel: couldn't draw this view.", err);
      lastSig = null;
      el.screen.replaceChildren(Object.assign(doc.createElement("p"), { className: "err", textContent: `The side panel couldn't show this: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  function draw() {
    let hero;
    let sig;
    let build;
    if (screen === "main" && view) {
      const model = buildModel(view, { tab });
      trackPlan(model.proposed);
      if (ui.flash && Date.now() - ui.flashAt > FLASH_MS) ui.flash = null;
      hero = { modes: model.modes, name: model.kiki.name, label: model.kiki.label, detail: model.kiki.detail, state: model.kiki.state, foot: "Paired with Kiki on this computer." };
      sig = JSON.stringify(["main", model, ui]);
      build = () => renderMain(doc, model, ui, actions);
    } else if (screen === "pairing") {
      hero = { name: "Not paired yet", label: "Let's pair this side panel.", foot: "Kiki runs on this computer at localhost:8787." };
      sig = JSON.stringify(["pairing", pairing]);
      build = () => renderPairing(doc, pairing, actions);
    } else if (screen === "offline") {
      hero = { name: "Can't reach Kiki", label: "I can't reach Kiki on this computer.", foot: "Kiki runs on this computer at localhost:8787." };
      sig = JSON.stringify(["offline", checking]);
      build = () => renderOffline(doc, { busy: checking }, actions);
    } else if (screen === "problem") {
      hero = { name: "Error", label: "Kiki answered with an error.", foot: "Kiki runs on this computer at localhost:8787." };
      sig = JSON.stringify(["problem", problem, checking]);
      build = () => renderProblem(doc, { message: problem, busy: checking }, actions);
    } else {
      hero = { label: "Connecting to Kiki…" };
      sig = "loading";
      build = () => [];
    }
    setHero(hero);
    if (sig === lastSig) return;
    replaceScreen(build());
    lastSig = sig;
  }

  // Loading -------------------------------------------------------------------------------------

  async function unpaired(message) {
    await clearToken();
    view = null;
    screen = "pairing";
    pairing.info = message;
    pairing.error = null;
    ui.busy = null;
    ui.error = null;
    ui.confirmSwitch = null;
    render();
  }

  /** Handles errors that change the whole screen: not paired, or nothing answering. Returns true when it did. */
  async function screenFailure(err) {
    if (err?.kind === "not_paired") {
      await unpaired(err.message || "Pair this side panel with Kiki first.");
      return true;
    }
    if (err?.kind === "offline") {
      screen = "offline";
      render();
      return true;
    }
    return false;
  }

  async function refreshOnce() {
    if (!(await loadToken())) {
      screen = "pairing";
      pairing.offline = !(await api.reachable());
      render();
      return;
    }
    const [result, activeTab] = await Promise.all([api.state().then((v) => ({ v }), (err) => ({ err })), readTab()]);
    tab = activeTab;
    if (result.err) {
      if (await screenFailure(result.err)) return;
      const message = result.err.message || String(result.err);
      if (view && screen === "main") ui.loadError = message;
      else {
        problem = message;
        screen = "problem";
      }
      render();
      return;
    }
    // Unpair in the app revokes every panel; GET /api/state says so even if this request's token wasn't checked.
    if (result.v?.extension && result.v.extension.paired === false) {
      await unpaired("Kiki was unpaired in the app. Type a new code to pair again.");
      return;
    }
    view = result.v;
    problem = null;
    ui.loadError = null;
    screen = "main";
    render();
  }

  function refresh() {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          await refreshOnce();
        } while (again && !stopped);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function loop() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        if (doc.visibilityState !== "hidden") await refresh();
      } catch (err) {
        console.error("Kiki side panel: refresh failed.", err);
      } finally {
        loop();
      }
    }, refreshMs);
  }

  // Actions -------------------------------------------------------------------------------------

  async function act(key, call, success) {
    if (ui.busy) return;
    ui.busy = key;
    ui.error = null;
    ui.flash = null;
    render();
    try {
      const result = await call();
      const message = success ? success(result) : null;
      if (message) {
        ui.flash = message;
        ui.flashAt = Date.now();
      }
    } catch (err) {
      ui.busy = null;
      if (await screenFailure(err)) return;
      ui.error = err?.message || String(err);
    }
    // Stay busy until the panel shows what the action did, so buttons don't flicker back on.
    try {
      await refresh();
    } finally {
      ui.busy = null;
      render();
    }
  }

  function requestIdFor(planKey) {
    if (!requestIds.has(planKey)) requestIds.set(planKey, globalThis.crypto.randomUUID());
    return requestIds.get(planKey);
  }

  const actions = {
    setTab(id) {
      ui.tab = id;
      render();
    },
    dismissError() {
      ui.error = null;
      render();
    },
    approve(p) {
      if (ui.busy) return;
      if (p.key === shownPlan && replacedAt && Date.now() - replacedAt < JUST_CHANGED_MS) {
        ui.error = "The plan just changed. Take a look before approving.";
        render();
        return;
      }
      const clientRequestId = requestIdFor(p.key);
      return act("approve", () => api.approve(p.id, p.contentHash, clientRequestId), () => "Approved. Kiki is applying it now.");
    },
    discard(p) {
      return act("discard", () => api.discard(p.id), () => "Set aside. Nothing in Drive changed.");
    },
    askSwitch(o) {
      ui.confirmSwitch = o.folderId;
      render();
    },
    cancelSwitch() {
      ui.confirmSwitch = null;
      render();
    },
    select(o) {
      return act(
        "select",
        () => api.selectFolder(o.url),
        () => {
          ui.confirmSwitch = null;
          ui.tab = "organize";
          return "Kiki is looking through the folder. She'll propose a plan before anything moves.";
        },
      );
    },
    check() {
      return act("check", () => api.organize(), (r) => (typeof r?.message === "string" ? r.message : null));
    },
    retry(b) {
      return act(
        "retry",
        () => (b.action === "refresh" ? api.refresh(b.id) : api.resume(b.id)),
        (r) => (b.action === "refresh" ? (typeof r?.message === "string" ? r.message : null) : "Kiki is retrying the unfinished steps. Finished steps won't run again."),
      );
    },
    setAutoText(on) {
      return act("autotext", () => api.setAutoText(on), () => (on ? "Fo will text you when Kiki finds something new." : "Fo won't text you about new finds."));
    },
    async pair(raw) {
      if (pairing.busy) return;
      const code = cleanCode(raw);
      if (!code) {
        pairing.error = "Type the 6-digit code from the Kiki app.";
        render();
        return;
      }
      pairing.busy = true;
      pairing.error = null;
      render();
      try {
        const res = await api.pair(code);
        if (typeof res?.token !== "string" || !res.token) throw new Error("Kiki didn't send a pairing key back. Make a new code and try again.");
        await saveToken(res.token);
        pairing.info = null;
        pairing.offline = false;
        screen = "loading";
      } catch (err) {
        if (err?.kind === "offline") pairing.offline = true;
        else pairing.error = err?.message || String(err);
      } finally {
        pairing.busy = false;
      }
      await refresh();
      render();
    },
    async retryNow() {
      if (checking) return;
      checking = true;
      render();
      try {
        await refresh();
      } finally {
        checking = false;
        render();
      }
    },
  };

  // Wiring --------------------------------------------------------------------------------------

  const onTabChange = async () => {
    const next = await readTab();
    if (JSON.stringify(next) === JSON.stringify(tab)) return;
    tab = next;
    if (screen === "main") render();
  };
  chromeApi.tabs?.onActivated?.addListener(() => void onTabChange());
  chromeApi.tabs?.onUpdated?.addListener((_id, info) => {
    if (info && (info.url || info.title || info.status === "complete")) void onTabChange();
  });
  chromeApi.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes || !(TOKEN_KEY in changes)) return;
    const next = changes[TOKEN_KEY].newValue;
    token = typeof next === "string" && next ? next : null;
    void refresh();
  });
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") void refresh();
  });

  const closeDialog = () => (typeof el.dialog?.close === "function" ? el.dialog.close() : el.dialog?.removeAttribute("open"));
  $("#about")?.addEventListener("click", () => {
    if (el.forget) el.forget.hidden = !token;
    if (typeof el.dialog?.showModal === "function") el.dialog.showModal();
    else el.dialog?.setAttribute("open", "");
  });
  $("#close")?.addEventListener("click", closeDialog);
  $("#dismiss")?.addEventListener("click", closeDialog);
  el.forget?.addEventListener("click", async () => {
    closeDialog();
    await unpaired("This browser forgot the pairing. To revoke it in Kiki too, click Unpair in the Kiki app.");
  });
  el.kiki?.addEventListener("animationend", () => el.kiki.classList.remove("bob", "tilt"));

  // Tell the toolbar button that this side panel is open and can be seen: its next click then
  // closes it, and a browser that opens the panel without ever showing it gets a Kiki window.
  function announce() {
    if (openedAs !== "side" || stopped || typeof chromeApi.runtime?.connect !== "function") return;
    let port;
    try {
      port = chromeApi.runtime.connect({ name: "kiki-panel" });
    } catch {
      return;
    }
    const send = async () => {
      try {
        const w = await chromeApi.windows?.getCurrent?.();
        port.postMessage({ view: "side", windowId: typeof w?.id === "number" ? w.id : null, visible: doc.visibilityState === "visible" });
      } catch {
        // The worker went away; the reconnect below tells the next one.
      }
    };
    const onVisibility = () => void send();
    doc.addEventListener("visibilitychange", onVisibility);
    port.onDisconnect.addListener(() => {
      doc.removeEventListener("visibilitychange", onVisibility);
      // The browser stops idle extension workers; say it again to the next one.
      if (!stopped) setTimeout(announce, 1000);
    });
    void send();
  }
  announce();

  render();
  refresh()
    .catch((err) => console.error("Kiki side panel: first refresh failed.", err))
    .finally(loop);

  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// In the extension, start for real. Anywhere else (a check in Node), the caller calls start().
if (typeof document !== "undefined" && globalThis.chrome?.runtime?.id) {
  start({ doc: document, chromeApi: globalThis.chrome, fetchFn: globalThis.fetch.bind(globalThis) });
}
