import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3C-X10: the proposal Fo is asked to explain has the exact changes but not why. ROADMAP.md's
// flowchart: "Kiki prepares a proposal: exact changes, reasons, evidence" -> Fo "explains it and
// asks". newFindText (notify.ts:293-304) lists each move as from/to only; the reason is included
// for status changes alone. Here the reason is the part you'd want to check: the invoice names no
// project, and Kiki infers Flooring from the supplier's other document.

test("the proposal handed to Fo carries each step's reason, so Fo can explain why", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  fo.onAsk = async (_a, n) => reply(`kiki-${n}`, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();

  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  const move = plan.ops.find((o) => o.kind === "move_rename")!;
  assert.match(move.reason, /No project on it, but Northside Building Supply's other document is in Flooring/, "the app shows why");
  const request = fo.asks.find((a) => a.message.includes("Kiki approval handoff"))!.message;
  assert.ok(request.includes("No project on it, but Northside Building Supply's other document is in Flooring"), "and Fo is told why too");
});
