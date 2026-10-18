// What happened live on 2026-10-18: a background re-read gave filed documents titles taken from
// their headings ("QUOTE", "INVOICE"), Kiki proposed renaming 4 filed files, and Fo texted the user
// that 4 "new documents" were ready to file. None of that may happen again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { all, run } from "../server/db.ts";
import { mockRead, toFacts, type DocFacts } from "../server/domain/documents.ts";
import { meaningfulTitle, proposedName } from "../server/domain/naming.ts";
import { MockFoClient } from "../server/fo/mock.ts";
import { makeRig, organized } from "./helpers.ts";

test("a heading that only repeats the document's type never becomes part of a file name", () => {
  for (const heading of ["QUOTE", "ESTIMATE / QUOTE", "INVOICE", "QUOTE (REVISED)", "BUSINESS LICENCE", "SERVICE AGREEMENT", "Meeting notes"]) assert.equal(meaningfulTitle(heading), null, heading);
  for (const title of ["Induction and invariants", "Assignment 4", "Investor update"]) assert.equal(meaningfulTitle(title), title);
  const text = "QUOTE\nOakline Flooring Co.\nQuote No: Q-1042\nDate: 2026-09-28\nProject: Flooring";
  const read = mockRead(text);
  read.title = { value: "QUOTE", quote: "QUOTE" };
  assert.equal(proposedName(toFacts(read, text), "scan_0012.pdf", "application/pdf"), "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf");
});

test("a background re-read never renames a filed document, even when the reader now finds a title", async () => {
  const rig = makeRig();
  await organized(rig);
  // Make every document look read by an older Kiki, then have the reader report a real title.
  for (const d of all<{ id: string; facts_json: string }>(rig.db, "SELECT id, facts_json FROM documents WHERE facts_json IS NOT NULL")) {
    const { title: _t, refersTo: _r, validUntil: _v, version: _n, ...old } = JSON.parse(d.facts_json) as DocFacts;
    run(rig.db, "UPDATE documents SET facts_json = ? WHERE id = ?", JSON.stringify({ ...old, version: 2 }), d.id);
  }
  const reader = rig.app.ctx.reader;
  const read = reader.read.bind(reader);
  reader.read = async (content, name) => {
    const r = await read(content, name);
    return r.issuer.value ? { ...r, title: { value: `${r.issuer.value} paperwork`, quote: r.issuer.quote } } : r;
  };
  const plansBefore = (await rig.app.view()).plans.length;
  const names = [...rig.drive.files.values()].map((f) => f.name).sort();
  rig.app.refreshInventory();
  await rig.app.settle();
  const facts = all<{ facts_json: string }>(rig.db, "SELECT facts_json FROM documents WHERE facts_json IS NOT NULL").map((d) => JSON.parse(d.facts_json) as DocFacts);
  assert.ok(facts.every((f) => f.version === 3 && !f.title?.value), "names come from what was read when the file was filed");
  assert.equal((await rig.app.view()).plans.length, plansBefore, "no new proposal");
  assert.deepEqual([...rig.drive.files.values()].map((f) => f.name).sort(), names);
  rig.app.close();
});

test("Fo texts only about new documents, not about renaming ones already filed", async () => {
  const fo = new MockFoClient({ stepMs: 5, replyDelayMs: 0 });
  const rig = makeRig({ fo });
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  // A filed document now reads differently (a real title), so Kiki proposes renaming it.
  const filed = all<{ id: string; facts_json: string }>(rig.db, "SELECT id, facts_json FROM documents WHERE doc_type = 'quote' LIMIT 1")[0]!;
  const facts = JSON.parse(filed.facts_json) as DocFacts;
  run(rig.db, "UPDATE documents SET facts_json = ? WHERE id = ?", JSON.stringify({ ...facts, title: { value: "Main floor oak", quote: null, quoteFound: null } }), filed.id);
  rig.app.refreshInventory();
  await rig.app.settle();
  let view = await rig.app.view();
  assert.ok(view.plans.some((p) => p.status === "proposed" && p.ops.some((o) => o.kind === "move_rename")), "the rename is proposed in the app");
  assert.equal(view.notifications.length, 0, "but it isn't news: no text");

  // A new invoice arrives: that's worth a text, which also mentions the rename.
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  view = await rig.app.view();
  const text = view.notifications[0]?.text ?? "";
  assert.match(text, /^Kiki: a new invoice from Northside Building Supply/);
  assert.match(text, /rename or move 1 document already filed/);
  rig.app.close();
});
