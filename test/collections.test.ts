import { test } from "node:test";
import assert from "node:assert/strict";
import { isFiledPath, isSameCollection, words } from "../server/domain/collections.ts";

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
  for (const p of ["", "Old scans", "Downloads", "New folder", "Untitled folder", "Downloads/Misc"]) assert.ok(!isFiledPath(p), p);
});
