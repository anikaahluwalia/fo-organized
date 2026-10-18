// Kiki organizes anything, not only paperwork with a project on it: a file that names no project
// goes where a file like it naturally goes (Kiki's suggestion, which you approve), keeps a good name
// of its own, and isn't buried in an "Other documents" level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { one } from "../server/db.ts";
import { isJunkName } from "../server/domain/naming.ts";
import { makeRig, organized } from "./helpers.ts";

test("a name that says nothing is junk; a name you gave a file isn't", () => {
  for (const n of ["IMG_2041.pdf", "scan_0012.pdf", "document (3).pdf", "Untitled.png", "1234567.jpg", "DSC_0042.JPG", "download (2).pdf"]) assert.equal(isJunkName(n), true, n);
  for (const n of ["ANIKA_AHLUWALIA_RESUME_SWE.pdf", "Screenshot 2026-10-18 at 2.02.22 PM.png", "invoice final FINAL.pdf", "kiki.png", "Tax return 2025.pdf"]) assert.equal(isJunkName(n), false, n);
});

test("a résumé with no project goes where Kiki suggests, keeps its name, and says it's her suggestion", async (t) => {
  const r = makeRig();
  r.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => r.app.close());
  await organized(r);
  const reader = r.app.ctx.reader;
  const read = reader.read.bind(reader);
  reader.read = async (content, name) => {
    const res = await read(content, name);
    if (name.includes("RESUME")) return { ...res, doc_type: "other", project: { value: null, quote: null }, kind: "Résumé", belongs_with: "Career" };
    if (name === "IMG_7781.png") return { ...res, doc_type: "other", project: { value: null, quote: null }, title: { value: "Boarding pass", quote: null }, kind: "Boarding pass", belongs_with: "Travel" };
    return res;
  };
  const root = one<{ root_file_id: string }>(r.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  r.drive.addFile("ANIKA_AHLUWALIA_RESUME_SWE.txt", root, "text/plain", "ANIKA AHLUWALIA\nSoftware engineer\nExperience");
  r.drive.addFile("IMG_7781.png", root, "text/plain", "BOARDING PASS\nYYZ to SFO");
  r.app.refreshInventory();
  await r.app.settle();
  const plan = (await r.app.view()).plans.find((p) => p.status === "proposed")!;
  const resume = plan.ops.find((o) => o.before?.name === "ANIKA_AHLUWALIA_RESUME_SWE.txt")!;
  assert.equal(resume.after?.path, "Projects/Career", "straight into the folder, no 'Other documents'");
  assert.equal(resume.after?.name, "ANIKA_AHLUWALIA_RESUME_SWE.txt", "its own name");
  assert.match(resume.reason ?? "", /Career: Kiki's suggestion for a résumé\./);
  const pass = plan.ops.find((o) => o.before?.name === "IMG_7781.png")!;
  assert.equal(pass.after?.path, "Projects/Travel");
  assert.equal(pass.after?.name, "Boarding pass.png", "a junk name gets what the file is");
});
