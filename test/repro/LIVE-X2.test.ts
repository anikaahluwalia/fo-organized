// LIVE-X2: choosing a folder Kiki already organized again ("Change folder", then the same link,
// or the side panel's "Organize this folder" after switching away) makes a brand-new workspace.
// Kiki reads every document again, forgets what you told her (an accepted price, which quote is
// current) and proposes a second index file next to the one she keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRig, organized } from "../helpers.ts";

const INDEX = "Flooring - document index (kept by Kiki).csv";

test("choosing the same folder again picks up where Kiki left off", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await organized(rig);
  const root = (rig.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id;
  const quote = (await rig.app.view()).inventory.files.find((f) => f.doc?.docType === "quote" && f.doc.issuer.value === "Oakline Flooring Co.")!;
  rig.app.acceptQuote(quote.doc!.docId, true);
  const readsBefore = rig.drive.calls.filter((c) => c.op === "readContent").length;

  // "Change folder", then paste the same folder link (or "Organize this folder" in the side panel).
  rig.app.clearWorkspace();
  await rig.app.selectWorkspace(`https://drive.google.com/drive/folders/${root}`);
  await rig.app.settle();

  // Press "Organize" as you would after picking the folder.
  let organize: string;
  try {
    organize = rig.app.proposeOrganize().message;
  } catch (err) {
    organize = `refused: ${(err as Error).message}`;
  }
  const view = await rig.app.view();
  const sameQuote = view.inventory.files.find((f) => f.fileId === quote.fileId);
  const proposed = view.plans.filter((p) => p.status === "proposed");
  const seen = {
    workspaces: (rig.db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE root_file_id = ?").get(root) as { n: number }).n,
    rereads: rig.drive.calls.filter((c) => c.op === "readContent").length - readsBefore,
    acceptedStillShown: Boolean(sameQuote?.doc?.acceptedAt),
    organize,
    proposedSteps: proposed.flatMap((p) => p.ops.map((o) => `${o.title}${o.after ? ` -> ${o.after.path}/${o.after.name}` : ""}`)),
    indexFileReadAsDocument: view.inventory.files.find((f) => f.name === INDEX)?.doc?.docType ?? null,
  };
  for (const p of proposed) rig.app.approvePlan(p.id, { contentHash: p.contentHash, clientRequestId: `again-${p.id}` });
  await rig.app.settle();
  const indexes = [...rig.drive.files.values()].filter((f) => f.name === INDEX && !f.trashed).length;

  assert.deepEqual(
    { workspaces: seen.workspaces, rereads: seen.rereads, acceptedStillShown: seen.acceptedStillShown, indexFiles: indexes },
    { workspaces: 1, rereads: 0, acceptedStillShown: true, indexFiles: 1 },
    `what happened: ${JSON.stringify({ ...seen, indexFiles: indexes })}`,
  );
});
