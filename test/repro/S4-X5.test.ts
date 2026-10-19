// S4-X5: when a passing Drive problem outlasts the job's retries, the step Drive refused (a
// definite 503: nothing was applied) is left as "Uncertain: checking Drive", though nothing checks
// anything until you click Try again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../server/db.ts";
import { DriveError } from "../../server/google/types.ts";
import type { AppView } from "../../shared/api.ts";
import { makeRig } from "../helpers.ts";

// The side panel's view model (plain JavaScript, no type declarations).
type Step = { title: string; from: string | null; stateLabel: string; error: string | null };
const EXTENSION_LIB = "../../extension/lib.js";
const { buildModel } = (await import(EXTENSION_LIB)) as { buildModel: (view: AppView) => { broken: { steps: Step[] } | null } };

test("after the retries run out, a step Drive refused isn't labelled as Kiki checking Drive", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  const deposit = [...rig.drive.files.values()].find((f) => f.name === "Oakline invoice deposit.pdf")!.id;
  rig.drive.fail({ op: "update", fileId: deposit, mode: "error", error: new DriveError("Google Drive had a temporary problem.", "server", { status: 503 }), times: 3 });
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: "approve" });
  await rig.app.settle();
  for (let i = 0; i < 2; i++) {
    run(rig.db, "UPDATE jobs SET run_after = ? WHERE state = 'queued'", new Date(0).toISOString()); // the job's backoff, now
    await rig.app.settle();
  }
  const view = await rig.app.view();
  assert.equal(view.plans.find((p) => p.id === plan.id)?.status, "partial");
  assert.equal(view.busy.executing, false, "nothing is running any more");

  // The side panel and the web app share these step labels; the panel lists the unfinished steps under Needs you.
  const step = buildModel(view).broken?.steps.find((s) => s.from === "Oakline invoice deposit.pdf");
  assert.ok(step, "the refused step is listed");
  assert.doesNotMatch(step.stateLabel, /checking Drive/, `the step reads "${step.stateLabel}" (error: ${step.error})`);
});
