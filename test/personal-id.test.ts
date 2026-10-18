// A personal ID's number (driver's licence, passport, health card…) stays on the document: never
// in the name Kiki gives it, the index, or a text. Those travel further than the document does.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocFacts, Fact } from "../server/domain/documents.ts";
import { checkComposed, plainText, type ComposeFacts } from "../server/domain/compose.ts";
import { isPersonalId, proposedName, withoutIdNumbers } from "../server/domain/naming.ts";

const known = <T>(value: T | null): Fact<T> => ({ value, quote: value === null ? null : String(value), quoteFound: value === null ? null : true });

function licence(title: string, reference: string | null): DocFacts {
  return {
    docType: "licence",
    title: known(title),
    issuer: known("Ontario"),
    reference: known(reference),
    date: known(null),
    total: { ...known(null), currency: null },
    project: known(null),
    scope: null,
    lineItems: [],
    revision: { isRevision: false, label: null, revisesReference: null, quote: null },
    aiDirectedText: [],
    textAvailable: true,
  };
}

test("a driver's licence is named without its number", () => {
  const f = licence("Driver's Licence", "A3558 - 06287 - 25717");
  assert.equal(isPersonalId(f), true);
  assert.equal(proposedName(f, "IMG_4410.jpg", "image/jpeg"), "Driver's Licence - Ontario.jpg");
  // Even when the number is in the title it states.
  assert.equal(proposedName(licence("Driver's Licence A3558-06287-25717", "A3558-06287-25717"), "scan.pdf", "application/pdf"), "Driver's Licence - Ontario.pdf");
});

test("a business licence is not a personal ID: its number stays in the name", () => {
  const f = { ...licence("BUSINESS LICENCE", "BL-2026-0193"), issuer: known("City of Riverton") };
  assert.equal(isPersonalId(f), false);
  assert.match(proposedName(f, "licence.pdf", "application/pdf")!, /BL-2026-0193/);
});

test("other personal IDs are recognized too", () => {
  for (const title of ["Passport", "Ontario Health Card", "Social Insurance Number", "Birth Certificate", "Permanent Resident Card", "Photo Card"]) {
    assert.equal(isPersonalId(licence(title, "123456789")), true, title);
  }
  assert.equal(withoutIdNumbers("Arti Ahluwalia licence A3558-06287-25717 front", "A3558-06287-25717"), "Arti Ahluwalia licence front");
});

test("a text that carries an ID number doesn't go out; Kiki's own never carries it", () => {
  const facts: ComposeFacts = {
    situation: "new",
    workspace: "Paperwork",
    answer: "reply_or_link",
    items: [{ n: 1, kind: "file", name: "Arti Ahluwalia licence.jpg", about: ["Driver's Licence", "Ontario"], folder: "Licences", renamedTo: "Driver's Licence - Ontario", never: ["A3558", "06287", "25717"] }],
  };
  const leaky = { text: `Kiki: File the Arti Ahluwalia licence (A3558-06287-25717) in Licences as "Driver's Licence - Ontario"? Reply yes, or tap to change it:`, names: [{ n: 1, shortName: "Arti Ahluwalia licence" }] };
  assert.match(checkComposed(facts, leaky).join(" "), /ID number/);
  const clean = { ...leaky, text: `Kiki: File the Arti Ahluwalia licence in Licences as "Driver's Licence - Ontario"? Reply yes, or tap to change it:` };
  assert.deepEqual(checkComposed(facts, clean), []);
  assert.doesNotMatch(plainText(facts), /3558|06287|25717/);
});
