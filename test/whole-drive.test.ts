// Kiki watching your whole Drive: she organizes loose files (at the top of My Drive, or in catch-all
// folders like Downloads) into Projects or your own folders, and leaves what's in your folders alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { all } from "../server/db.ts";
import { makeRig } from "./helpers.ts";

const INVOICE = "INVOICE\nNorthside Building Supply\nInvoice No: N-5602\nDate: 2026-10-17\nProject: Flooring\nTotal (CAD): $96.40";

test("whole Drive: loose files are proposed, files in your own folders are left alone (and not even opened)", async (t) => {
  const r = makeRig();
  r.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => r.app.close());
  const school = r.drive.addFolder("School");
  r.drive.addFile("notes week 3.txt", school, "text/plain", "NOTES\nTitle: Lecture 3\nProject: CS 246");
  const downloads = r.drive.addFolder("Downloads");
  r.drive.addFile("Northside invoice.txt", "root", "text/plain", INVOICE);
  r.drive.addFile("invoice (1).txt", downloads, "text/plain", INVOICE.replace("N-5602", "N-5610"));
  await r.app.selectWorkspace("root");
  await r.app.settle();

  const ws = (await r.app.view()).workspace!;
  assert.equal(ws.name, "My Drive");
  const seen = all<{ name: string; path: string }>(r.db, "SELECT name, path FROM files WHERE present = 1").map((f) => `${f.path}/${f.name}`);
  assert.ok(seen.includes("/School"), "your folder is known, as a place to file into");
  assert.ok(!seen.includes("School/notes week 3.txt"), "but Kiki doesn't open it");
  assert.ok(seen.includes("Downloads/invoice (1).txt"), "a catch-all folder is opened");

  const plan = (await r.app.view()).plans.find((p) => p.status === "proposed")!;
  const moved = plan.ops.filter((o) => o.kind === "move_rename").map((o) => o.before?.name);
  assert.deepEqual(moved.sort(), ["Northside invoice.txt", "invoice (1).txt"].sort());
  assert.ok(plan.ops.filter((o) => o.kind === "move_rename").every((o) => o.after?.path.startsWith("Projects/Flooring")));
});
