// LIVE-X11: a folder you can only view (shared with you as Viewer or Commenter). Every file says
// canMove/canRename false, and the folder says canAddChildren false, which Kiki records but never
// checks. The planner still proposes creating "Projects/<collection>" folders and an index file in
// it; approving runs straight into Drive's 403. FakeDrive reports canAddChildren true for every
// folder and lets anyone create folders anywhere, so it never happens in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDrive } from "../../server/google/fake.ts";
import { DriveError, type DriveFile } from "../../server/google/types.ts";
import { makeRig } from "../helpers.ts";

/** Drive as a viewer of `root` sees it: nothing can be added to it. */
class ViewerDrive extends FakeDrive {
  root = "";
  asViewer(f: DriveFile): DriveFile {
    return f.id === this.root ? { ...f, capabilities: { ...f.capabilities, canAddChildren: false } } : f;
  }
  async getFile(id: string) {
    return this.asViewer(await super.getFile(id));
  }
  async listChildren(id: string) {
    return (await super.listChildren(id)).map((f) => this.asViewer(f));
  }
  async createFolder(input: { id?: string; name: string; parentId: string }) {
    if (input.parentId === this.root) {
      this.calls.push({ op: "createFolder", id: input.id });
      throw new DriveError(`Drive refused: The user does not have sufficient permissions for file ${this.root}..`, "permission", { status: 403, reason: "insufficientFilePermissions" });
    }
    return super.createFolder(input);
  }
}

test("in a folder you can only view, Kiki doesn't propose changes Drive won't allow", async (t) => {
  const drive = new ViewerDrive("mock");
  const rig = makeRig({ drive });
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace(); // stands in for "Shared with me": the folder and its files
  drive.root = (rig.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id;
  for (const f of drive.childrenOf(drive.root)) {
    f.canMove = false;
    f.canRename = false;
  }
  rig.app.refreshInventory();
  await rig.app.settle();

  let message: string;
  try {
    message = rig.app.proposeOrganize().message;
  } catch (err) {
    message = `refused: ${(err as Error).message}`;
  }
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  let approved = "";
  if (plan) {
    rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
    await rig.app.settle();
    const done = (await rig.app.view()).plans.find((p) => p.id === plan.id)!;
    approved = `; approving it ends "${done.status}": ${done.ops[0]?.error}`;
  }
  assert.equal(plan, undefined, `Kiki said "${message}" and proposed: ${JSON.stringify(plan?.ops.map((o) => o.title))}${approved}`);
});
