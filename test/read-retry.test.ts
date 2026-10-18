// A file Kiki couldn't read (say the Claude key was wrong) gets another try once that's fixed:
// when she starts, and when you ask her to look again. Then she proposes as usual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { one, run } from "../server/db.ts";
import { ReadError } from "../server/extractor.ts";
import { makeRig, organized } from "./helpers.ts";

test("files that failed to read are read again on Look again and on start, then proposed", async (t) => {
  const r = makeRig();
  r.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => r.app.close());
  await organized(r);
  const root = one<{ root_file_id: string }>(r.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  const reader = r.app.ctx.reader;
  const read = reader.read.bind(reader);
  reader.read = async () => {
    throw new ReadError("ANTHROPIC_API_KEY looks malformed: set it to the key alone, with no spaces or comment after it.");
  };
  const id = r.drive.addFile("Northside receipt.txt", root, "text/plain", "RECEIPT\nNorthside Building Supply\nReceipt No: R-1\nDate: 2026-10-10\nProject: Flooring\nTotal (CAD): $10.00");
  r.app.refreshInventory();
  await r.app.settle();
  assert.equal(one<{ read_status: string }>(r.db, "SELECT read_status FROM documents WHERE file_id = ?", id)?.read_status, "failed");
  assert.equal((await r.app.view()).plans.some((p) => p.status === "proposed"), false, "nothing to propose from a file she couldn't read");

  reader.read = read; // the key is fixed
  r.app.refreshInventory();
  await r.app.settle();
  assert.equal(one<{ read_status: string }>(r.db, "SELECT read_status FROM documents WHERE file_id = ?", id)?.read_status, "read");
  assert.ok((await r.app.view()).plans.some((p) => p.status === "proposed" && p.ops.some((o) => o.before?.name === "Northside receipt.txt")), "and proposed");

  run(r.db, "UPDATE documents SET read_status = 'failed' WHERE file_id = ?", id);
  r.app.recover();
  assert.equal(one<{ read_status: string }>(r.db, "SELECT read_status FROM documents WHERE file_id = ?", id)?.read_status, "pending", "on start too");
});
