import { test } from "node:test";
import assert from "node:assert/strict";
import { all, run } from "../server/db.ts";
import { findAttention, type AttentionDoc } from "../server/domain/attention.ts";
import { FACTS_VERSION, mockRead, toFacts, type DocFacts } from "../server/domain/documents.ts";
import { attentionItems } from "../server/services/attention.ts";
import { makeRig, organized } from "./helpers.ts";

function doc(id: string, text: string, extra: Partial<AttentionDoc> = {}): AttentionDoc {
  return { docId: id, fileName: `${id}.pdf`, project: "Flooring", readStatus: "read", readError: null, facts: toFacts(mockRead(text), text), versionStatus: null, acceptedAt: null, ...extra };
}

const QUOTE = "QUOTE\nOakline Flooring Co.\nQuote No: Q-1042\nDate: 2026-09-28\nTotal (CAD): $8,450.00\nValid for 30 days.";
const DEPOSIT = "INVOICE\nOakline Flooring Co.\nInvoice No: INV-3307\nDate: 2026-10-01\nDeposit (20%) for Quote Q-1042: $1,690.00\nAmount due (CAD): $1,690.00";
const BRIGHT = "ESTIMATE / QUOTE\nBright Floors Ltd.\nQuote No: BF-77\nDate: 2026-09-20\nTotal (CAD): $6,980.00";
const LICENCE = "BUSINESS LICENCE\nCity of Riverton\nLicence No: BL-2026-0193\nValid: 2026-01-01 to 2026-12-31";

test("facts: references to other documents and validity come with the line that supports them", () => {
  const deposit = toFacts(mockRead(DEPOSIT), DEPOSIT);
  assert.deepEqual(deposit.refersTo, [{ docType: "quote", reference: "Q-1042", quote: "Deposit (20%) for Quote Q-1042: $1,690.00" }]);
  const quote = toFacts(mockRead(QUOTE), QUOTE);
  assert.deepEqual(quote.refersTo, [], "never its own reference");
  assert.equal(quote.validUntil?.value, "2026-10-28", "30 days from its date");
  assert.equal(quote.validUntil?.basis, "days");
  assert.equal(toFacts(mockRead(LICENCE), LICENCE).validUntil?.value, "2026-12-31");
  // A reference whose evidence isn't in the document is dropped, not trusted.
  const read = mockRead(DEPOSIT);
  read.refers_to = [{ doc_type: "quote", reference: "Q-9999", quote: "Deposit for Quote Q-9999" }];
  assert.deepEqual(toFacts(read, DEPOSIT).refersTo, []);
});

test("attention: a referenced document that isn't in the folder", () => {
  const items = findAttention({ today: "2026-10-17", docs: [doc("inv", DEPOSIT)], busyDocIds: new Set() });
  const missing = items.find((i) => i.kind === "missing");
  assert.ok(missing);
  assert.equal(missing.title, "Quote Q-1042 isn't in the folder");
  assert.equal(missing.detail, "Invoice INV-3307 from Oakline Flooring Co. refers to it.");
  assert.equal(missing.evidence, "Deposit (20%) for Quote Q-1042: $1,690.00");
  // Present, or replaced by a revision that is: nothing missing.
  assert.ok(!findAttention({ today: "2026-10-17", docs: [doc("inv", DEPOSIT), doc("q", QUOTE)], busyDocIds: new Set() }).some((i) => i.kind === "missing"));
  const revision = "QUOTE (REVISED)\nOakline Flooring Co.\nQuote No: Q-1042-R1\nDate: 2026-10-17\nRevision 1 - replaces Quote Q-1042\nTotal (CAD): $7,980.00";
  assert.ok(!findAttention({ today: "2026-10-17", docs: [doc("inv", DEPOSIT), doc("r1", revision)], busyDocIds: new Set() }).some((i) => i.kind === "missing"));
});

test("attention: dates running out, counted from the document, and quiet once a price is accepted", () => {
  const docs = [doc("q", QUOTE), doc("lic", LICENCE, { project: null })];
  const items = findAttention({ today: "2026-10-17", docs, busyDocIds: new Set() });
  const quote = items.find((i) => i.key.startsWith("expiring:q:"));
  assert.ok(quote);
  assert.equal(quote.title, "Quote Q-1042 from Oakline Flooring Co. expires 2026-10-28, in 11 days");
  assert.equal(quote.detail, null, "the title says it all");
  assert.equal(quote.askDocId, "q");
  assert.ok(!items.some((i) => i.key.startsWith("expiring:lic:")), "a licence 75 days out isn't worth mentioning yet");
  const soon = findAttention({ today: "2026-12-10", docs, busyDocIds: new Set() }).find((i) => i.key.startsWith("expiring:lic:"));
  assert.equal(soon?.title, "Licence BL-2026-0193 from City of Riverton expires 2026-12-31, in 21 days", "but it is within 30 days");
  assert.equal(findAttention({ today: "2026-12-30", docs, busyDocIds: new Set() }).find((i) => i.key.startsWith("expiring:lic:"))?.title, "Licence BL-2026-0193 from City of Riverton expires 2026-12-31, tomorrow");
  const later = findAttention({ today: "2026-11-02", docs, busyDocIds: new Set() });
  assert.equal(later.find((i) => i.docIds.includes("q"))?.kind, "expired");
  // Accepted, superseded, or already being asked about: no nagging.
  assert.ok(!findAttention({ today: "2026-10-17", docs: [doc("q", QUOTE, { acceptedAt: "2026-10-10T00:00:00Z" })], busyDocIds: new Set() }).length);
  assert.ok(!findAttention({ today: "2026-10-17", docs: [doc("q", QUOTE, { versionStatus: "superseded" })], busyDocIds: new Set() }).length);
  assert.ok(!findAttention({ today: "2026-10-17", docs: [doc("q", QUOTE)], busyDocIds: new Set(["q"]) }).length);
});

test("attention: unclear quotes, from one contractor or several, are pointed out but never decided", () => {
  const r1 = "QUOTE\nOakline Flooring Co.\nQuote No: Q-1050\nDate: 2026-10-10\nTotal (CAD): $8,100.00";
  const same = findAttention({ today: "2026-12-01", docs: [doc("a", QUOTE), doc("b", r1)], busyDocIds: new Set() });
  const which = same.find((i) => i.kind === "which_current");
  assert.ok(which);
  assert.equal(which.title, "2 quotes from Oakline Flooring Co. for Flooring, and none is marked current");
  assert.equal(which.askDocId, "b", "the latest one");
  assert.ok(!findAttention({ today: "2026-12-01", docs: [doc("a", QUOTE), doc("b", r1, { versionStatus: "current" })], busyDocIds: new Set() }).some((i) => i.kind === "which_current"));

  const two = findAttention({ today: "2026-12-01", docs: [doc("a", QUOTE), doc("b", BRIGHT), doc("inv", DEPOSIT)], busyDocIds: new Set() });
  const undecided = two.find((i) => i.kind === "undecided");
  assert.ok(undecided);
  assert.equal(undecided.title, "Flooring: no quote accepted yet");
  assert.equal(undecided.detail, "Bright Floors Ltd. $6,980.00. Oakline Flooring Co. $8,450.00. Q-1042 already has an invoice.");
  assert.ok(!findAttention({ today: "2026-12-01", docs: [doc("a", QUOTE, { acceptedAt: "x" }), doc("b", BRIGHT)], busyDocIds: new Set() }).some((i) => i.kind === "undecided"));
});

test("the demo folder: Kiki points out the open decisions, then a missing quote when it disappears", async () => {
  const rig = makeRig();
  await organized(rig);
  const ws = rig.app.ctx.db.prepare("SELECT id FROM workspaces WHERE active = 1").get() as { id: string };
  let items = attentionItems(rig.app.ctx, ws.id, "2026-10-17");
  assert.deepEqual(
    items.map((i) => i.kind),
    ["expiring", "undecided"],
  );
  assert.ok((await rig.app.view()).attention.length >= 1, "shown in the app");

  // "Got it" hides an item until the situation changes.
  const undecided = items.find((i) => i.kind === "undecided")!;
  rig.app.dismissAttention(undecided.key);
  items = attentionItems(rig.app.ctx, ws.id, "2026-10-17");
  assert.ok(!items.some((i) => i.key === undecided.key));

  // The quote the deposit invoice is for goes missing from the folder.
  const quote = [...rig.drive.files.values()].find((f) => f.name.includes("Q-1042"))!;
  quote.trashed = true;
  rig.app.refreshInventory();
  await rig.app.settle();
  items = attentionItems(rig.app.ctx, ws.id, "2026-10-17");
  const missing = items.find((i) => i.kind === "missing");
  assert.ok(missing, "Kiki notices the gap");
  assert.equal(missing.title, "Quote Q-1042 isn't in the folder");
  rig.app.close();
});

test("facts read before references and validity existed get them in the background, without renaming anything", async () => {
  const rig = makeRig();
  await organized(rig);
  const db = rig.app.ctx.db;
  // Make every document look like it was read by an older Kiki.
  for (const d of all<{ id: string; facts_json: string }>(db, "SELECT id, facts_json FROM documents WHERE facts_json IS NOT NULL")) {
    const { refersTo: _r, validUntil: _v, version: _n, ...old } = JSON.parse(d.facts_json) as DocFacts;
    run(db, "UPDATE documents SET facts_json = ? WHERE id = ?", JSON.stringify(old), d.id);
  }
  const before = (await rig.app.view()).plans.length;
  const names = [...rig.drive.files.values()].map((f) => f.name).sort();
  rig.app.refreshInventory();
  await rig.app.settle();
  const facts = all<{ facts_json: string }>(db, "SELECT facts_json FROM documents WHERE facts_json IS NOT NULL").map((d) => JSON.parse(d.facts_json) as DocFacts);
  assert.ok(facts.every((f) => f.version === FACTS_VERSION));
  assert.ok(facts.some((f) => f.validUntil?.value === "2026-10-28"));
  assert.ok(facts.some((f) => f.refersTo?.some((r) => r.reference === "Q-1042")));
  const view = await rig.app.view();
  assert.equal(view.plans.length, before, "no new plan");
  assert.deepEqual([...rig.drive.files.values()].map((f) => f.name).sort(), names, "nothing renamed or added");
  assert.ok(view.activity.events.some((e) => e.message.includes("took another look")));
  rig.app.close();
});
