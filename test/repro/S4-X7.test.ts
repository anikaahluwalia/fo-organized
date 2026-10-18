// S4-X7: a plan you approved by replying to Fo's text stops partway; Fo texts "the approved plan
// stopped ... I have not marked the plan done." You click Try again and it finishes, but Fo never
// texts that it's done: sendDoneText sends one text per plan, ever (notify.done.<plan>).
import { test } from "node:test";
import assert from "node:assert/strict";
import { kvSet } from "../../server/db.ts";
import { DriveError } from "../../server/google/types.ts";
import { makeRig } from "../helpers.ts";

test("after Try again finishes a plan you approved by text, Fo tells you it's done", async (t) => {
  const rig = makeRig();
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  // What checkTextReply records when Fo relays your "go ahead" for this exact plan.
  kvSet(rig.db, `notify.approved_by_text.${plan.id}`, "text-approval");
  const deposit = [...rig.drive.files.values()].find((f) => f.name === "Oakline invoice deposit.pdf")!.id;
  rig.drive.fail({ op: "update", fileId: deposit, mode: "error", error: new DriveError("Drive refused: you don't have permission to move this file.", "permission", { status: 403 }) });
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `fo-reply-${plan.id}` });
  await rig.app.settle();
  const texts = async () => (await rig.app.view()).notifications.filter((n) => n.purpose === "done").map((n) => n.text ?? "");
  assert.match((await texts()).join(" | "), /^Kiki: I couldn.t finish\. \d+ of \d+ steps are done/, "Fo told you it stopped");

  rig.app.resumePlan(plan.id);
  await rig.app.settle();
  assert.equal((await rig.app.view()).plans.find((p) => p.id === plan.id)?.status, "applied");
  assert.ok((await texts()).some((s) => /^Kiki: done/.test(s)), `the last thing Fo told you is still: ${(await texts()).join(" | ")}`);
});
