import { test } from "node:test";
import assert from "node:assert/strict";
import { makePdf } from "../../server/demo/pdf.ts";
import { one } from "../../server/db.ts";
import { makeRig, organized } from "../helpers.ts";

// S3B-X3: after Kiki reads one new document, the activity log says
// "Mock reading read 1 document (3 invoice, 1 licence, 2 quote)": the breakdown counts every read
// document in the workspace (server/services/workspace.ts:371-373), not the ones just read.

test("the activity line for reading one new document describes that document, not the whole workspace", async (t) => {
  const rig = makeRig();
  t.after(() => rig.app.close());
  await organized(rig);
  const rootId = one<{ root_file_id: string }>(rig.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  rig.drive.addFile("Acme invoice.pdf", rootId, "application/pdf", makePdf("INVOICE", ["Acme Widgets Inc.", "Invoice No: A-100", "Date: 2026-10-15", "", "Total (CAD): $10.00"]));
  rig.app.refreshInventory();
  await rig.app.settle();

  const line = (await rig.app.view()).activity.events.find((e) => e.kind === "read")!.message;
  const counted = [...line.matchAll(/(\d+) (invoice|quote|licence|permit|receipt|contract|notes|report|other|unknown)\b/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  assert.match(line, /read 1 document/);
  assert.equal(counted, 1, `the line breaks down ${counted} documents: "${line}"`);
});
