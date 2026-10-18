import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePlace, isFiledPath, isSameCollection, words } from "../server/domain/collections.ts";

test("words compare spellings: case, punctuation and plurals ignored, letters and digits split", () => {
  assert.deepEqual(words("CS245 Lectures"), ["cs", "245", "lecture"]);
  assert.deepEqual(words("CS 245 - Logic and Computation"), ["cs", "245", "logic", "computation"]);
});

test("one project spelled two ways is one collection; different ones aren't", () => {
  assert.ok(isSameCollection("CS245", "CS 245 - Logic and Computation"));
  assert.ok(isSameCollection("Nimbus launch", "Nimbus launch website"));
  assert.ok(!isSameCollection("CS 245", "CS 246"));
  assert.ok(!isSameCollection("Nimbus launch", "Orbit migration"));
});

test("a file in a folder the user made is filed; at the top or in a catch-all folder it's waiting", () => {
  for (const p of ["Projects/Flooring/Quotes", "School", "School/CS 245", "Taxes", "Archive", "School/Old scans", "Scans 2019"]) assert.ok(isFiledPath(p), p);
  for (const p of ["", "Old scans", "Downloads", "New folder", "Untitled folder", "Downloads/Misc", "Projects", "Renovations"]) assert.ok(!isFiledPath(p), p);
});

test("a place you name is a folder you keep, a collection Kiki keeps (however spelled, or by its path), or a new one", () => {
  const folder = (path: string, name: string) => ({ path, name, isFolder: true, isShortcut: false });
  const files = [folder("", "School"), folder("School", "CS 245"), folder("", "Projects"), folder("Projects", "Flooring"), folder("Projects/Flooring", "Invoices")];
  assert.deepEqual(choosePlace("School/CS 245", files), { kind: "user", how: "choice", name: "CS 245", path: "School/CS 245", because: "School/CS 245" });
  assert.equal(choosePlace("cs 245", files)?.path, "School/CS 245");
  assert.equal(choosePlace("Projects/Flooring/Invoices", files)?.name, "Flooring");
  assert.equal(choosePlace("flooring invoices", files)?.name, "Flooring");
  assert.deepEqual(choosePlace("Kitchen", files), { kind: "kiki", how: "choice", name: "Kitchen", path: null, because: "Kitchen" });
  assert.equal(choosePlace("../outside", files), null);
});
