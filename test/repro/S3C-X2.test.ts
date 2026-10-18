import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3C-X2: once Fo's turn about a proposal is complete (it reported the text sent), your answer
// typed in Kiki is pushed into Fo's conversation with ask_fo without checking that Fo isn't
// working there now (outreach.ts:300 flips the task back to needs_user_input and continues). Fo's
// MCP instructions say not to send another ask_fo while a turn is working; Kiki's own follow-ups
// check first (engine.ts:79-91, startInConversation).

const CONV = "conv-kiki-proposal";
const TEXTED = "Texted you Kiki's message.\nKIKI-STATUS: SENT";

test("an answer typed in Kiki isn't pushed into a Fo turn that's still working", async (t) => {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  fo.onAsk = async (args) => (args.conversationId ? reply(CONV, "complete", { response: "Noted.\nKIKI-STATUS: NEED-INPUT" }) : reply(CONV, "complete", { response: TEXTED }));
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const note = (await rig.app.view()).notifications.find((n) => n.purpose === "find")!;
  assert.deepEqual([note.state, note.reply?.status], ["complete", "waiting"], "Fo texted you; the web app offers the answer box (App.tsx:615)");

  // Fo has started another turn in that conversation (say, it's relaying your text reply).
  fo.onPoll = async () => reply(CONV, "working", { progress: "Checking your text thread…" });

  let refused: unknown = null;
  try {
    await rig.app.reply(note.taskId, "Yes, go ahead.");
  } catch (err) {
    refused = err;
  }
  await rig.app.settle();
  assert.equal(fo.asks.length, 1, `nothing was sent into Fo's working turn (asks: ${JSON.stringify(fo.asks.map((a) => a.conversationId ?? "new"))}, polls before asking: ${fo.polls.length})`);
  assert.equal((refused as { status?: number } | null)?.status, 409, "and you're told Fo is still working there");
});
