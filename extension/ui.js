// Builds the panel's DOM from the plain model in lib.js. Everything from the server goes in as
// text nodes; links only get an href that passes safeLink(); no innerHTML anywhere.

import { KIKI_ORIGIN, OFFLINE_HINT, PAIRING_HINT, plural, safeLink } from "./lib.js";

const BLOCKED_ATTRS = new Set(["style", "src", "srcdoc", "srcset", "formaction", "action"]);

/** A tiny element builder: h("p", { class: "copy", text: "Hi" }, child, "more text"). */
export function makeH(doc) {
  return function h(tag, props, ...children) {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (/^on/i.test(key) || BLOCKED_ATTRS.has(key.toLowerCase())) throw new Error(`The panel doesn't set "${key}" attributes.`);
      if (key === "class") el.className = String(value);
      else if (key === "text") el.textContent = String(value);
      else if (key === "events") for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
      else if (key === "data") for (const [k, v] of Object.entries(value)) el.dataset[k] = String(v);
      else if (key === "href") {
        const safe = safeLink(String(value));
        if (safe) el.setAttribute("href", safe);
      } else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false || child === "") continue;
      el.append(typeof child === "object" ? child : String(child));
    }
    return el;
  };
}

const external = (h, href, text, cls) => h("a", { href, target: "_blank", rel: "noopener noreferrer", class: cls, text });

function notice(h, tone, title, body, extra = {}) {
  return h(
    "div",
    { class: `notice ${tone}`, role: extra.role },
    title ? h("strong", { text: title }) : null,
    body ? h("p", { text: body }) : null,
    extra.openKiki ? external(h, `${KIKI_ORIGIN}/`, "Open Kiki", "inline") : null,
    extra.dismiss ? h("button", { type: "button", class: "link", data: { key: "dismiss" }, events: { click: extra.dismiss } }, "Dismiss") : null,
  );
}

function stepList(h, steps, { chips }) {
  return h(
    "ol",
    { class: "steps" },
    steps.map((s) =>
      h(
        "li",
        { class: s.state === "excluded" ? "step excluded" : "step" },
        h("div", { class: "steptop" }, h("strong", { text: s.title }), chips || s.state === "excluded" ? h("span", { class: `chip ${s.tone}`, text: s.stateLabel }) : null),
        s.from ? h("p", { class: "from", text: s.from }) : null,
        s.to ? h("span", { class: "path" }, s.from ? h("span", { "aria-hidden": "true", text: "→ " }) : null, s.from ? h("span", { class: "sr", text: "to " }) : null, s.to) : null,
        s.reason ? h("p", { class: "why", text: s.reason }) : null,
        s.error ? h("p", { class: "err", text: s.error }) : null,
      ),
    ),
  );
}

function contextCard(h, m) {
  const ws = m.workspace;
  return [
    h(
      "div",
      { class: "context" },
      h("span", { class: "folder", "aria-hidden": "true", text: "▰" }),
      h(
        "div",
        { class: "ctx" },
        h("small", { text: "WORKSPACE" }),
        h("strong", { text: ws ? ws.name : "No folder yet" }),
        ws?.link ? external(h, ws.link, "Open in Drive", "drive") : ws?.mock ? h("span", { class: "drive", text: "Mock Drive" }) : null,
      ),
      ws ? h("span", { class: "pill", text: ws.pill }) : null,
    ),
    m.here ? h("p", { class: "here", text: m.here }) : null,
  ];
}

function tabs(h, ui, act) {
  const tab = (id, label) =>
    h("button", { type: "button", class: ui.tab === id ? "selected" : null, "aria-current": ui.tab === id ? "page" : null, data: { key: `tab-${id}` }, events: { click: () => act.setTab(id) } }, label);
  return h("nav", { "aria-label": "Kiki views" }, tab("organize", "Organize"), tab("activity", "Activity"));
}

function offerCard(h, o, ui, act) {
  const busy = Boolean(ui.busy);
  const parts = [h("div", { class: "eyebrow", text: "THIS DRIVE TAB" }), h("strong", { class: "tabname", text: o.title ?? "This folder" })];
  if (o.state === "mock") {
    parts.push(h("p", { class: "copy", text: "Kiki is using a mock Drive right now, so she can't organize folders from your Google Drive." }));
  } else if (o.state === "needs_drive") {
    parts.push(h("p", { class: "copy", text: "Connect Google Drive in the Kiki app first." }));
  } else if (o.state === "busy") {
    parts.push(
      h("button", { type: "button", class: "primary", disabled: true }, "Organize this folder"),
      h("p", { class: "copy after", text: "Kiki is still applying changes. You can switch when she's done." }),
    );
  } else if (o.state === "switch" && ui.confirmSwitch === o.folderId) {
    parts.push(
      h("p", { class: "copy", text: `Kiki will stop watching “${o.from}” and organize this folder instead. Nothing moves until you approve a plan.` }),
      h("button", { type: "button", class: "primary", data: { key: "confirm-switch" }, disabled: busy, events: { click: () => act.select(o) } }, ui.busy === "select" ? "Switching…" : "Switch to this folder"),
      h("button", { type: "button", class: "secondary", data: { key: "cancel-switch" }, disabled: busy, events: { click: () => act.cancelSwitch() } }, "Cancel"),
    );
  } else {
    parts.push(
      h(
        "button",
        { type: "button", class: "primary", data: { key: "select" }, disabled: busy, events: { click: () => (o.state === "switch" ? act.askSwitch(o) : act.select(o)) } },
        ui.busy === "select" ? "Opening…" : "Organize this folder",
      ),
      h("p", { class: "copy after", text: "Kiki looks through it first. Nothing moves until you approve." }),
    );
  }
  return h("section", { class: "card offer", "aria-label": "This Drive tab" }, parts);
}

function foCard(h, f) {
  return h(
    "section",
    { class: "fo", "aria-label": `From ${f.fo}` },
    h("div", { class: "eyebrow", text: `FROM ${f.fo.toUpperCase()}` }),
    h(
      "div",
      { class: `quote ${f.tone}` },
      h("strong", { text: f.label }),
      f.text ? h("p", { class: "said", text: `“${f.text}”` }) : null,
      f.more ? h("p", { text: f.more }) : null,
      f.progress ? h("p", { class: "muted", text: f.progress }) : null,
      f.purpose || f.time ? h("small", { text: [f.purpose, f.time].filter(Boolean).join(" · ") }) : null,
    ),
  );
}

function proposedCard(h, p, ui, act) {
  const busy = Boolean(ui.busy);
  return h(
    "section",
    { class: "plan", "aria-labelledby": "plan-title" },
    h("div", { class: "eyebrow", text: p.eyebrow }),
    h("h2", { id: "plan-title", text: p.title }),
    p.summary ? h("p", { class: "copy", text: p.version > 1 ? `${p.summary} Version ${p.version}.` : p.summary }) : null,
    p.conflict ? notice(h, "warn", "Something doesn't match.", p.conflict) : null,
    p.evidence ? h("div", { class: "quote" }, h("p", { class: "said", text: `“${p.evidence.statement}”` }), p.evidence.source ? h("small", { text: p.evidence.source }) : null) : null,
    p.diff ? h("div", { class: "reason" }, h("strong", { text: "What changed in the quote" }), h("ul", {}, p.diff.map((line) => h("li", { text: line })))) : null,
    stepList(h, p.steps, { chips: false }),
    p.notes.length
      ? h(
          "details",
          { class: "notes", data: { key: "notes" } },
          h("summary", { text: p.notes.length === 1 ? "1 file stays where it is" : `${p.notes.length} files stay where they are` }),
          h("ul", {}, p.notes.map((n) => h("li", {}, h("strong", { text: n.name }), ` · ${n.status}: ${n.reason}`))),
        )
      : null,
    h("p", { class: "reason", text: "Kiki checks each file again right before she acts and reads it back after. Nothing is deleted." }),
    h(
      "button",
      { type: "button", class: "primary", data: { key: "approve" }, disabled: busy || p.count === 0, events: { click: () => act.approve(p) } },
      ui.busy === "approve" ? "Approving…" : p.count ? `Approve ${plural(p.count, "change")}` : "Nothing to approve",
    ),
    h("button", { type: "button", class: "secondary", data: { key: "discard" }, disabled: busy, events: { click: () => act.discard(p) } }, ui.busy === "discard" ? "Setting it aside…" : "Not now"),
  );
}

function runningCard(h, r) {
  return h(
    "section",
    { class: "plan", "aria-labelledby": "run-title" },
    h("div", { class: "eyebrow", text: "APPLYING YOUR PLAN" }),
    h("h2", { id: "run-title", text: r.title }),
    h("div", { class: "progress", role: "status" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: r.label })),
    stepList(h, r.steps, { chips: true }),
  );
}

function brokenCard(h, b, ui, act) {
  return h(
    "div",
    { class: "notice warn", role: "alert" },
    h("strong", { text: b.heading }),
    h("p", { class: "muted", text: b.title }),
    b.error ? h("p", { text: b.error }) : null,
    b.action
      ? h("button", { type: "button", class: "small", data: { key: "retry" }, disabled: Boolean(ui.busy), events: { click: () => act.retry(b) } }, ui.busy === "retry" ? "Working on it…" : b.actionLabel)
      : null,
  );
}

function doneCard(h, d, ws) {
  return h(
    "div",
    { class: d.partial ? "success partial" : "success" },
    h("h2", { text: d.label }),
    h("p", { class: "copy", text: [d.title, d.when].filter(Boolean).join(" · ") }),
    ws?.link ? external(h, ws.link, "See it in Drive", "drive") : null,
    d.steps.length ? h("details", { data: { key: "done-steps" } }, h("summary", { text: "What changed" }), stepList(h, d.steps, { chips: true })) : null,
  );
}

function attentionCard(h, m) {
  return h(
    "section",
    { class: "fo", "aria-label": "Needs a look" },
    h("div", { class: "eyebrow", text: "NEEDS A LOOK" }),
    h(
      "ul",
      { class: "steps" },
      m.attention.map((a) =>
        h(
          "li",
          { class: "step" },
          h("div", { class: "steptop" }, h("strong", { text: a.title }), a.chip ? h("span", { class: `chip ${a.chip.tone}`, text: a.chip.label }) : null),
          a.detail ? h("p", { text: a.detail }) : null,
        ),
      ),
    ),
    m.attentionMore ? h("p", { class: "copy", text: `And ${m.attentionMore} more in the Kiki app.` }) : null,
  );
}

function organizeView(h, m, ui, act) {
  return [
    ui.error ? notice(h, "bad", null, ui.error, { role: "alert", dismiss: act.dismissError }) : null,
    ui.loadError ? notice(h, "warn", "Kiki couldn't send the latest.", `${ui.loadError} Showing what she said last.`) : null,
    ui.flash ? notice(h, "ok", null, ui.flash, { role: "status" }) : null,
    m.alerts.map((a) => notice(h, a.tone, a.title, a.body, { openKiki: a.openKiki })),
    m.offer ? offerCard(h, m.offer, ui, act) : null,
    m.fo ? foCard(h, m.fo) : null,
    m.proposed ? proposedCard(h, m.proposed, ui, act) : null,
    m.running ? runningCard(h, m.running) : null,
    m.broken ? brokenCard(h, m.broken, ui, act) : null,
    m.done ? doneCard(h, m.done, m.workspace) : null,
    m.attention.length && !m.proposed ? attentionCard(h, m) : null,
    m.check
      ? h(
          "div",
          { class: "check" },
          h("button", { type: "button", class: "ghost", data: { key: "check" }, disabled: !m.check.ready || Boolean(ui.busy), events: { click: () => act.check() } }, ui.busy === "check" ? "Checking…" : m.check.label),
          m.check.ready ? null : h("p", { class: "copy after", text: "Reading files…" }),
        )
      : null,
    m.empty ? h("p", { class: "copy empty", text: m.empty }) : null,
    m.autoText
      ? h(
          "label",
          { class: "toggle" },
          h("input", { type: "checkbox", data: { key: "autotext" }, checked: m.autoText.on, disabled: Boolean(ui.busy), events: { change: (e) => act.setAutoText(e.currentTarget.checked) } }),
          h("span", {}, h("strong", { text: "Text me when Kiki finds something new" }), h("small", { text: "Fo texts you. Reply to the text, or answer here." })),
        )
      : null,
  ];
}

function activityView(h, m) {
  return [
    h("div", { class: "eyebrow", text: "A CLEAR LITTLE TRAIL" }),
    h("h2", { text: "What happened here." }),
    h("p", { class: "copy", text: m.events.length ? "Newest first, straight from Kiki's log." : "Nothing yet." }),
    m.events.map((e) => h("div", { class: "history" }, h("p", { text: e.message }), e.time ? h("small", { text: e.time }) : null)),
  ];
}

/** The paired view: workspace, tabs, and the selected tab's content. */
export function renderMain(doc, model, ui, act) {
  const h = makeH(doc);
  return [...contextCard(h, model).filter(Boolean), tabs(h, ui, act), h("div", { class: "view" }, ui.tab === "activity" ? activityView(h, model) : organizeView(h, model, ui, act))];
}

export function renderPairing(doc, p, act) {
  const h = makeH(doc);
  const input = h("input", {
    id: "code",
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
    maxlength: "9",
    placeholder: "6-digit code",
    "aria-label": "6-digit pairing code",
    "aria-describedby": "pair-help",
    "aria-invalid": p.error ? "true" : null,
    required: true,
    data: { key: "code" },
  });
  const form = h(
    "form",
    { class: "pairform", events: { submit: (e) => (e.preventDefault(), act.pair(input.value)) } },
    input,
    h("button", { type: "submit", data: { key: "pair" }, disabled: p.busy }, p.busy ? "Pairing…" : "Pair"),
  );
  return [
    h(
      "section",
      { class: "pairing", "aria-labelledby": "pair-title" },
      h("div", { class: "eyebrow", text: "PAIR THIS SIDE PANEL" }),
      h("h2", { id: "pair-title", text: "One quick code." }),
      h("p", { class: "copy", id: "pair-help", text: PAIRING_HINT }),
      p.offline ? notice(h, "warn", "I can't reach Kiki.", OFFLINE_HINT) : null,
      p.info ? notice(h, "info", null, p.info) : null,
      form,
      p.error ? h("p", { class: "err", role: "alert", text: p.error }) : null,
    ),
  ];
}

export function renderOffline(doc, o, act) {
  const h = makeH(doc);
  return [
    h(
      "section",
      { class: "offline", "aria-labelledby": "off-title" },
      h("div", { class: "eyebrow", text: "KIKI ISN'T ANSWERING" }),
      h("h2", { id: "off-title", text: "Is Kiki running?" }),
      h("p", { class: "copy", text: OFFLINE_HINT }),
      h("p", { class: "copy", text: "This panel checks again every couple of seconds." }),
      h("button", { type: "button", class: "primary", data: { key: "retry-now" }, disabled: o.busy, events: { click: () => act.retryNow() } }, o.busy ? "Checking…" : "Try now"),
    ),
  ];
}

export function renderProblem(doc, o, act) {
  const h = makeH(doc);
  return [
    h(
      "section",
      { class: "offline", "aria-labelledby": "problem-title" },
      h("div", { class: "eyebrow", text: "SOMETHING WENT WRONG" }),
      h("h2", { id: "problem-title", text: "Kiki answered with an error." }),
      h("p", { class: "err", role: "alert", text: o.message }),
      h("button", { type: "button", class: "primary", data: { key: "retry-now" }, disabled: o.busy, events: { click: () => act.retryNow() } }, o.busy ? "Checking…" : "Try now"),
    ),
  ];
}
