// S4-X1: two approved plans that each create the project's index make two index files with the
// same name. Here: the revised quote is in the messy folder from the start, and you say it's the
// current one before the first organizing plan runs, so both proposals plan to create the index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig } from "../helpers.ts";

const INDEX = "Flooring - document index (kept by Kiki).csv";

test("a filing plan and a quote update approved together leave one Flooring index in Drive", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  await rig.app.stageRevision("single");
  await rig.app.settle();
  const r1 = (await rig.app.view()).inventory.files.find((f) => f.name === "Oakline Flooring - revised quote.pdf")!.doc!.docId;
  rig.app.markCurrent(r1); // "This is the current one", from Needs a look
  const open = (await rig.app.view()).plans.filter((p) => p.status === "proposed");
  assert.deepEqual(open.map((p) => p.kind).sort(), ["organize", "version_update"]);
  assert.ok(open.every((p) => p.ops.some((o) => o.kind === "write_index" && o.title === "Create the project index file")), "both plan to create the index");
  for (const p of open) rig.app.approvePlan(p.id, { contentHash: p.contentHash, clientRequestId: `approve-${p.id}` });
  await rig.app.settle();

  const view = await rig.app.view();
  assert.deepEqual(view.plans.filter((p) => open.some((o) => o.id === p.id)).map((p) => p.status), ["applied", "applied"]);
  const indexes = [...rig.drive.files.values()].filter((f) => f.name === INDEX && !f.trashed).map((f) => rig.drive.pathOf(f.id));
  assert.equal(indexes.length, 1, `two index files with the same name: ${indexes.join(" | ")}`);
});
