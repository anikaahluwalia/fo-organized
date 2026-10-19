// Step 1: reading documents of every kind. Kiki may miss a fact, but must never state one the
// document doesn't support. (The live Claude run is scripts/eval-reading.ts --live.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePdf } from "../server/demo/pdf.ts";
import { mockRead, namesReference, statesNumber, toFacts } from "../server/domain/documents.ts";
import { localText, ReadError } from "../server/extractor.ts";
import type { DriveContent } from "../server/google/types.ts";
import { READING_SET } from "../scripts/eval/reading-set.ts";
import { FIELDS, scoreCase } from "../scripts/eval/score.ts";
import { makeRig } from "./helpers.ts";

test("the reading set: the mock reader never invents a fact (misses are fine, it's a pattern reader)", () => {
  const invented: string[] = [];
  for (const c of READING_SET) {
    const content: DriveContent = c.format === "pdf" ? { kind: "pdf", data: makePdf(c.title ?? "", c.lines) } : { kind: "text", text: c.lines.join("\n") };
    const text = localText(content)!;
    const verdicts = scoreCase(c, toFacts(mockRead(text), text));
    for (const f of FIELDS) if (verdicts[f] === "invented") invented.push(`${c.id}.${f}`);
  }
  assert.deepEqual(invented, []);
});

test("a reference counts only when the quoted line names it as a whole token", () => {
  assert.equal(namesReference("Deposit (20%) for Quote Q-1042: $1,690.00", "Q-1042"), true);
  assert.equal(namesReference("quote q1042", "Q-1042"), true);
  assert.equal(namesReference("Quote Q-10421", "Q-1042"), false);
  assert.equal(namesReference("Quote AQ-1042", "Q-1042"), false);
  const text = "INVOICE\nOakline Flooring Co.\nInvoice No: INV-3307\nDeposit for Quote Q-10421: $1,690.00";
  const read = mockRead(text);
  read.refers_to = [{ doc_type: "quote", reference: "Q-1042", quote: "Deposit for Quote Q-10421: $1,690.00" }];
  assert.deepEqual(toFacts(read, text).refersTo, [], "a longer number isn't the reference");
});

test("a validity period counts only when the line states that number of days", () => {
  assert.equal(statesNumber("Valid for 30 days.", 30), true);
  assert.equal(statesNumber("Valid for 30 days.", 3), false);
  assert.equal(statesNumber("Valid for 1,000 days.", 1), false);
  const text = "QUOTE\nBright Floors Ltd.\nQuote No: BF-81\nDate: 2026-10-10\nValid for 30 days.";
  const read = mockRead(text);
  read.validity = { until: null, days: 3, quote: "Valid for 30 days." };
  assert.equal(toFacts(read, text).validUntil, null, "3 days isn't what it says");
});

test("a rate limit while reading puts the document back to be read again, instead of failing it", async () => {
  const rig = makeRig();
  const reader = rig.app.ctx.reader;
  const read = reader.read.bind(reader);
  let limited = 1;
  reader.read = async (content, name) => {
    if (limited-- > 0) throw new ReadError("Claude is rate-limiting requests. Kiki will try again.", { retryable: true });
    return read(content, name);
  };
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const status = () => rig.db.prepare("SELECT read_status AS s, COUNT(*) AS n FROM documents GROUP BY read_status").all() as { s: string; n: number }[];
  assert.ok(!status().some((r) => r.s === "failed"), "nothing is marked failed");
  // The retried read job (after its backoff) reads it.
  rig.db.prepare("UPDATE jobs SET run_after = ? WHERE state = 'queued'").run(new Date(0).toISOString());
  await rig.app.settle();
  assert.deepEqual(status().map((r) => r.s), ["read"]);
  rig.app.close();
});
