// LIVE-X10: before creating a folder, the executor asks Drive for a child folder with that name
// (files.list q="name = 'Projects'") and adopts the oldest match. Drive's query matching ignores
// case (GAM's Drive query reference: "All matches are case-insensitive"), but the planner and the
// executor's check compare names exactly. A workspace that already has a "projects" folder: Kiki
// plans a new "Projects", Drive hands back "projects", the check sees a different name and fails
// the step, and every move into it is skipped. FakeDrive matches names exactly, so it never happens there.
// The stub below only changes that one query to behave case-insensitively. Worth one live check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDrive } from "../../server/google/fake.ts";
import { FOLDER_MIME } from "../../server/google/types.ts";
import { makeRig } from "../helpers.ts";

class CaseInsensitiveQueryDrive extends FakeDrive {
  async findChildFolders(parentId: string, name: string) {
    this.calls.push({ op: "findChildFolders", id: parentId });
    const matches = this.childrenOf(parentId).filter((f) => f.mimeType === FOLDER_MIME && f.name.toLowerCase() === name.toLowerCase());
    return Promise.all(matches.map((f) => this.getFile(f.id)));
  }
}

test("a workspace that already has a lowercase \"projects\" folder still gets organized", async (t) => {
  const drive = new CaseInsensitiveQueryDrive("mock");
  const rig = makeRig({ drive });
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  const root = (rig.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id;
  drive.addFolder("projects", root); // the user's own, older folder
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
  await rig.app.settle();
  const done = (await rig.app.view()).plans.find((p) => p.id === plan.id)!;
  const failed = done.ops.filter((o) => o.state === "failed" || o.state === "skipped").map((o) => `${o.title}: ${o.error}`);
  assert.equal(done.status, "applied", `plan ${done.status}; ${done.counts.verified} of ${done.counts.total} verified; ${JSON.stringify(failed.slice(0, 3))}`);
});

test("for comparison: FakeDrive's exact-case query creates a second \"Projects\" folder and the plan applies", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  const root = (rig.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id;
  rig.drive.addFolder("projects", root);
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === plan.id)?.status, "applied");
  assert.deepEqual(rig.drive.childrenOf(root).filter((f) => f.mimeType === FOLDER_MIME).map((f) => f.name).sort(), ["Projects", "projects"]);
});
