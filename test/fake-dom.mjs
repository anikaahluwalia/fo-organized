// Just enough of a DOM to run the Chrome side panel (extension/panel.js and ui.js) in plain Node:
// elements, text, attributes, dataset, events, focus and simple selectors (tag, #id, .class,
// [attr], [attr=value], comma lists). Not a browser: no layout, no CSS.

class Text {
  constructor(text) {
    this.nodeType = 3;
    this.parentNode = null;
    this.textContent = String(text);
  }
}

class Element {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this._value = null;
    this._checked = null;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    const el = this;
    this.dataset = new Proxy(
      {},
      {
        get: (_t, k) => el.getAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
        set: (_t, k, v) => (el.setAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(v)), true),
      },
    );
    this.classList = {
      add: (...names) => (el.className = [...new Set([...el.className.split(/\s+/).filter(Boolean), ...names])].join(" ")),
      remove: (...names) => (el.className = el.className.split(/\s+/).filter((n) => n && !names.includes(n)).join(" ")),
      contains: (name) => el.className.split(/\s+/).includes(name),
    };
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  setAttribute(k, v) {
    this.attributes.set(String(k).toLowerCase(), String(v));
  }
  getAttribute(k) {
    return this.attributes.get(String(k).toLowerCase()) ?? null;
  }
  hasAttribute(k) {
    return this.attributes.has(String(k).toLowerCase());
  }
  removeAttribute(k) {
    this.attributes.delete(String(k).toLowerCase());
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(v) {
    this.setAttribute("class", v);
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(v) {
    if (v) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get open() {
    return this.hasAttribute("open");
  }
  set open(v) {
    if (v) this.setAttribute("open", "");
    else this.removeAttribute("open");
  }
  get value() {
    return this._value ?? this.getAttribute("value") ?? "";
  }
  set value(v) {
    this._value = String(v);
  }
  get checked() {
    return this._checked ?? this.hasAttribute("checked");
  }
  set checked(v) {
    this._checked = Boolean(v);
  }
  get form() {
    return this.closest("form");
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren(String(v ?? ""));
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === "object" && n !== null ? n : new Text(n);
      node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    this.append(...nodes.filter((n) => n !== "" && n !== undefined && n !== null));
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n;
    return null;
  }
  *descendants() {
    for (const c of this.children) {
      yield c;
      yield* c.descendants();
    }
  }
  querySelectorAll(sel) {
    return [...this.descendants()].filter((e) => matches(e, sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  dispatch(type) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  /** A click; a submit button also submits its form. */
  click() {
    if (this.disabled) return;
    this.dispatch("click");
    const type = this.getAttribute("type");
    if (this.localName === "button" && (type === "submit" || type === null)) this.form?.dispatch("submit");
  }
}

function matches(el, selector) {
  return selector.split(",").some((part) => matchesOne(el, part.trim()));
}

function matchesOne(el, sel) {
  const re = /(^[a-z0-9]+)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/gi;
  let m;
  let used = 0;
  while ((m = re.exec(sel))) {
    used += m[0].length;
    if (m[1] && el.localName !== m[1].toLowerCase()) return false;
    if (m[2] && el.id !== m[2]) return false;
    if (m[3] && !el.className.split(/\s+/).includes(m[3])) return false;
    if (m[4]) {
      if (!el.hasAttribute(m[4])) return false;
      const want = m[5] ?? m[6] ?? m[7];
      if (want !== undefined && el.getAttribute(m[4]) !== want) return false;
    }
  }
  if (used !== sel.length) throw new Error(`fake-dom can't match "${sel}"`);
  return true;
}

/** A document with `bodyHtml` built from a tiny tree: [tag, attrs, ...children]. */
export function fakeDocument(tree, { search = "" } = {}) {
  const listeners = new Map();
  const doc = {
    location: { search },
    visibilityState: "visible",
    createElement: (tag) => new Element(doc, tag),
    createElementNS: (_ns, tag) => new Element(doc, tag),
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
    querySelector: (sel) => doc.body.querySelector(sel),
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
  };
  const build = ([tag, attrs, ...children]) => {
    const el = new Element(doc, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
    for (const c of children) el.append(Array.isArray(c) ? build(c) : c);
    return el;
  };
  doc.documentElement = new Element(doc, "html");
  doc.body = build(["body", {}, ...tree]);
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  return doc;
}
