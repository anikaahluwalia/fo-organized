import { test } from "node:test";
import assert from "node:assert/strict";
import { mockRead, toFacts } from "../server/domain/documents.ts";
import { proposedName, targetFolder } from "../server/domain/naming.ts";
import { buildOrganizePlan, type PlanFile } from "../server/domain/plan.ts";
import { makeRig, organized } from "./helpers.ts";
import { run } from "../server/db.ts";

test("unfamiliar academic, work and personal collections can be organized and indexed", async (t) => {
  const rig = makeRig();
  t.after(() => { rig.app.close(); rig.db.close(); });
  const root = rig.drive.addFolder("Mixed workspace", "root");
  const cases = [
    { text: "NOTES\nTitle: Induction and invariants\nCourse: CS 245", project: "CS 245", folder: "Notes", title: "Induction and invariants" },
    { text: "REPORT\nTitle: Accessibility findings\nProject: Nimbus launch", project: "Nimbus launch", folder: "Reports", title: "Accessibility findings" },
    { text: "ITINERARY\nTitle: Train reservations\nEvent: Kyoto spring 2027", project: "Kyoto spring 2027", folder: "Itineraries", title: "Train reservations" },
  ];
  const ids = cases.map((c, i) => rig.drive.addFile(`scan-${i}.txt`, root, "text/plain", c.text));
  await rig.app.selectWorkspace(root);
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(plan);
  for (const id of ids) assert.equal(rig.drive.files.get(id)?.parent, root, "reading and proposing cannot move a file");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "general-documents" });
  await rig.app.settle();
  const view = await rig.app.view();
  for (const [i, c] of cases.entries()) {
    assert.equal(rig.drive.pathOf(ids[i]!), `Mixed workspace/Projects/${c.project}/${c.folder}/${c.title}.txt`);
    assert.equal(view.index.find((p) => p.name === c.project)?.rows.length, 1);
    assert.ok([...rig.drive.files.values()].some((f) => f.name === `${c.project} - document index (kept by Kiki).csv`));
  }
  assert.equal(view.plans.find((p) => p.id === plan.id)?.status, "applied");
});

test("unsupported title evidence cannot rename a file", () => {
  const text = "NOTES\nCourse: CS 245";
  const read = mockRead(text);
  read.title = { value: "Invented title", quote: "This is absent" };
  const facts = toFacts(read, text);
  assert.equal(facts.title?.value, null);
  assert.equal(proposedName(facts, "original.txt", "text/plain"), null);
});

test("projects retain distinct identities and unsafe labels cannot create nested paths", () => {
  const destinations = ["Flooring - 12 Cedar Lane", "Flooring - 20 Birch Lane", "CS 245", "CS 246"].map((name) => {
    const text = `NOTES\nProject: ${name}`;
    return targetFolder(toFacts(mockRead(text), text));
  });
  assert.equal(new Set(destinations).size, 4);
  const text = "NOTES\nProject: ../../outside";
  assert.equal(targetFolder(toFacts(mockRead(text), text)), null);
});

const file = (id: string, name: string, path = "", folder = false): PlanFile => ({
  fileId: id, name, path, isFolder: folder, isShortcut: false, parentId: "root", mimeType: "text/plain",
  version: id, createdTime: null, canRename: true, canMove: true,
});

test("legacy project folders are reused instead of relocated on upgrade", () => {
  const text = "NOTES\nTitle: Site notes\nProject: Flooring";
  const facts = toFacts(mockRead(text), text);
  const files = [file("legacy", "Renovations", "", true), file("project", "Flooring", "Renovations", true), file("notes", "Site notes.txt", "Renovations/Flooring/Notes")];
  const plan = buildOrganizePlan({ rootId: "root", files,
    docs: [{ docId: "notes", fileId: "notes", facts, readStatus: "read", readError: null, versionStatus: null }],
    indexFiles: { Flooring: { fileId: "index", version: "index-v1" } },
  });
  assert.equal(plan.ops.length, 0);
});

test("a shared author alone cannot assign academic notes to a project", () => {
  const text = "NOTES\nTitle: Lecture notes\nCourse: CS 245";
  const known = toFacts(mockRead(text), text);
  known.issuer = { value: "Same Author", quote: "Same Author", quoteFound: true };
  const unknown = { ...known, project: { value: null, quote: null, quoteFound: false } };
  const plan = buildOrganizePlan({ rootId: "root", files: [file("a", "a.txt"), file("b", "b.txt")],
    docs: [known, unknown].map((facts, i) => ({ docId: i ? "b" : "a", fileId: i ? "b" : "a", facts, readStatus: "read", readError: null, versionStatus: null })), indexFiles: {},
  });
  assert.equal(plan.ops.some((o) => o.fileId === "b"), false);
  assert.match(plan.notes.find((n) => n.fileId === "b")!.reason, /doesn't say which project or folder it belongs to/);
});

test("legacy stored project records keep their index when new documents arrive", async (t) => {
  const rig = makeRig();
  t.after(() => { rig.app.close(); rig.db.close(); });
  await organized(rig);
  const category = [...rig.drive.files.values()].find((f) => f.name === "Projects")!;
  rig.drive.touch(category.id, { name: "Renovations" });
  run(rig.db, "UPDATE projects SET category = 'Renovations'");
  const root = [...rig.drive.files.values()].find((f) => f.name === "Renovation paperwork")!;
  const id = rig.drive.addFile("notes.txt", root.id, "text/plain", "NOTES\nTitle: Measurements\nProject: Flooring");
  rig.app.refreshInventory();
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(plan);
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "legacy-arrival" });
  await rig.app.settle();
  assert.equal(rig.drive.pathOf(id), "Renovation paperwork/Renovations/Flooring/Notes/Measurements.txt");
  const projects = (await rig.app.view()).index.filter((p) => p.name === "Flooring");
  assert.equal(projects.length, 1);
  assert.ok([...rig.drive.files.values()].find((f) => f.name === "Flooring - document index (kept by Kiki).csv")?.content?.toString().includes("Measurements.txt"));
});
