import { test } from "node:test";
import assert from "node:assert/strict";
import { MockFoClient } from "../../server/fo/mock.ts";
import { makeRig, organized } from "../helpers.ts";

// S3A-X1: mock mode ("npm run start:mock", the documented rehearsal) can't rehearse Step 3. When
// you answer Mock Fo's text inside Kiki, Mock Fo answers as if you'd asked about a contractor, and
// never relays a decision, so neither "go ahead" nor "no" does anything.

test("in mock mode, answering Mock Fo's text inside Kiki relays your decision and never talks about a contractor", async (t) => {
  const fo = new MockFoClient({ stepMs: 5, replyDelayMs: 0 });
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const view = await rig.app.view();
  const plan = view.plans.find((p) => p.status === "proposed");
  const note = view.notifications.find((n) => n.purpose === "find");
  assert.ok(plan && note, "Mock Fo was asked to text the proposal");
  assert.equal(note.reply?.status, "waiting");

  // The app offers "Answer Mock Fo about this proposal" (complete + waiting); you answer "go ahead".
  await rig.app.reply(note.taskId, "go ahead");
  await rig.app.settle();
  const after = (await rig.app.view()).notifications.find((n) => n.taskId === note.taskId)!;
  assert.deepEqual(
    { decision: after.reply?.status, planStatus: (await rig.app.view()).plans.find((p) => p.id === plan.id)?.status, question: after.question },
    { decision: "approved", planStatus: "applied", question: null },
    "Mock Fo relays your decision (labelled mock), so the rehearsal files the exact proposal, and it doesn't answer as if a contractor were involved",
  );
});
