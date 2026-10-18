import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { all } from "../../server/db.ts";
import type { FoReply } from "../../server/fo/types.ts";
import { FakeFo, makeRig, organized, reply } from "../helpers.ts";

// S3C-X4: Kiki takes Fo's classification of your answer on trust, even when she relayed that
// answer herself and can see it isn't a yes. The report must quote "their exact words"
// (approval.ts:23), but checkTextReply never compares userReply with the answer you typed in Kiki
// (outreach.ts:301 relays it; notify.ts:167-185 approves on decision === "approved" alone).
// ROADMAP.md Step 3 asks to re-check "'not sure' approving" against the bound decision protocol.

const CONV = "conv-kiki-proposal";
const ROOT = "Renovation paperwork";
const INVOICE_NAME = "Northside invoice Oct 17.pdf";

async function answeredInKiki(t: TestContext, answer: string, foReports: (b: Record<string, string>) => string) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  t.after(() => rig.app.close());
  await organized(rig);
  rig.app.updateSettings({ autoText: true });
  fo.onAsk = async (args, n): Promise<FoReply> => {
    const b = /^\{"requestId".*\}$/m.exec(args.message)?.[0];
    if (args.conversationId && b) return reply(CONV, "complete", { response: `Thanks.\nKIKI-DECISION: ${foReports(JSON.parse(b) as Record<string, string>)}` });
    if (b) return reply(CONV, "working", { progress: "Waiting for your answer: should Kiki file the new Northside invoice in Projects/Flooring/Invoices?" });
    return reply(`conv-done-${n}`, "complete", { response: "Texted you.\nKIKI-STATUS: SENT" });
  };
  await rig.app.stageRevision("invoice");
  await rig.app.settle();
  const note = (await rig.app.view()).notifications.find((n) => n.purpose === "find")!;
  const invoiceId = [...rig.drive.files.values()].find((f) => f.name === INVOICE_NAME)!.id;
  await rig.app.reply(note.taskId, answer);
  await rig.app.settle();
  return { ...rig, invoiceId };
}

const report = (b: Record<string, string>, userReply: string) => JSON.stringify({ ...b, decision: "approved", userReply, actor: "account_holder", presentedExactProposal: true });

test("you asked a question in Kiki; Fo reports 'approved' quoting words you never typed: nothing is approved", async (t) => {
  const s = await answeredInKiki(t, "What is this invoice for?", (b) => report(b, "Go ahead"));
  assert.deepEqual(all(s.db, "SELECT plan_id FROM plan_approvals WHERE client_request_id NOT LIKE 'setup-%'"), [], "the report isn't linked to the answer you gave");
  assert.equal(s.drive.pathOf(s.invoiceId), `${ROOT}/${INVOICE_NAME}`);
});

test("you answered 'Not sure' in Kiki; Fo reports it as 'approved': nothing is approved", async (t) => {
  const s = await answeredInKiki(t, "Not sure", (b) => report(b, "Not sure"));
  assert.deepEqual(all(s.db, "SELECT plan_id FROM plan_approvals WHERE client_request_id NOT LIKE 'setup-%'"), [], "an unsure answer is never an approval");
  assert.equal(s.drive.pathOf(s.invoiceId), `${ROOT}/${INVOICE_NAME}`);
});
