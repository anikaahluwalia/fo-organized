// Kiki's toolbar button.
//
// Where the browser has Chrome's side panel (Chrome, Edge, Brave), the button opens Kiki there,
// and closes her if she's already open. Some Chromium browsers run extensions but never show
// extension side panels (Arc has its own sidebar instead). So the click comes here rather than
// straight to the panel: if no visible panel reports in shortly after opening it, Kiki opens in a
// small window of her own. A browser without the side panel API at all gets Kiki as the button's
// popup.

const WINDOW_URL = "panel.html?view=window";
const POPUP_URL = "panel.html?view=popup";
/** How long an opened side panel gets to report that it's visible. */
const CONFIRM_MS = 2500;
const NO_PANEL_KEY = "sidePanelNeverShows";

const canSidePanel = typeof chrome.sidePanel?.open === "function";

/** Side panels open right now, by browser window. Each panel connects when it loads. */
const panels = new Map();
/** Click handlers waiting for a panel in a window to show up. */
const waiting = new Map();
let kikiWindowId = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "kiki-panel") return;
  let windowId = null;
  port.onMessage.addListener((m) => {
    if (!m || m.view !== "side" || !Number.isInteger(m.windowId)) return;
    windowId = m.windowId;
    panels.set(windowId, { port, visible: m.visible === true });
    if (m.visible === true) {
      waiting.get(windowId)?.(true);
      // It works here after all: stop sending clicks straight to a window.
      chrome.storage?.session?.remove?.(NO_PANEL_KEY)?.catch?.(() => {});
    }
  });
  port.onDisconnect.addListener(() => {
    if (windowId !== null && panels.get(windowId)?.port === port) panels.delete(windowId);
  });
});

/** Resolves true once a visible side panel reports in from this window, false after CONFIRM_MS. */
function panelShows(windowId) {
  if (panels.get(windowId)?.visible) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (shown) => {
      clearTimeout(timer);
      if (waiting.get(windowId) === done) waiting.delete(windowId);
      resolve(shown);
    };
    const timer = setTimeout(() => done(false), CONFIRM_MS);
    waiting.set(windowId, done);
  });
}

/** Kiki in a small window of her own (or a tab, where windows can't be made). One at a time. */
async function openKikiWindow() {
  if (kikiWindowId !== null) {
    try {
      await chrome.windows.update(kikiWindowId, { focused: true });
      return;
    } catch {
      kikiWindowId = null;
    }
  }
  try {
    const w = await chrome.windows.create({ url: WINDOW_URL, type: "popup", width: 420, height: 820, focused: true });
    kikiWindowId = typeof w?.id === "number" ? w.id : null;
  } catch {
    await chrome.tabs.create({ url: WINDOW_URL });
  }
}

chrome.windows?.onRemoved?.addListener((id) => {
  if (id === kikiWindowId) kikiWindowId = null;
});

async function sidePanelNeverShows() {
  try {
    return Boolean((await chrome.storage.session.get(NO_PANEL_KEY))[NO_PANEL_KEY]);
  } catch {
    return false;
  }
}

if (canSidePanel) {
  // Clicks come to the handler below, not straight to the panel (an earlier version set this to
  // true, and the setting outlives reloads).
  chrome.sidePanel.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch?.(() => {});
} else {
  chrome.action.setPopup({ popup: POPUP_URL });
}

chrome.action.onClicked.addListener((tab) => {
  const windowId = tab?.windowId;
  if (!canSidePanel || !Number.isInteger(windowId)) {
    void openKikiWindow();
    return;
  }
  if (panels.get(windowId)?.visible) {
    // Already open in this window: the button closes it, where the browser can.
    if (typeof chrome.sidePanel.close === "function") chrome.sidePanel.close({ windowId }).catch(() => {});
    return;
  }
  // sidePanel.open has to be called right away, while the click still counts as a user gesture.
  let opening;
  try {
    opening = chrome.sidePanel.open({ windowId });
  } catch {
    void openKikiWindow();
    return;
  }
  void (async () => {
    // This browser already showed it never displays the panel: don't make the user wait again.
    if (await sidePanelNeverShows()) {
      await openKikiWindow();
      return;
    }
    let shown = false;
    try {
      await opening;
      shown = await panelShows(windowId);
    } catch {
      shown = false;
    }
    if (shown) return;
    chrome.storage?.session?.set?.({ [NO_PANEL_KEY]: true })?.catch?.(() => {});
    await openKikiWindow();
  })();
});
