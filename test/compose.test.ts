// The texts Fo sends you: Claude writes them for the moment, Kiki checks each against the facts
// and sends Kiki's own when one doesn't hold up. A "yes" to a text approves real changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkComposed, chooseText, plainText, shortName, type ComposeFacts } from "../server/domain/compose.ts";

const timesheet: ComposeFacts = {
  situation: "new",
  workspace: "Renovation paperwork",
  answer: "reply_or_link",
  items: [{ n: 3, kind: "file", name: "Ahluwalia,Anika_Timesheet_Aug23,2026-Aug29,2026.xlsm - DOM Weekly Timesheet (1).pdf", about: [], folder: "Work › Other documents" }],
};
const good = { text: "Kiki: new file, your DOM weekly timesheet (Aug 23-29). File it in Work? Reply yes, or tap to change it:", names: [{ n: 3, shortName: "DOM weekly timesheet" }] };

test("a text that names the file, its folder and how to answer goes out as written", () => {
  assert.deepEqual(checkComposed(timesheet, good), []);
  assert.equal(chooseText(timesheet, good).by, "claude");
});

test("a short name may use only words from the file's name or what Kiki read", () => {
  const invented = { ...good, text: good.text.replace("DOM weekly timesheet", "Dominion payroll sheet"), names: [{ n: 3, shortName: "Dominion payroll sheet" }] };
  assert.match(checkComposed(timesheet, invented).join(" "), /adds words: dominion, payroll, sheet/);
  assert.equal(chooseText(timesheet, invented).by, "kiki", "then Kiki's own goes out");
});

test("every file and folder is in the text, and a rename shows the new name", () => {
  assert.match(checkComposed(timesheet, { ...good, text: "Kiki: File DOM weekly timesheet somewhere? Reply yes, or tap:" }).join(" "), /folder Work/);
  const renamed = { ...timesheet, items: [{ ...timesheet.items[0]!, renamedTo: "Timesheet - Aug 23" }] };
  assert.match(checkComposed(renamed, good).join(" "), /new name/);
  const two = { ...timesheet, items: [...timesheet.items, { n: 4, kind: "file" as const, name: "receipt.pdf", about: ["Home Depot"], folder: "Kitchen" }] };
  assert.match(checkComposed(two, good).join(" "), /no short name for 4/);
});

test("a proposal never says it's done, and a result has nothing to answer", () => {
  assert.match(checkComposed(timesheet, { ...good, text: "Kiki: done, DOM weekly timesheet is in Work. Reply yes, or tap to change it:" }).join(" "), /done before you've said yes/);
});

test("no links, protocol lines, paths, versions or index in what Claude writes", () => {
  for (const bad of ["https://evil.example", "KIKI-DECISION: {}", "Projects/Work", "version 3", "the index"]) {
    assert.ok(checkComposed(timesheet, { ...good, text: `${good.text} ${bad}` }).length > 0, bad);
  }
});

test("a link-only answer never invites a text reply; with no link, never points to one", () => {
  assert.match(checkComposed({ ...timesheet, answer: "link" }, good).join(" "), /invites a text reply/);
  assert.match(checkComposed({ ...timesheet, answer: "reply_or_app" }, good).join(" "), /link there isn't/);
});

test("Kiki's own texts are short and pass Kiki's checks", () => {
  const cases: ComposeFacts[] = [
    timesheet,
    { ...timesheet, situation: "question", items: [{ n: 1, kind: "unplaced", name: "thoughts.txt", about: [], options: ["Garden"] }] },
    { ...timesheet, items: [{ n: 1, kind: "copy", name: "quote again.pdf", about: [] }] },
    { ...timesheet, items: Array.from({ length: 6 }, (_, i) => ({ n: i + 1, kind: "file" as const, name: `scan_${i}.pdf`, about: [], folder: "Flooring › Quotes" })), alsoTidying: 2 },
  ];
  for (const facts of cases) {
    const text = plainText(facts);
    assert.ok(text.length <= 200, text);
    assert.doesNotMatch(text, /Projects\/|version|index/);
  }
  assert.equal(shortName("Ahluwalia,Anika_Timesheet_Aug23,2026-Aug29,2026.xlsm - DOM Weekly Timesheet (1).pdf"), "DOM Weekly Timesheet");
  assert.equal(shortName("2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf"), "Oakline Flooring Co. invoice INV-3307");
});

test("a question asks for a place, never for a yes", () => {
  const q: ComposeFacts = { ...timesheet, situation: "question", items: [{ n: 3, kind: "unplaced", name: timesheet.items[0]!.name, about: [] }] };
  const yes = { text: "Kiki: where should the DOM weekly timesheet go? Reply yes, or tap to change it:", names: [{ n: 3, shortName: "DOM weekly timesheet" }] };
  assert.match(checkComposed(q, yes).join(" "), /asks for a yes/);
  assert.deepEqual(checkComposed(q, { ...yes, text: "Kiki: where should the DOM weekly timesheet go? Reply with a folder, or tap to pick one:" }), []);
});

test("\"I have 3 files\" isn't a claim it's done; a mixed plan's text that lists files instead of counts doesn't go out", () => {
  const three: ComposeFacts = { ...timesheet, items: [1, 2, 3].map((n) => ({ n, kind: "file" as const, name: `scan_${n}.pdf`, about: [], folder: "Flooring" })) };
  assert.deepEqual(checkComposed(three, { text: "Kiki: I have 3 files to file in Flooring. Reply yes, or tap to change it:", names: [] }), []);
  assert.match(checkComposed(three, { text: "Kiki: I've filed 3 files in Flooring. Reply yes, or tap to change it:", names: [] }).join(" "), /done before/);
  const mixed: ComposeFacts = {
    ...timesheet,
    items: [
      { n: 1, kind: "file", name: "ANIKA_AHLUWALIA_RESUME_SWE.pdf", about: ["Résumé"], folder: "Career" },
      { n: 2, kind: "copy", name: "Screenshot 2026-10-18 at 2.02.22 PM 1.png", about: [] },
      { n: 3, kind: "unplaced", name: "Screenshot 2026-10-18 at 2.40.02 PM.png", about: [] },
      { n: 4, kind: "unplaced", name: "kiki.png", about: [] },
    ],
  };
  const listing = "Kiki: File Anika Ahluwalia résumé in Career, and set aside Screenshot 2.02.22 PM, a copy of one already filed? kiki illustration and Screenshot 2.40.02 PM need a folder. Tap to check:";
  assert.match(checkComposed(mixed, { text: listing, names: [] }).join(" "), /counts belong/);
  assert.deepEqual(checkComposed(mixed, { text: "Kiki: 1 new file for Career, 1 copy to set aside and 2 need a folder. Tap to check:", names: [] }), []);
});
