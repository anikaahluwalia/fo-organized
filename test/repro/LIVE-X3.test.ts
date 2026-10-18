// LIVE-X3: Google Docs and Sheets have no md5Checksum, so LiveDrive uses their modifiedTime as the
// content key. Drive moves modifiedTime forward when a file is renamed (the Drive UI shows the
// rename as the last modification), so Kiki's own filing looks like an edit: right after she
// files a Google Doc she reads it again (another Claude call) and replaces its facts, though
// nobody touched it. FakeDrive hashes a Google Doc's content like a PDF, so tests never see this.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { GoogleAuth } from "../../server/google/oauth.ts";
import { LiveDrive } from "../../server/google/live.ts";
import { FakeDrive } from "../../server/google/fake.ts";
import { FOLDER_MIME, GOOGLE_DOC_MIME, SHORTCUT_MIME, type DriveFile } from "../../server/google/types.ts";
import { kvSet, openDb } from "../../server/db.ts";
import { makeRig } from "../helpers.ts";

const NATIVE = /^application\/vnd\.google-apps\./;
/** Drive's view of a Docs Editors file: no md5Checksum, so the content key is modifiedTime. */
const asLive = (f: DriveFile): DriveFile => (NATIVE.test(f.mimeType) && f.mimeType !== FOLDER_MIME && f.mimeType !== SHORTCUT_MIME ? { ...f, contentKey: f.modifiedTime } : f);

/** FakeDrive, except Google Docs look the way Drive v3 returns them (FakeDrive.update already moves modifiedTime). */
class LiveLikeDrive extends FakeDrive {
  async getFile(id: string) {
    return asLive(await super.getFile(id));
  }
  async listChildren(id: string) {
    return (await super.listChildren(id)).map(asLive);
  }
  async findChildFolders(parentId: string, name: string) {
    return (await super.findChildFolders(parentId, name)).map(asLive);
  }
  async update(id: string, change: { name?: string; addParent?: string; removeParent?: string }) {
    return asLive(await super.update(id, change));
  }
}

function stubFetch(t: TestContext, respond: (url: URL) => unknown): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
}

test("LiveDrive: a Google Doc's content key is its modifiedTime (Drive sends no md5Checksum for it)", async (t) => {
  const db = openDb(":memory:");
  kvSet(db, "google.oauth.tokens", JSON.stringify({ access_token: "token", expires_at: Date.now() + 3_600_000, refresh_token: "refresh", scope: "https://www.googleapis.com/auth/drive" }));
  const drive = new LiveDrive(new GoogleAuth(db, { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:8787/cb", scopes: ["https://www.googleapis.com/auth/drive"] }));
  stubFetch(t, () => ({ id: "doc1", name: "Trim invoice", mimeType: GOOGLE_DOC_MIME, parents: ["ws"], version: "7", modifiedTime: "2026-10-17T12:00:05.000Z", createdTime: "2026-10-17T11:00:00.000Z", size: "1024" }));
  const f = await drive.getFile("doc1");
  assert.equal(f.contentKey, "2026-10-17T12:00:05.000Z");
  db.close();
});

test("filing a Google Doc doesn't make Kiki read it again", async (t) => {
  const drive = new LiveLikeDrive("mock");
  const rig = makeRig({ drive });
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  await rig.app.createDemoWorkspace();
  const root = (rig.db.prepare("SELECT root_file_id FROM workspaces WHERE active = 1").get() as { root_file_id: string }).root_file_id;
  const doc = drive.addFile(
    "northside trim",
    root,
    GOOGLE_DOC_MIME,
    ["INVOICE", "Northside Building Supply", "Invoice No: N-5590", "Date: 2026-10-05", "Project: Flooring", "Details: Flooring materials", "", "Trim pieces: $50.00", "", "Total (CAD): $50.00"].join("\n"),
  );
  await rig.app.settle();
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed")!;
  const filing = plan.ops.find((o) => o.kind === "move_rename" && o.before?.name === "northside trim");
  assert.ok(filing, "the Google Doc is part of the plan");
  rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId: `approve-${plan.id}` });
  await rig.app.settle();
  const afterApply = (await rig.app.view()).inventory.files.find((f) => f.fileId === doc)?.doc?.readStatus;
  // The executor schedules a look at the folder 1 s after applying; the live app also looks every 10 s.
  rig.app.refreshInventory();
  await rig.app.settle();

  const view = await rig.app.view();
  assert.equal(view.plans.find((p) => p.id === plan.id)?.status, "applied");
  const reads = drive.calls.filter((c) => c.op === "readContent" && c.id === doc).length;
  const events = view.activity.events.map((e) => e.message).filter((m) => /read \d+ document/.test(m));
  assert.deepEqual(
    { statusRightAfterFiling: afterApply, downloadsAndReads: reads },
    { statusRightAfterFiling: "read", downloadsAndReads: 1 },
    `Kiki's reading log, newest first: ${JSON.stringify(events)}`,
  );
});
