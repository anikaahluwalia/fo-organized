// LIVE-X6: Drive leaves a folder's parent out of `parents` when you can't see that parent, which is
// the normal case for a folder someone shared with you ("Shared with me": say, your parents'
// renovation folder). selectWorkspace reads "no parents and no shared drive" as My Drive itself and
// refuses: "Choose a specific folder, not your whole Drive." In FakeDrive every folder has a parent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDrive } from "../../server/google/fake.ts";
import { makeRig } from "../helpers.ts";

test("a folder shared with you can be the workspace", async (t) => {
  const drive = new FakeDrive("mock");
  // Owned by someone else: Drive returns it with no parents, because you can't see their folder.
  const shared = drive.addFolder("Mum and Dad - renovation", "root", "1SharedFolderAbCdEfGh");
  drive.files.get(shared)!.parent = null;
  const rig = makeRig({ drive });
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });

  let sharedResult: string;
  try {
    sharedResult = `chosen: ${(await rig.app.selectWorkspace(`https://drive.google.com/drive/folders/${shared}?usp=sharing`)).name}`;
  } catch (err) {
    sharedResult = `refused: ${(err as Error).message}`;
  }
  // (My Drive itself must stay refused: Drive also returns it without parents. Compare with
  // getFile("root").id rather than with "has no parents".)
  assert.equal(sharedResult, "chosen: Mum and Dad - renovation");
});
