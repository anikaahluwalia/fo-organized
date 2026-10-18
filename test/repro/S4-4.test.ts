// S4-4: a project can be inferred from any folder under Renovations.
// "Renovations" is in KIKI_ROOTS for Kiki's earlier layout, but nothing checks that Kiki made it.
// Here it's the user's own folder, with subfolders they keep ("Receipts", "Photos").
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { all } from "../../server/db.ts";
import { makePdf } from "../../server/demo/pdf.ts";
import { NEW_SUPPLIER_INVOICE } from "../../server/demo/renovation.ts";
import type { FakeDrive } from "../../server/google/fake.ts";
import { makeRig, type TestRig } from "../helpers.ts";

const NORTHSIDE_RECEIPT = ["Northside Building Supply", "Receipt No: R-2201", "Date: 2026-09-12", "", "Paint, 2 cans: $60.00", "", "Total (CAD): $60.00"];

function newRig(t: TestContext): TestRig {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

/** "Home paperwork", with the user's own Renovations/<sub> folder holding a Northside receipt they filed. */
function userRenovationsFolder(drive: FakeDrive, sub: string) {
  const root = drive.addFolder("Home paperwork", "root");
  const renovations = drive.addFolder("Renovations", root);
  const folder = drive.addFolder(sub, renovations);
  drive.addFile("northside receipt.pdf", folder, "application/pdf", makePdf("RECEIPT", NORTHSIDE_RECEIPT));
  return { root, folder };
}

const kikiIndexes = (drive: FakeDrive) => [...drive.files.values()].filter((f) => f.name.endsWith("- document index (kept by Kiki).csv")).map((f) => drive.pathOf(f.id));
const projectOfEachDocument = (rig: TestRig) =>
  all<{ type: string; project: string | null }>(rig.db, "SELECT d.doc_type AS type, p.name AS project FROM documents d LEFT JOIN projects p ON p.id = d.project_id ORDER BY d.doc_type");

test("a supplier's invoice isn't given a project named after your own folder under Renovations", async (t) => {
  const rig = newRig(t);
  const { root, folder } = userRenovationsFolder(rig.drive, "Receipts");
  rig.drive.addFile(NEW_SUPPLIER_INVOICE.fileName, root, "application/pdf", makePdf(NEW_SUPPLIER_INVOICE.title, NEW_SUPPLIER_INVOICE.lines)); // no project on it
  await rig.app.selectWorkspace(root);
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(plan, "Kiki proposes filing the invoice (next to Northside's receipt is fine)");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "file-it" });
  await rig.app.settle();

  assert.deepEqual(
    projectOfEachDocument(rig).filter((d) => d.project === "Receipts"),
    [],
    "the invoice's project was inferred from the name of your folder Renovations/Receipts",
  );
  assert.deepEqual(kikiIndexes(rig.drive), [], "Kiki wrote a project index into your own folder");
  assert.deepEqual(
    rig.drive.childrenOf(folder).filter((f) => f.mimeType === "application/vnd.google-apps.folder").map((f) => f.name),
    [],
    "Kiki made her own type folder inside your folder",
  );
  assert.deepEqual((await rig.app.view()).index.map((p) => p.name), [], "no project named after your folder in Kiki's index");
});

test("Propose a plan doesn't offer to write a project index into your own Renovations subfolder", async (t) => {
  const rig = newRig(t);
  const { root } = userRenovationsFolder(rig.drive, "Photos");
  await rig.app.selectWorkspace(root);
  await rig.app.settle();

  const result = rig.app.proposeOrganize(); // you click "Propose a plan"; everything is already filed
  const plan = (await rig.app.view()).plans.find((p) => p.id === result.planId);
  assert.deepEqual(
    plan?.ops.map((o) => `${o.kind}: ${o.after?.path}/${o.after?.name}`) ?? [],
    [],
    "Kiki treats Renovations/Photos as a project of hers and proposes an index for it",
  );
});
