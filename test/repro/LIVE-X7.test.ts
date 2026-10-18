// LIVE-X7: Kiki watches the folder with an "inventory" job that reschedules itself only when it
// succeeds. A failure retries with backoff (2, 4, 8, 16, 32 s) and after 6 attempts the job is
// "failed" for good. So about a minute of trouble (laptop asleep or offline, Wi-Fi switching,
// Google 5xx, or Google sign-in expiring, which happens every 7 days for an app in Testing) and
// Kiki silently stops noticing new files, until you press "Look again" or restart her. Reconnecting
// Google doesn't restart it either. Tests run with folder watching off, and FakeDrive never drops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../server/app.ts";
import { openDb } from "../../server/db.ts";
import { MockReader } from "../../server/extractor.ts";
import { MockFoClient } from "../../server/fo/mock.ts";
import { FakeDrive } from "../../server/google/fake.ts";
import { DriveError } from "../../server/google/types.ts";

test("after a minute offline, Kiki goes back to watching the folder by herself", async (t) => {
  const db = openDb(":memory:");
  const drive = new FakeDrive("mock");
  const app = createApp({
    db,
    drive,
    reader: new MockReader(),
    fo: new MockFoClient({ stepMs: 5, replyDelayMs: 0 }),
    anthropicModel: "test-model",
    claudeCredentialsDetected: false,
    engineOptions: { pollWaitSeconds: 0, backoffBaseMs: 1 },
    workspacePollSeconds: 10, // as live: look at the folder every 10 s
  });
  t.after(() => {
    app.close();
    db.close();
  });
  await app.createDemoWorkspace();
  await app.settle();
  const ws = db.prepare("SELECT id, root_file_id FROM workspaces WHERE active = 1").get() as { id: string; root_file_id: string };
  const key = `inventory:${ws.id}`;
  assert.equal(app.jobs.get(key)?.state, "queued", "watching: the next look is scheduled");

  // Offline: every look fails the way LiveDrive reports it ("Couldn't reach Google Drive").
  drive.fail({ op: "getFile", fileId: ws.root_file_id, mode: "error", error: new DriveError("Couldn't reach Google Drive (getaddrinfo ENOTFOUND www.googleapis.com).", "network", { delivery: "not_sent" }), times: 6 });
  const due = () => db.prepare("UPDATE jobs SET run_after = ? WHERE dedupe_key = ?").run(new Date(Date.now() - 1000).toISOString(), key);
  for (let i = 0; i < 6; i++) {
    due(); // the backoff delay has passed
    await app.jobs.runDue();
  }
  // Back online. A new file lands in the folder.
  drive.addFile("New invoice.pdf", ws.root_file_id, "application/pdf", Buffer.from("%PDF-1.4"));
  due();
  await app.jobs.runDue();

  const job = app.jobs.get(key);
  const sawNewFile = Boolean(db.prepare("SELECT 1 FROM files WHERE workspace_id = ? AND name = 'New invoice.pdf'").get(ws.id));
  assert.deepEqual({ watching: job?.state === "queued", sawNewFile }, { watching: true, sawNewFile: true }, `inventory job: state=${job?.state}, attempts=${job?.attempts}, last error=${job?.last_error}`);
});
