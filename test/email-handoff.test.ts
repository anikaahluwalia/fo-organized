// Files from email: Fo checks your Gmail (asking you first) and, when you say yes, shares the
// attachment and ends its reply with a hand-over line. Fo's webhook brings that to Kiki, who copies
// the one file into your folder; from there it's a new file like any other.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one } from "../server/db.ts";
import { handoffFileIds } from "../server/services/emailscout.ts";
import { receiveFoEvent } from "../server/services/fowebhook.ts";
import { FakeFo, makeRig, organized, reply } from "./helpers.ts";

const SHARED = "1AbCdEfGhIjKlMnOpQrStUvWxYz_shared01";
const TEXTED = "Texted you.\nKIKI-STATUS: SENT";
let delivery = 0;

async function setup(t: TestContext) {
  const fo = new FakeFo();
  const rig = makeRig({ fo });
  rig.app.ctx.watchIntervalSeconds = 3600;
  rig.app.ctx.foWebhook = true;
  t.after(() => rig.app.close());
  fo.onAsk = async (args, n) => reply(args.conversationId ?? `kiki-${n}`, "complete", { response: TEXTED });
  await organized(rig);
  // Fo's own Drive, outside the workspace: the attachment it shared with Kiki's account.
  rig.drive.addFile("Northside invoice N-5610.txt", "fo-drive-root", "text/plain", "INVOICE\nNorthside Building Supply\nInvoice No: N-5610\nDate: 2026-10-19\nProject: Flooring\nTotal (CAD): $310.00", SHARED);
  const hand = async (text: string, extra: Record<string, unknown> = {}) => {
    receiveFoEvent(rig.app.ctx, `msg_${++delivery}`, { type: "conversation.reply", occurredAt: new Date().toISOString(), reply: { conversationId: "imessage-thread", runId: `run_${delivery}`, channel: "imessage", trigger: "inbound_text", text, ...extra } });
    await rig.app.settle();
  };
  const copies = () => [...rig.drive.files.values()].filter((f) => f.name === "Northside invoice N-5610.txt" && f.id !== SHARED);
  return { rig, fo, hand, copies };
}

test("a hand-over line names one Google Drive file; anything else isn't one", () => {
  assert.deepEqual(handoffFileIds(`Shared it.\nKIKI-HANDOFF: https://drive.google.com/file/d/${SHARED}/view?usp=sharing`), [SHARED]);
  assert.deepEqual(handoffFileIds(`KIKI-HANDOFF: https://drive.google.com/open?id=${SHARED}`), [SHARED]);
  for (const bad of [`KIKI-HANDOFF: https://evil.example/file/d/${SHARED}`, `KIKI-HANDOFF: http://drive.google.com/file/d/${SHARED}`, `see KIKI-HANDOFF: https://drive.google.com/file/d/${SHARED}`, "KIKI-HANDOFF: https://drive.google.com/file/d/short"]) {
    assert.deepEqual(handoffFileIds(bad), [], bad);
  }
});

test("turning it on asks Fo to check twice a day, ask you first, share with your Kiki account, and hand over by that line", async (t) => {
  const s = await setup(t);
  await s.rig.app.setEmailScout(true);
  await s.rig.app.settle();
  const asked = s.fo.asks.find((a) => a.message.includes("Kiki email check"))!.message;
  assert.match(asked, /every day at 9:00 and 17:00/);
  assert.match(asked, /share it with demo@example\.com/);
  assert.match(asked, /text me one short message/);
  assert.match(asked, /Never forward, reply to, delete, label or change any email/);
  assert.match(asked, /KIKI-HANDOFF: <the shared file's Google Drive link>/);
  assert.equal(s.rig.app.emailScoutOn(), true);
});

test("Fo's hand-over brings that one file into the folder, once, and Kiki proposes where it goes", async (t) => {
  const s = await setup(t);
  await s.rig.app.setEmailScout(true);
  await s.rig.app.settle();
  await s.hand(`Done, I shared it with you.\nKIKI-HANDOFF: https://drive.google.com/file/d/${SHARED}/view`);
  assert.equal(s.copies().length, 1, "a copy in the folder");
  const root = one<{ root_file_id: string }>(s.rig.db, "SELECT root_file_id FROM workspaces WHERE active = 1")!.root_file_id;
  const placed = (await s.rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(placed?.ops.some((o) => o.before?.name === "Northside invoice N-5610.txt" && o.after?.path.startsWith("Projects/Flooring")), "proposed like any new file");
  assert.equal(s.rig.drive.files.get(SHARED)?.parent, "fo-drive-root", "Fo's file itself isn't moved");
  void root;
  await s.hand(`KIKI-HANDOFF: https://drive.google.com/file/d/${SHARED}/view`);
  assert.equal(s.copies().length, 1, "a second hand-over of the same file adds nothing");
  assert.equal(s.fo.asks.some((a) => a.message.includes("answered this by text")), false, "your yes to Fo isn't taken as an answer to a proposal");
});

test("with email checking off, a hand-over line does nothing", async (t) => {
  const s = await setup(t);
  await s.hand(`KIKI-HANDOFF: https://drive.google.com/file/d/${SHARED}/view`);
  assert.equal(s.copies().length, 0);
});
