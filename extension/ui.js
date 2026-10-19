// Builds the panel's DOM from the plain model in lib.js. Everything from the server goes in as
// text nodes; links only get an href that passes safeLink(); no innerHTML anywhere.

import { KIKI_ORIGIN, OFFLINE_HINT, PAIRING_HINT, plural, safeLink } from "./lib.js";

const BLOCKED_ATTRS = new Set(["style", "src", "srcdoc", "srcset", "formaction", "action"]);
const SVG_NS = "http://www.w3.org/2000/svg";

function svg(doc, tag, attrs, ...children) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

// Line icons, as in the app (web/src/ui.tsx). Decorative: the words beside them say what they mean.
const ICONS = {
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  check: "M5 12.5l4.5 4.5L19 7",
  alert: "M12 3l9.5 17h-19zM12 10v4M12 17v.01",
  minus: "M6 12h12",
  message: "M4 5h16v11H9l-5 4z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  external: "M7 17L17 7M9 7h8v8",
  settings: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
};

function icon(doc, name, size = 18) {
  return svg(
    doc,
    "svg",
    { class: "icon", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" },
    svg(doc, "path", { d: ICONS[name] }),
  );
}

/** A tiny element builder: h("p", { class: "copy", text: "Hi" }, child, "more text"). h.icon(name) makes an icon. */
export function makeH(doc) {
  function h(tag, props, ...children) {
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
  }
  h.icon = (name, size) => icon(doc, name, size);
  return h;
}

// Kiki -------------------------------------------------------------------------------------------

// Geometry and colours from web/src/Kiki.tsx (measured from the approved PNG).
const PINK = "#F59FAC";
const CHOC = "#3A2620";
const SILHOUETTE =
  "M1045 600C1047 646 1045 697 1029 740C1014 782 985 826 952 855C918 885 870 902 829 916C789 929 747 930 709 934C670 938 636 938 600 939C564 940 529 941 490 938C451 935 408 933 368 919C328 905 281 885 250 854C219 824 194 779 181 736C167 694 166 644 169 600C172 556 182 509 199 470C216 430 241 390 271 361C300 331 340 309 377 293C413 276 454 270 491 264C528 257 563 255 600 254C637 252 671 255 711 258C752 260 804 251 842 267C881 282 914 318 943 351C972 384 999 423 1016 465C1033 506 1043 554 1045 600Z";
const CLIP_LOOP = "M34 184V44A34 34 0 0 0 -34 44V214A34 34 0 0 0 34 214V198";
const CLIP_INNER = "M-6 80V168";
const EYES = [
  [412, 622],
  [787, 604],
];
const MOUTHS = {
  smile: "M585 710C612 711 640 700 668 666",
  soft: "M588 706C614 711 642 706 666 692",
  flat: "M596 702C618 704 640 704 660 701",
  short: "M612 701L648 700",
};
const FACES = {
  idle: { eyes: "oval", mouth: "smile" },
  reading: { eyes: "oval", mouth: "soft" },
  organizing: { eyes: "oval", mouth: "soft" },
  needs_approval: { eyes: "attentive", mouth: "soft" },
  waiting: { eyes: "relaxed", mouth: "flat" },
  needs_clarification: { eyes: "attentive", mouth: "short" },
  verified: { eyes: "happy", mouth: "smile" },
  error: { eyes: "oval", mouth: "flat" },
};

/**
 * Kiki's face for her state, small enough for the panel's header (so the paperclip keeps its
 * loops with a simpler line). Decorative: the status line beside her says it in words. `motion`
 * ("bob" or "tilt") plays once, only when her state changed while the panel was open.
 */
export function kikiFace(doc, state, motion = null) {
  const key = Object.hasOwn(FACES, state) ? state : "idle";
  const face = FACES[key];
  const eye = ([cx, cy]) => {
    if (face.eyes === "happy") return svg(doc, "path", { d: `M${cx - 36} ${cy + 14}Q${cx} ${cy - 46} ${cx + 36} ${cy + 14}`, fill: "none", stroke: CHOC, "stroke-width": 22, "stroke-linecap": "round" });
    if (face.eyes === "attentive") return svg(doc, "ellipse", { cx, cy: cy - 2, rx: 41, ry: 56, fill: CHOC });
    if (face.eyes === "relaxed") return svg(doc, "ellipse", { cx, cy: cy + 6, rx: 39, ry: 42, fill: CHOC });
    return svg(doc, "ellipse", { cx, cy, rx: 39, ry: 52, fill: CHOC });
  };
  const eyes = key === "idle" || key === "waiting" ? "kiki__eyes kiki__eyes--blink" : key === "organizing" ? "kiki__eyes kiki__eyes--scan" : key === "reading" ? "kiki__eyes kiki__eyes--down" : "kiki__eyes";
  return svg(
    doc,
    "svg",
    { class: `kiki kiki--${key}${motion ? ` kiki--${motion}` : ""}`, viewBox: "148 218 920 740", width: 34, height: 27, "aria-hidden": "true", focusable: "false" },
    svg(doc, "path", { fill: PINK, d: SILHOUETTE }),
    svg(doc, "g", { class: eyes }, EYES.map(eye)),
    svg(doc, "path", { d: MOUTHS[face.mouth], fill: "none", stroke: CHOC, "stroke-width": 22, "stroke-linecap": "round" }),
    svg(
      doc,
      "g",
      { transform: "translate(895.7 344.4) rotate(-43.3) translate(0 -129)", fill: "none", stroke: CHOC, "stroke-width": 22, "stroke-linecap": "round", "stroke-linejoin": "round" },
      svg(doc, "path", { d: CLIP_LOOP }),
      svg(doc, "path", { d: CLIP_INNER }),
    ),
  );
}

// Pieces -----------------------------------------------------------------------------------------

const external = (h, href, text, cls = "link") => h("a", { href, target: "_blank", rel: "noopener noreferrer", class: cls }, text, h.icon("external", 14));

function notice(h, tone, title, body, extra = {}) {
  return h(
    "div",
    { class: `notice ${tone}`, role: extra.role },
    title ? h("strong", { text: title }) : null,
    body ? h("p", { text: body }) : null,
    extra.lines ? h("ul", {}, extra.lines.map((line) => h("li", { text: line }))) : null,
    extra.link ? external(h, `${KIKI_ORIGIN}/`, "Open Kiki") : null,
    extra.dismiss ? h("button", { type: "button", class: "btn quiet small", data: { key: "dismiss" }, events: { click: extra.dismiss } }, "Dismiss") : null,
  );
}

/** One change: "old → new" and where it goes, with its state once it isn't just proposed. */
function changeRow(h, r, { states = false } = {}) {
  return h(
    "li",
    { class: "change" },
    r.title ? h("span", { class: "change-title", text: r.title }) : null,
    r.to || r.from
      ? h(
          "span",
          { class: "change-names" },
          r.from ? [h("span", { class: "old", text: r.from }), h("span", { class: "arrow", "aria-hidden": "true", text: " → " }), h("span", { class: "sr", text: " to " })] : null,
          r.to ? h("span", { text: r.to }) : null,
        )
      : null,
    r.where ? h("span", { class: "change-where", text: r.where }) : null,
    states && r.state !== "pending" ? h("span", { class: `tone ${r.tone}`, text: r.stateLabel }) : null,
    r.error ? h("span", { class: "tone bad", text: r.error }) : null,
  );
}

function meta(h, iconName, label, time, badge) {
  return h("p", { class: "meta" }, badge ?? h.icon(iconName, 16), h("span", { text: label }), time ? h("time", { text: time }) : null);
}

function offerCard(h, o, ui, act) {
  const busy = Boolean(ui.busy);
  const parts = [meta(h, "folder", "This Drive tab"), h("h3", { class: "card-title", text: o.title ?? "This folder" })];
  if (o.state === "mock") {
    parts.push(h("p", { class: "muted", text: "Kiki is using a mock Drive right now, so she can't organize folders from your Google Drive." }));
  } else if (o.state === "needs_drive") {
    parts.push(h("p", { class: "muted", text: "Connect Google Drive in the Kiki app first." }));
  } else if (o.state === "busy") {
    parts.push(
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn", disabled: true }, "Organize this folder")),
      h("p", { class: "muted", text: "Kiki is still applying changes. You can switch when she's done." }),
    );
  } else if (o.state === "switch" && ui.confirmSwitch === o.folderId) {
    parts.push(
      h("p", { text: `Kiki will stop watching “${o.from}” and organize this folder instead. Nothing moves until you approve a plan.` }),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn primary", data: { key: "confirm-switch" }, disabled: busy, events: { click: () => act.select(o) } }, ui.busy === "select" ? "Switching…" : "Switch to this folder"),
        h("button", { type: "button", class: "btn", data: { key: "cancel-switch" }, disabled: busy, events: { click: () => act.cancelSwitch() } }, "Cancel"),
      ),
    );
  } else {
    parts.push(
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          { type: "button", class: "btn", data: { key: "select" }, disabled: busy, events: { click: () => (o.state === "switch" ? act.askSwitch(o) : act.select(o)) } },
          ui.busy === "select" ? "Opening…" : "Organize this folder",
        ),
      ),
      h("p", { class: "muted", text: "Kiki looks through it first. Nothing moves until you approve." }),
    );
  }
  return h("section", { class: "card", "aria-label": "This Drive tab" }, parts);
}

const SHOWN_ROWS = 5;

function planCard(h, p, ui, act) {
  const busy = Boolean(ui.busy);
  const correcting = Boolean(p.request) && ui.correcting === p.key;
  let correction;
  return h(
    "article",
    { class: "card", "aria-labelledby": "plan-title" },
    meta(h, "file", p.type, p.time),
    h("h3", { id: "plan-title", class: "card-title", text: p.title }),
    p.conflict ? notice(h, "bad", "Something doesn't match.", p.conflict) : null,
    p.evidence ? h("div", { class: "quote" }, h("p", { text: `“${p.evidence.statement}”` }), p.evidence.source ? h("small", { text: p.evidence.source }) : null) : null,
    p.diff ? notice(h, "warn", "What changed in the quote", "Marking it current doesn't accept the price.", { lines: p.diff }) : null,
    p.fo ? h("p", { class: "muted", text: p.fo }) : null,
    p.rows.length ? h("ul", { class: "changes" }, p.rows.slice(0, SHOWN_ROWS).map((r) => changeRow(h, r))) : null,
    p.rows.length > SHOWN_ROWS
      ? h(
          "details",
          { class: "more", data: { key: "more-rows" } },
          h("summary", { text: `Show ${plural(p.rows.length - SHOWN_ROWS, "more change")}` }),
          h("ul", { class: "changes" }, p.rows.slice(SHOWN_ROWS).map((r) => changeRow(h, r))),
        )
      : null,
    p.notes.length
      ? h(
          "details",
          { class: "more", data: { key: "notes" } },
          h("summary", { text: p.notes.length === 1 ? "1 file stays where it is" : `${p.notes.length} files stay where they are` }),
          h(
            "ul",
            { class: "changes" },
            p.notes.map((n) => h("li", { class: "change" }, h("span", { class: "change-names", text: n.name }), h("span", { class: "change-where", text: `${n.status}. ${n.reason}` }))),
          ),
        )
      : null,
    correcting
      ? h(
          "form",
          { class: "stack", events: { submit: (e) => (e.preventDefault(), act.correct(p, correction.value)) } },
          h("label", { for: "correction", text: "Your correction" }),
          (correction = h("textarea", { id: "correction", rows: "3", data: { key: "correction" }, placeholder: "Put the licence in Business, and skip the second quote." })),
          h(
            "div",
            { class: "actions" },
            h("button", { type: "submit", class: "btn primary", data: { key: "send-correction" }, disabled: busy }, ui.busy === "correct" ? "Sending…" : "Send correction"),
            h("button", { type: "button", class: "btn quiet", data: { key: "cancel-correction" }, disabled: busy, events: { click: () => act.cancelCorrection() } }, "Cancel"),
          ),
          h("p", { class: "note", text: `It goes to ${p.request.fo}, and Kiki makes a new version for you to review. It doesn't approve any changes.` }),
        )
      : h(
          "div",
          { class: "actions" },
          p.count
            ? h("button", { type: "button", class: "btn primary", data: { key: "approve" }, disabled: busy, events: { click: () => act.approve(p) } }, ui.busy === "approve" ? "Approving…" : `Approve ${plural(p.count, "change")}`)
            : null,
          p.request
            ? h("button", { type: "button", class: "btn", data: { key: "correct" }, disabled: busy, events: { click: () => act.startCorrection(p) } }, "Request a change")
            : external(h, `${KIKI_ORIGIN}/`, "Open in Kiki", "btn"),
        ),
    correcting
      ? null
      : h(
          "div",
          { class: "after" },
          h("span", { class: "note", text: "Nothing changes until you approve." }),
          h("button", { type: "button", class: "btn quiet small", data: { key: "discard" }, disabled: busy, events: { click: () => act.discard(p) } }, ui.busy === "discard" ? "Setting it aside…" : "Not now"),
        ),
  );
}

function questionCard(h, q, ui, act) {
  let answer;
  const id = `answer-${q.taskId}`;
  return h(
    "article",
    { class: "card", "aria-labelledby": "question-title" },
    meta(h, null, `Question from ${q.fo}`, q.time, h("span", { class: "fo-badge", "aria-hidden": "true", text: "fo" })),
    h("h3", { id: "question-title", class: "card-title", text: `${q.fo} has a question.` }),
    q.question ? h("p", { class: "quote", text: q.question }) : null,
    h(
      "form",
      { class: "stack", events: { submit: (e) => (e.preventDefault(), act.answer(q, answer.value)) } },
      h("label", { for: id, text: "Your answer" }),
      (answer = h("textarea", { id, rows: "3", data: { key: id }, placeholder: "Yes, no, or a change like “skip the second quote”" })),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary", data: { key: "send-answer" }, disabled: Boolean(ui.busy) }, ui.busy === "answer" ? "Sending…" : `Send to ${q.fo}`)),
    ),
  );
}

function brokenCard(h, b, ui, act) {
  const shown = b.steps.slice(0, SHOWN_ROWS);
  return h(
    "article",
    { class: "card", "aria-labelledby": "broken-title" },
    meta(h, "alert", b.type),
    h("h3", { id: "broken-title", class: "card-title", text: b.heading }),
    h("p", { class: "muted", text: b.title }),
    shown.length ? h("ul", { class: "changes" }, shown.map((r) => changeRow(h, r, { states: true }))) : b.error ? h("p", { class: "tone bad", text: b.error }) : null,
    b.steps.length > shown.length ? h("p", { class: "muted", text: `And ${b.steps.length - shown.length} more in Kiki.` }) : null,
    b.action
      ? h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn", data: { key: "retry" }, disabled: Boolean(ui.busy), events: { click: () => act.retry(b) } }, ui.busy === "retry" ? "Working on it…" : b.actionLabel),
        )
      : null,
  );
}

/** What Kiki noticed in the folder. Nothing here changes anything; the app has the details and actions. */
function looksSection(h, m) {
  return h(
    "section",
    { class: "block", "aria-labelledby": "looks-title" },
    h("h2", { id: "looks-title", text: "Needs a look" }),
    h(
      "ul",
      { class: "changes" },
      m.attention.map((a) =>
        h(
          "li",
          { class: "change" },
          h("span", { class: "change-title" }, a.title, a.chip ? h("span", { class: `chip ${a.chip.tone}`, text: a.chip.label }) : null),
          a.detail ? h("span", { class: "change-where", text: a.detail }) : null,
        ),
      ),
    ),
    m.attentionMore ? h("p", { class: "muted", text: `And ${m.attentionMore} more in Kiki.` }) : null,
  );
}

function needsYou(h, m, ui, act) {
  const parts = [
    m.alerts.map((a) => notice(h, a.tone, a.title, a.body, { link: a.openKiki })),
    m.broken ? brokenCard(h, m.broken, ui, act) : null,
    m.proposed ? planCard(h, m.proposed, ui, act) : null,
    m.question ? questionCard(h, m.question, ui, act) : null,
    m.fo ? notice(h, m.fo.tone, m.fo.label, m.fo.more, { link: m.fo.openKiki }) : null,
  ]
    .flat()
    .filter(Boolean);
  const check = m.check
    ? h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn small", data: { key: "check" }, disabled: !m.check.ready || Boolean(ui.busy), events: { click: () => act.check() } }, ui.busy === "check" ? "Checking…" : m.check.label),
        m.check.ready ? null : h("span", { class: "muted", text: "Reading files…" }),
      )
    : null;
  if (!parts.length) return h("section", { class: "block", "aria-label": "Needs you" }, h("p", { class: "calm", text: m.empty ?? "Nothing needs you right now." }), check);
  return h("section", { class: "block", "aria-labelledby": "needs-title" }, h("h2", { id: "needs-title", text: "Needs you" }), parts, check);
}

const RECENT_ICON = { applied: "check", discarded: "minus" };

function recentSection(h, m) {
  if (!m.recent.length && !m.events.length) return null;
  return h(
    "section",
    { class: "block", "aria-labelledby": "recent-title" },
    h("h2", { id: "recent-title", text: "Recent" }),
    m.recent.length
      ? h(
          "ul",
          { class: "recent" },
          m.recent.map((r) =>
            h(
              "li",
              { class: "recent-item" },
              h("span", { class: `recent-icon ${r.tone}` }, h.icon(r.kind === "fo" ? "message" : (RECENT_ICON[r.status] ?? "alert"), 16)),
              h(
                "span",
                { class: "recent-text" },
                h("span", { class: "recent-title", text: r.title }),
                r.label ? h("span", { class: `tone ${r.tone}`, text: r.label }) : null,
                r.fo ? h("span", { class: "muted", text: r.fo }) : null,
              ),
              r.time ? h("time", { class: "recent-time", text: r.time }) : null,
            ),
          ),
        )
      : null,
    m.events.length
      ? h(
          "details",
          { class: "more log", data: { key: "log" } },
          h("summary", { text: "Everything Kiki did" }),
          h(
            "ul",
            { class: "log-list" },
            m.events.map((e) => h("li", {}, e.time ? h("time", { text: e.time }) : null, h("span", { text: e.message }))),
          ),
        )
      : null,
  );
}

/** The quiet bottom line: when the panel last heard from Kiki, the way to the full app, and settings. */
function footer(h, ctx, act) {
  const ws = ctx.workspace;
  return h(
    "footer",
    { class: "foot" },
    h(
      "div",
      { class: "foot-line" },
      h("span", { text: ctx.checked ? `Last checked ${ctx.checked}` : "" }),
      h(
        "span",
        { class: "foot-links" },
        external(h, `${KIKI_ORIGIN}/`, "Open Kiki"),
        ctx.inSettings ? null : h("button", { type: "button", class: "link", data: { key: "settings" }, events: { click: () => act.openSettings() } }, h.icon("settings", 15), "Settings"),
      ),
    ),
    ctx.modes || ws
      ? h(
          "p",
          { class: "foot-line small" },
          ctx.modes ? [ctx.modes.drive, ctx.modes.fo].map((x) => h("span", { class: "mode" }, h("span", { class: `dot-status${x.ok ? " ok" : " bad"}`, "aria-hidden": "true" }), x.label)) : null,
          ws ? (ws.link ? external(h, ws.link, ws.name, "link") : h("span", { text: ws.name })) : null,
        )
      : null,
    ctx.here ? h("p", { class: "foot-line small", text: ctx.here }) : null,
  );
}

// Screens ----------------------------------------------------------------------------------------

/** Paired: what needs you, what Kiki is working on, what happened recently. */
export function renderMain(doc, m, ui, act, ctx) {
  const h = makeH(doc);
  return [
    ui.error ? notice(h, "bad", null, ui.error, { role: "alert", dismiss: act.dismissError }) : null,
    ui.loadError ? notice(h, "warn", "Kiki couldn't send the latest.", `${ui.loadError} Showing what she said last.`) : null,
    ui.flash ? notice(h, "ok", null, ui.flash) : null,
    m.offer ? offerCard(h, m.offer, ui, act) : null,
    needsYou(h, m, ui, act),
    m.working
      ? h(
          "section",
          { class: "block", "aria-labelledby": "working-title" },
          h("h2", { id: "working-title", text: "Working on it" }),
          h("p", { class: "working" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: m.working.label }), m.working.detail ? h("span", { class: "muted", text: m.working.detail }) : null),
        )
      : null,
    // While a plan waits for you, that's the one thing to look at.
    m.attention.length && !m.proposed ? looksSection(h, m) : null,
    recentSection(h, m),
    footer(h, ctx, act),
  ];
}

export function renderPairing(doc, p, act, ctx) {
  const h = makeH(doc);
  const input = h("input", {
    id: "code",
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
    maxlength: "9",
    placeholder: "123 456",
    "aria-describedby": "pair-help",
    "aria-invalid": p.error ? "true" : null,
    required: true,
    data: { key: "code" },
  });
  return [
    h(
      "section",
      { class: "block", "aria-labelledby": "pair-title" },
      h("h2", { id: "pair-title", text: "Pair with Kiki" }),
      h("p", { class: "muted", id: "pair-help", text: PAIRING_HINT }),
      p.offline ? notice(h, "warn", "I can't reach Kiki.", OFFLINE_HINT) : null,
      p.info ? notice(h, "info", null, p.info) : null,
      h(
        "form",
        { class: "stack", events: { submit: (e) => (e.preventDefault(), act.pair(input.value)) } },
        h("label", { for: "code", text: "6-digit code" }),
        h("div", { class: "inline" }, input, h("button", { type: "submit", class: "btn primary", data: { key: "pair" }, disabled: p.busy }, p.busy ? "Pairing…" : "Pair")),
      ),
      p.error ? h("p", { class: "tone bad", role: "alert", text: p.error }) : null,
    ),
    footer(h, ctx, act),
  ];
}

export function renderOffline(doc, o, act, ctx) {
  const h = makeH(doc);
  return [
    h(
      "section",
      { class: "block", "aria-labelledby": "off-title" },
      h("h2", { id: "off-title", text: "Is Kiki running?" }),
      h("p", { class: "muted", text: OFFLINE_HINT }),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn primary", data: { key: "retry-now" }, disabled: o.busy, events: { click: () => act.retryNow() } }, o.busy ? "Checking…" : "Try now"),
      ),
    ),
    footer(h, ctx, act),
  ];
}

export function renderProblem(doc, o, act, ctx) {
  const h = makeH(doc);
  return [
    h(
      "section",
      { class: "block", "aria-labelledby": "problem-title" },
      h("h2", { id: "problem-title", text: "Kiki answered with an error" }),
      h("p", { class: "tone bad", role: "alert", text: o.message }),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn primary", data: { key: "retry-now" }, disabled: o.busy, events: { click: () => act.retryNow() } }, o.busy ? "Checking…" : "Try now"),
      ),
    ),
    footer(h, ctx, act),
  ];
}

/** Settings: the pairing, texts from Fo, and what the panel reads. */
export function renderSettings(doc, s, act, ctx) {
  const h = makeH(doc);
  return [
    h(
      "section",
      { class: "block", "aria-labelledby": "settings-title" },
      h("h2", { id: "settings-title", tabindex: "-1", data: { key: "settings-title" }, text: "Settings" }),
      h(
        "div",
        { class: "setting" },
        h("h3", { class: "sub", text: "Pairing" }),
        h("p", { text: s.paired ? "Paired with Kiki on this computer, at localhost:8787." : "Not paired yet." }),
        s.paired ? h("p", { class: "note", text: "To revoke it in Kiki too, click Unpair in Kiki's Settings." }) : null,
        s.paired ? h("div", { class: "actions" }, h("button", { type: "button", class: "btn small", data: { key: "forget" }, events: { click: () => act.forget() } }, "Forget the pairing on this browser")) : null,
      ),
      s.autoText
        ? h(
            "label",
            { class: "option" },
            h("input", { type: "checkbox", data: { key: "autotext" }, checked: s.autoText.on, disabled: Boolean(s.busy), events: { change: (e) => act.setAutoText(e.currentTarget.checked) } }),
            h("span", { class: "option-text" }, h("span", { class: "option-name", text: "Text me when Kiki finds something new" }), h("span", { class: "option-detail", text: "Fo texts you. Reply to the text, or answer here." })),
          )
        : null,
      h("p", { class: "note", text: "The panel talks only to Kiki on this computer. It reads your tab's address and title only on Google Drive, to offer the folder you have open, and never reads pages or files." }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn", data: { key: "settings-done" }, events: { click: () => act.closeSettings() } }, "Done")),
    ),
    footer(h, { ...ctx, inSettings: true }, act),
  ];
}
