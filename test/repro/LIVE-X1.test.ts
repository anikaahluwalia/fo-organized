// LIVE-X1: one file Drive won't let you download (shared with you as viewer or commenter with
// "viewers can't download", or a Google Doc/Sheet too large to export) answers alt=media/export
// with a 403. Kiki treats that like a passing network problem: the document goes back to
// "pending" and the read job throws, forever. Because organizing waits until nothing is pending,
// she can't propose anything for the whole folder, by herself or when you press Organize.
// FakeDrive never refuses a download unless told to, so the tests never saw it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePdf } from "../../server/demo/pdf.ts";
import { DriveError } from "../../server/google/types.ts";
import { makeRig } from "../helpers.ts";

/** What LiveDrive.toError makes of Drive's 403 for a file the user may not download. */
const downloadRefused = (id: string) =>
  new DriveError(`Drive refused: The user does not have sufficient permissions for file ${id}..`, "permission", { status: 403, reason: "insufficientFilePermissions" });

test("a file Drive won't let you download is set aside as unreadable; the rest of the folder still gets organized", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  const root = (rig.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id;
  // Shared into the folder by someone else, view-only with downloads disabled.
  const locked = rig.drive.addFile(
    "Electrician quote (view only).pdf",
    root,
    "application/pdf",
    makePdf("QUOTE", ["Spark Electric", "Quote No: SE-12", "Date: 2026-10-02", "Project: Flooring", "Total (CAD): $900.00"]),
  );
  rig.drive.fail({ op: "readContent", fileId: locked, mode: "error", error: downloadRefused(locked), times: 1000 });

  await rig.app.settle();
  const view = await rig.app.view();
  const lockedDoc = view.inventory.files.find((f) => f.fileId === locked)?.doc;
  const plan = view.plans.find((p) => p.status === "proposed");
  let manual: string;
  try {
    manual = rig.app.proposeOrganize().message;
  } catch (err) {
    manual = `refused: ${(err as Error).message}`;
  }

  const readJob = rig.app.jobs.pending("read")[0];
  const seen = { lockedReadStatus: lockedDoc?.readStatus, proposedPlan: Boolean(plan), kiki: view.kiki.label, organizeButton: manual, readJobError: readJob?.last_error ?? null };
  assert.deepEqual(
    { lockedSetAside: seen.lockedReadStatus === "unreadable" || seen.lockedReadStatus === "failed", proposedPlan: seen.proposedPlan },
    { lockedSetAside: true, proposedPlan: true },
    `what happened: ${JSON.stringify(seen)}`,
  );
});
