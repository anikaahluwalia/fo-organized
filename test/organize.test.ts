import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { one } from "../server/db.ts";
import { makePdf } from "../server/demo/pdf.ts";
import { AppError } from "../server/errors.ts";
import { FakeDrive, type FakeOp } from "../server/google/fake.ts";
import { DriveError, type DriveFile } from "../server/google/types.ts";
import { executePlan } from "../server/services/executor.ts";
import type { OpView, PlanView } from "../shared/api.ts";
import { makeRig, organized, tempDbPath, type TestRig } from "./helpers.ts";

/*
 * The organizing guarantees from docs/FO-RGANIZED-BRIEF.md, end to end through the app:
 * FakeDrive + mock reader, jobs run deterministically with app.settle().
 */

const WORKSPACE = "Renovation paperwork";
const INVOICES = "Renovations/Flooring/Invoices";
const QUOTES = "Renovations/Flooring/Quotes";
const INDEX = "Flooring - document index (kept by Kiki).csv";
const MUTATIONS: FakeOp[] = ["createFolder", "update", "createFile", "updateContent"];

const OAKLINE_BALANCE = [
  "Oakline Flooring Co.",
  "Invoice No: INV-3400",
  "Date: 2026-10-05",
  "Project: Flooring - main floor, 12 Cedar Lane",
  "",
  "Balance for Quote Q-1042: $500.00",
  "",
  "Amount due (CAD): $500.00",
];
const ACME_INVOICE = ["Acme Widgets Inc.", "Invoice No: A-100", "Date: 2026-10-15", "", "Widgets, 4: $10.00", "", "Total (CAD): $10.00"];
const NORTHSIDE_KITCHEN = ["Northside Building Supply", "Invoice No: N-5590", "Date: 2026-10-08", "Project: Kitchen cabinets", "", "Cabinet hinges, 12: $80.00", "", "Total (CAD): $80.00"];

// Helpers ---------------------------------------------------------------------------------

/** A rig that is closed when the test ends, pass or fail. */
function newRig(t: TestContext, opts: Parameters<typeof makeRig>[0] = {}): TestRig {
  const rig = makeRig(opts);
  t.after(() => {
    rig.app.close();
    rig.db.close();
  });
  return rig;
}

/** Starts Kiki again on the same database file and the same Drive, and lets her recover. */
async function restarted(t: TestContext, dbPath: string, drive: FakeDrive): Promise<TestRig> {
  const rig = newRig(t, { drive, db: dbPath });
  rig.app.recover();
  await rig.app.settle();
  return rig;
}

/** The one live file or folder with this name in Drive. */
function only(drive: FakeDrive, name: string) {
  const found = [...drive.files.values()].filter((f) => f.name === name && !f.trashed);
  assert.equal(found.length, 1, `expected exactly one "${name}" in Drive, found ${found.length}`);
  return found[0]!;
}

const inWorkspace = (...parts: string[]) => [WORKSPACE, ...parts].filter(Boolean).join("/");

function addPdf(drive: FakeDrive, parent: string, name: string, title: string, lines: string[]): string {
  return drive.addFile(name, parent, "application/pdf", makePdf(title, lines));
}

async function planById(rig: TestRig, id: string): Promise<PlanView> {
  const plan = (await rig.app.view()).plans.find((p) => p.id === id);
  assert.ok(plan, `plan ${id} isn't in the view`);
  return plan;
}

async function proposal(rig: TestRig): Promise<PlanView> {
  const plan = (await rig.app.view()).plans.find((p) => p.status === "proposed");
  assert.ok(plan, "expected an open proposal");
  return plan;
}

/** The demo folder, inventoried and read, with Kiki's first proposal open (nothing applied). */
async function proposed(rig: TestRig): Promise<PlanView> {
  await rig.app.createDemoWorkspace();
  await rig.app.settle();
  return proposal(rig);
}

async function appliedPlan(rig: TestRig): Promise<PlanView> {
  const plan = (await rig.app.view()).plans.find((p) => p.status === "applied");
  assert.ok(plan, "expected an applied plan");
  return plan;
}

function approve(rig: TestRig, plan: PlanView, clientRequestId = `approve-${plan.id}`) {
  return rig.app.approvePlan(plan.id, { contentHash: plan.contentHash, clientRequestId });
}

/** The move/rename step for the file that was called beforeName when the plan was made. */
function step(plan: PlanView, beforeName: string): OpView {
  const op = plan.ops.find((o) => o.kind === "move_rename" && o.before?.name === beforeName);
  assert.ok(op, `no step moves "${beforeName}"`);
  return op;
}

function callsSince(drive: FakeDrive, mark: number, op?: FakeOp) {
  return drive.calls.slice(mark).filter((c) => !op || c.op === op);
}

/** Every Drive call since mark that could have changed something. */
function mutations(drive: FakeDrive, mark: number) {
  return drive.calls.slice(mark).filter((c) => MUTATIONS.includes(c.op));
}

function planStatus(rig: TestRig, id: string): string | undefined {
  return one<{ status: string }>(rig.db, "SELECT status FROM plans WHERE id = ?", id)?.status;
}

function countRows(rig: TestRig, sql: string, ...params: string[]): number {
  return one<{ n: number }>(rig.db, sql, ...params)!.n;
}

const refusedWith = (code: string) => (err: unknown) => err instanceof AppError && err.code === code;
const conflictError = (err: unknown) => err instanceof AppError && err.status === 409;
const permissionDenied = () => new DriveError("Drive refused: you don't have permission to move this file.", "permission", { status: 403 });

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

/** The document rows of the Flooring index Kiki wrote to Drive, keyed by column name. */
function indexRows(drive: FakeDrive): Record<string, string>[] {
  const [header, ...rest] = parseCsv(only(drive, INDEX).content?.toString("utf8") ?? "");
  assert.ok(header, "the index has a header row");
  const rows: Record<string, string>[] = [];
  for (const r of rest) {
    if (r.length === 1 && r[0] === "") break; // blank line before Kiki's footer
    rows.push(Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
  }
  return rows;
}

/**
 * A Drive that applies one chosen change and then never answers, as if Kiki's process died just
 * after Google applied it. The app that made the call is abandoned; a new one starts on the same
 * database file, like a restart.
 */
class CrashingDrive extends FakeDrive {
  crashOnUpdateOf: string | null = null;
  crashOnFolderNamed: string | null = null;
  private onCrash: () => void = () => {};
  readonly crashed = new Promise<void>((resolve) => {
    this.onCrash = resolve;
  });

  async update(id: string, change: { name?: string; addParent?: string; removeParent?: string }): Promise<DriveFile> {
    if (id !== this.crashOnUpdateOf) return super.update(id, change);
    this.crashOnUpdateOf = null;
    await super.update(id, change);
    this.onCrash();
    return new Promise<DriveFile>(() => {});
  }

  async createFolder(input: { id?: string; name: string; parentId: string }): Promise<DriveFile> {
    if (input.name !== this.crashOnFolderNamed) return super.createFolder(input);
    this.crashOnFolderNamed = null;
    await super.createFolder(input);
    this.onCrash();
    return new Promise<DriveFile>(() => {});
  }
}

// 1. Duplicate input ------------------------------------------------------------------------

describe("duplicate input does not duplicate operations", () => {
  test("re-proposing an organized workspace finds nothing to change, even after a fresh look at Drive", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    const plans = countRows(rig, "SELECT COUNT(*) AS n FROM plans");
    const mark = rig.drive.calls.length;

    const again = rig.app.proposeOrganize();
    assert.equal(again.planId, null);
    assert.match(again.message, /Nothing to change/);

    rig.app.refreshInventory();
    await rig.app.settle();
    assert.equal(rig.app.proposeOrganize().planId, null);
    assert.equal(countRows(rig, "SELECT COUNT(*) AS n FROM plans"), plans, "no new plan or version");
    assert.deepEqual(mutations(rig.drive, mark), []);
  });

  test("proposing the same changes twice, or reading the same folder again, returns the same plan, not a new version", async (t) => {
    const rig = newRig(t);
    const first = await proposed(rig);
    const files = rig.drive.files.size;

    const again = rig.app.proposeOrganize();
    assert.deepEqual([again.planId, again.created], [first.id, false]);
    assert.equal(rig.app.proposeOrganize().planId, first.id);
    await rig.app.createDemoWorkspace(); // the same messy folder, set up and read again
    await rig.app.settle();

    const open = await proposal(rig);
    assert.deepEqual([open.id, open.version, open.contentHash], [first.id, 1, first.contentHash]);
    assert.equal(countRows(rig, "SELECT COUNT(*) AS n FROM plans"), 1);
    assert.equal(rig.drive.files.size, files, "no duplicate files were added");
  });

  test("approving twice with different request ids records one approval and runs every step once", async (t) => {
    const rig = newRig(t);
    const plan = await proposed(rig);
    const mark = rig.drive.calls.length;

    const clicks = [approve(rig, plan, "click-1"), approve(rig, plan, "click-2"), approve(rig, plan, "click-1")];
    assert.deepEqual(
      clicks.map((c) => [c.planId, c.created]),
      [
        [plan.id, true],
        [plan.id, false],
        [plan.id, false],
      ],
    );
    await rig.app.settle();
    assert.equal(approve(rig, plan, "click-after-it-finished").created, false);
    await rig.app.settle();

    assert.equal((await planById(rig, plan.id)).status, "applied");
    assert.equal(countRows(rig, "SELECT COUNT(*) AS n FROM plan_approvals WHERE plan_id = ?", plan.id), 1);
    assert.equal(callsSince(rig.drive, mark, "createFolder").length, 4, "one call per planned folder");
    const moved = callsSince(rig.drive, mark, "update").map((c) => c.id);
    assert.equal(moved.length, 4);
    assert.equal(new Set(moved).size, 4, "each file was moved exactly once");
  });

  test("re-running the execute job of an applied plan creates no folders and moves nothing", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    const plan = await appliedPlan(rig);
    const mark = rig.drive.calls.length;

    rig.app.jobs.enqueue("execute_plan", `execute:${plan.id}`, { planId: plan.id });
    await rig.app.settle();
    await executePlan(rig.app.ctx, plan.id);
    rig.app.recover();
    await rig.app.settle();

    assert.equal((await planById(rig, plan.id)).status, "applied");
    assert.deepEqual(mutations(rig.drive, mark), []);
    assert.throws(() => rig.app.resumePlan(plan.id), conflictError, "a finished plan can't be resumed");
  });

  test("a folder someone created meanwhile is reused, not created a second time", async (t) => {
    const rig = newRig(t);
    const plan = await proposed(rig);
    const root = only(rig.drive, WORKSPACE).id;
    const theirs = rig.drive.addFolder("Renovations", root);

    approve(rig, plan);
    await rig.app.settle();

    assert.equal((await planById(rig, plan.id)).status, "applied");
    assert.deepEqual(
      rig.drive.childrenOf(root).filter((f) => f.name === "Renovations").map((f) => f.id),
      [theirs],
    );
    assert.equal(only(rig.drive, "Flooring").parent, theirs);
    assert.equal(rig.drive.pathOf(only(rig.drive, "Invoices").id), inWorkspace(INVOICES));
    const view = await rig.app.view();
    assert.equal(view.inventory.files.find((f) => f.fileId === theirs)?.origin, "found", "Kiki doesn't claim a folder she didn't make");
  });
});

// 2. Modified plans --------------------------------------------------------------------------

describe("a modified plan invalidates its approval", () => {
  test("renaming a step makes a new version; the old version and the old hash can't be approved", async (t) => {
    const rig = newRig(t);
    const v1 = await proposed(rig);
    const deposit = only(rig.drive, "Oakline invoice deposit.pdf").id;
    const seq = step(v1, "Oakline invoice deposit.pdf").seq;

    const { planId } = rig.app.revisePlan(v1.id, [{ seq, newName: "Oakline deposit" }]);
    const v2 = await planById(rig, planId);
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.version, 2);
    assert.notEqual(v2.contentHash, v1.contentHash);
    assert.equal(step(v2, "Oakline invoice deposit.pdf").after?.name, "Oakline deposit.pdf");
    assert.equal(planStatus(rig, v1.id), "superseded");

    const mark = rig.drive.calls.length;
    assert.throws(() => approve(rig, v1, "approve-old-version"), refusedWith("stale_plan"));
    assert.throws(() => rig.app.approvePlan(v2.id, { contentHash: v1.contentHash, clientRequestId: "approve-old-hash" }), refusedWith("hash_mismatch"));
    await rig.app.settle();
    assert.deepEqual(mutations(rig.drive, mark), [], "a refused approval changes nothing");
    assert.equal(countRows(rig, "SELECT COUNT(*) AS n FROM plan_approvals"), 0);

    approve(rig, v2);
    assert.throws(() => rig.app.revisePlan(v2.id, [{ seq, newName: "Something else" }]), refusedWith("stale_plan"), "an approved plan can't be edited");
    await rig.app.settle();
    assert.equal(rig.drive.pathOf(deposit), inWorkspace(INVOICES, "Oakline deposit.pdf"));
  });

  test("excluding a folder also excludes the moves into it, and nothing is created there", async (t) => {
    const rig = newRig(t);
    const v1 = await proposed(rig);
    const invoicesFolder = v1.ops.find((o) => o.kind === "create_folder" && o.after?.name === "Invoices");
    assert.ok(invoicesFolder);

    const { planId } = rig.app.revisePlan(v1.id, [{ seq: invoicesFolder.seq, exclude: true }]);
    const v2 = await planById(rig, planId);
    const movesTo = (path: string) => v2.ops.filter((o) => o.kind === "move_rename" && o.after?.path === path).map((o) => o.state);
    assert.deepEqual(movesTo(INVOICES), ["excluded", "excluded"]);
    assert.deepEqual(movesTo(QUOTES), ["pending", "pending"]);

    approve(rig, v2);
    await rig.app.settle();
    assert.equal((await planById(rig, planId)).status, "applied");
    assert.equal([...rig.drive.files.values()].some((f) => f.name === "Invoices"), false, "no Invoices folder was created");
    assert.equal(rig.drive.pathOf(only(rig.drive, "Oakline invoice deposit.pdf").id), inWorkspace("Oakline invoice deposit.pdf"));
    assert.equal(rig.drive.pathOf(only(rig.drive, "invoice final FINAL.pdf").id), inWorkspace("invoice final FINAL.pdf"));
    assert.equal(rig.drive.pathOf(only(rig.drive, "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf").id), inWorkspace(QUOTES, "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf"));
  });

  test("a proposal replaced because a new file arrived can't be approved under the old review", async (t) => {
    const rig = newRig(t);
    const v1 = await proposed(rig);
    addPdf(rig.drive, only(rig.drive, WORKSPACE).id, "Oakline balance.pdf", "INVOICE", OAKLINE_BALANCE);
    rig.app.refreshInventory();
    await rig.app.settle();

    const v2 = await proposal(rig);
    assert.notEqual(v2.id, v1.id);
    assert.ok(v2.ops.some((o) => o.before?.name === "Oakline balance.pdf"));
    assert.throws(() => approve(rig, v1, "approve-what-i-saw"), refusedWith("stale_plan"));
    assert.throws(() => rig.app.approvePlan(v2.id, { contentHash: v1.contentHash, clientRequestId: "approve-old-hash" }), refusedWith("hash_mismatch"));
  });

  test(
    "a background look at Drive keeps your edits to a proposal",
    async (t) => {
      const rig = newRig(t);
      const v1 = await proposed(rig);
      const bright = only(rig.drive, "IMG_2041.pdf").id;
      const { planId } = rig.app.revisePlan(v1.id, [
        { seq: step(v1, "Oakline invoice deposit.pdf").seq, newName: "Oakline deposit" },
        { seq: step(v1, "IMG_2041.pdf").seq, exclude: true },
      ]);

      rig.app.refreshInventory(); // what the background poll does every few seconds; nothing in Drive changed
      await rig.app.settle();

      const open = await proposal(rig);
      assert.equal(open.id, planId, "your revised version is still the open proposal");
      assert.equal(step(open, "Oakline invoice deposit.pdf").after?.name, "Oakline deposit.pdf");
      assert.equal(step(open, "IMG_2041.pdf").state, "excluded");
      approve(rig, open);
      await rig.app.settle();
      assert.equal(rig.drive.pathOf(bright), inWorkspace("IMG_2041.pdf"), "the file you excluded wasn't moved");
    },
  );

  test(
    "a name you type that's already used in the destination doesn't create two files with that name",
    async (t) => {
      const rig = newRig(t);
      const v1 = await proposed(rig);
      const taken = step(v1, "invoice final FINAL.pdf").after!.name; // what the Northside invoice will be called
      let revisedId: string;
      try {
        revisedId = rig.app.revisePlan(v1.id, [{ seq: step(v1, "Oakline invoice deposit.pdf").seq, newName: taken }]).planId;
      } catch (err) {
        assert.ok(err instanceof AppError && err.status === 400, "refusing the name is fine too");
        return;
      }
      approve(rig, await planById(rig, revisedId));
      await rig.app.settle();
      const names = rig.drive.childrenOf(only(rig.drive, "Invoices").id).map((f) => f.name.toLowerCase());
      assert.equal(new Set(names).size, names.length, `two files share a name in Invoices: ${names.join(" | ")}`);
    },
  );

  test(
    "excluding one file keeps the project index step for the files that do move",
    async (t) => {
      const rig = newRig(t);
      const v1 = await proposed(rig);
      const { planId } = rig.app.revisePlan(v1.id, [{ seq: step(v1, "IMG_2041.pdf").seq, exclude: true }]);
      const v2 = await planById(rig, planId);
      assert.equal(v2.ops.find((o) => o.kind === "write_index")?.state, "pending", "the index step is still in the plan");

      approve(rig, v2);
      await rig.app.settle();
      assert.equal((await planById(rig, planId)).status, "applied");
      const rows = indexRows(rig.drive);
      assert.equal(rows.length, 4);
      assert.equal(rows.find((r) => r.Reference === "BF-77")?.Folder, "(workspace folder)", "the excluded quote is listed where it is");
    },
  );
});

// 3. Workspace boundary ----------------------------------------------------------------------

describe("out-of-workspace operations are rejected", () => {
  test("a destination folder moved out of the workspace after proposing is refused, and the file stays put", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    await rig.app.stageRevision("invoice");
    await rig.app.settle();
    const plan = await proposal(rig);
    const invoice = only(rig.drive, "Northside invoice Oct 17.pdf").id;
    rig.drive.touch(only(rig.drive, "Renovations").id, { parent: "root" }); // someone drags it into My Drive

    const mark = rig.drive.calls.length;
    approve(rig, plan);
    await rig.app.settle();

    const after = await planById(rig, plan.id);
    assert.equal(after.status, "failed");
    const move = step(after, "Northside invoice Oct 17.pdf");
    assert.equal(move.state, "failed");
    assert.match(move.error ?? "", /outside the workspace/);
    assert.equal(after.ops.find((o) => o.kind === "write_index")?.state, "skipped");
    assert.deepEqual(mutations(rig.drive, mark), [], "nothing in Drive changed");
    assert.equal(rig.drive.pathOf(invoice), inWorkspace("Northside invoice Oct 17.pdf"));
  });

  test("a file whose folder was moved out of the workspace after proposing isn't moved", async (t) => {
    const rig = newRig(t);
    await rig.app.createDemoWorkspace();
    const oldScans = rig.drive.addFolder("Old scans", only(rig.drive, WORKSPACE).id);
    const balance = addPdf(rig.drive, oldScans, "scan_0099.pdf", "INVOICE", OAKLINE_BALANCE);
    await rig.app.settle();
    const plan = await proposal(rig);
    assert.equal(step(plan, "scan_0099.pdf").before?.path, "Old scans");
    rig.drive.touch(oldScans, { parent: "root" });

    const mark = rig.drive.calls.length;
    approve(rig, plan);
    await rig.app.settle();

    const after = await planById(rig, plan.id);
    const move = step(after, "scan_0099.pdf");
    assert.equal(move.state, "failed");
    assert.match(move.error ?? "", /outside the workspace/);
    assert.equal(after.status, "partial");
    assert.equal(callsSince(rig.drive, mark, "update").some((c) => c.id === balance), false);
    assert.equal(rig.drive.pathOf(balance), "Old scans/scan_0099.pdf");
  });

  test("files outside the workspace are never read or changed, even through shortcuts inside it", async (t) => {
    const rig = newRig(t);
    const personal = addPdf(rig.drive, "root", "Northside invoice (cottage).pdf", "INVOICE", ["Northside Building Supply", "Invoice No: N-9001", "Project: Flooring for the cottage"]);
    const privateFolder = rig.drive.addFolder("Private");
    const privateFile = addPdf(rig.drive, privateFolder, "tax notice.pdf", "NOTICE", ["Notice of assessment"]);
    await rig.app.createDemoWorkspace();
    const root = only(rig.drive, WORKSPACE).id;
    const fileShortcut = rig.drive.addShortcut("Cottage invoice", root, personal);
    const folderShortcut = rig.drive.addShortcut("Private", root, privateFolder);
    await rig.app.settle();
    const plan = await proposal(rig);
    approve(rig, plan);
    await rig.app.settle();

    assert.equal((await planById(rig, plan.id)).status, "applied");
    const touched = new Set(rig.drive.calls.map((c) => c.id));
    for (const id of [personal, privateFolder, privateFile]) assert.equal(touched.has(id), false, `Kiki called Drive about ${rig.drive.pathOf(id)}`);
    assert.equal(plan.ops.some((o) => o.before?.name === "Cottage invoice" || o.before?.name === "Private"), false, "shortcuts are never moved");
    assert.equal(rig.drive.pathOf(fileShortcut), inWorkspace("Cottage invoice"));
    assert.equal(rig.drive.pathOf(folderShortcut), inWorkspace("Private"));
    assert.equal(rig.drive.pathOf(personal), "Northside invoice (cottage).pdf");
  });

  test(
    "a shortcut in the workspace is listed in the proposal as left in place",
    async (t) => {
      const rig = newRig(t);
      await rig.app.createDemoWorkspace();
      rig.drive.addShortcut("Quote shortcut", only(rig.drive, WORKSPACE).id, only(rig.drive, "scan_0012.pdf").id);
      await rig.app.settle();
      const note = (await proposal(rig)).notes.find((n) => n.name === "Quote shortcut");
      assert.equal(note?.status, "left_in_place");
      assert.match(note?.reason ?? "", /shortcut/i);
    },
  );

  test(
    "resuming a plan doesn't move files into a Kiki folder that has since left the workspace",
    async (t) => {
      const rig = newRig(t);
      const plan = await proposed(rig);
      const deposit = only(rig.drive, "Oakline invoice deposit.pdf").id;
      rig.drive.fail({ op: "update", fileId: deposit, mode: "error", error: permissionDenied() });
      approve(rig, plan);
      await rig.app.settle();
      assert.equal((await planById(rig, plan.id)).status, "partial");
      rig.drive.touch(only(rig.drive, "Renovations").id, { parent: "root" }); // later, someone drags Kiki's folder into My Drive

      const mark = rig.drive.calls.length;
      rig.app.resumePlan(plan.id);
      await rig.app.settle();

      assert.equal(rig.drive.pathOf(deposit), inWorkspace("Oakline invoice deposit.pdf"), "the file stays in the workspace");
      assert.equal(callsSince(rig.drive, mark, "update").some((c) => c.id === deposit), false);
      const move = step(await planById(rig, plan.id), "Oakline invoice deposit.pdf");
      assert.equal(move.state, "failed");
      assert.match(move.error ?? "", /outside the workspace/);
    },
  );
});

// 4. Concurrent changes ----------------------------------------------------------------------

describe("concurrent file changes stop stale operations", () => {
  /** The first plan, approved after someone renamed the Bright Floors quote (step 7 of 9). */
  async function renamedBeforeApproval(t: TestContext) {
    const rig = newRig(t);
    const plan = await proposed(rig);
    const bright = only(rig.drive, "IMG_2041.pdf").id;
    rig.drive.touch(bright, { name: "Bright Floors laminate.pdf" });
    approve(rig, plan);
    await rig.app.settle();
    return { rig, plan, bright };
  }

  test("a file renamed after preview stops the plan: its step is stale, later steps are skipped, earlier steps stay verified", async (t) => {
    const { rig, plan, bright } = await renamedBeforeApproval(t);
    const after = await planById(rig, plan.id);
    const staleSeq = step(after, "IMG_2041.pdf").seq;

    assert.equal(after.status, "stale");
    for (const op of after.ops) {
      const expected = op.seq < staleSeq ? "verified" : op.seq === staleSeq ? "stale" : "skipped";
      assert.equal(op.state, expected, `step ${op.seq}: ${op.title}`);
    }
    assert.match(step(after, "IMG_2041.pdf").error ?? "", /renamed to "Bright Floors laminate\.pdf"/);
    // Drive shows exactly the partial state the plan reports.
    assert.equal(rig.drive.pathOf(bright), inWorkspace("Bright Floors laminate.pdf"));
    assert.equal(rig.drive.pathOf(only(rig.drive, "scan_0012.pdf").id), inWorkspace("scan_0012.pdf"));
    assert.ok(only(rig.drive, "2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf"));
    assert.equal((await rig.app.view()).kiki.state, "needs_clarification");
  });

  test("after a fresh look at Drive, the refreshed proposal starts from the changed file and finishes the job", async (t) => {
    const { rig, plan, bright } = await renamedBeforeApproval(t);
    rig.app.refreshInventory();
    await rig.app.settle();

    const next = await proposal(rig);
    assert.notEqual(next.id, plan.id);
    assert.deepEqual(next.ops.filter((o) => o.kind === "move_rename").map((o) => o.before?.name).sort(), ["Bright Floors laminate.pdf", "scan_0012.pdf"]);
    assert.equal(next.ops.filter((o) => o.kind === "create_folder").length, 0, "the folders from the stopped plan are reused");
    approve(rig, next);
    await rig.app.settle();
    assert.equal((await planById(rig, next.id)).status, "applied");
    assert.equal(rig.drive.pathOf(bright), inWorkspace(QUOTES, "2026-09-20 Quote - Bright Floors Ltd. - BF-77.pdf"));
  });

  test("a file whose content was edited after preview isn't moved", async (t) => {
    const rig = newRig(t);
    const plan = await proposed(rig);
    const scan = only(rig.drive, "scan_0012.pdf").id;
    // Someone saves a new version of the quote over the old one.
    await rig.drive.updateContent(scan, "application/pdf", makePdf("QUOTE", ["Oakline Flooring Co.", "Quote No: Q-1042", "Total (CAD): $9,100.00"]));
    approve(rig, plan);
    await rig.app.settle();

    const after = await planById(rig, plan.id);
    assert.equal(after.status, "stale");
    assert.equal(step(after, "scan_0012.pdf").state, "stale");
    assert.match(step(after, "scan_0012.pdf").error ?? "", /edited/);
    assert.equal(rig.drive.pathOf(scan), inWorkspace("scan_0012.pdf"));
  });

  test("an index someone edited in Drive isn't overwritten", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    await rig.app.stageRevision("invoice");
    await rig.app.settle();
    const plan = await proposal(rig);
    const index = only(rig.drive, INDEX).id;
    await rig.drive.updateContent(index, "text/csv", "Dad's notes,keep these\r\n");
    approve(rig, plan);
    await rig.app.settle();

    const after = await planById(rig, plan.id);
    assert.equal(after.status, "partial");
    assert.equal(step(after, "Northside invoice Oct 17.pdf").state, "verified");
    const write = after.ops.find((o) => o.kind === "write_index");
    assert.equal(write?.state, "failed");
    assert.match(write?.error ?? "", /didn't overwrite/);
    assert.equal(rig.drive.files.get(index)?.content?.toString("utf8"), "Dad's notes,keep these\r\n");
  });
});

// 5. Partial failures ------------------------------------------------------------------------

describe("partial failures remain visible and recoverable", () => {
  /** The first plan, approved while Drive refuses to move the Oakline deposit invoice. */
  async function partialPlan(t: TestContext) {
    const rig = newRig(t);
    const plan = await proposed(rig);
    const deposit = only(rig.drive, "Oakline invoice deposit.pdf").id;
    rig.drive.fail({ op: "update", fileId: deposit, mode: "error", error: permissionDenied() });
    approve(rig, plan);
    await rig.app.settle();
    return { rig, plan, deposit };
  }

  test("a permission error on one move leaves the plan partial, with the error on that step and the other steps verified", async (t) => {
    const { rig, plan, deposit } = await partialPlan(t);
    const view = await rig.app.view();
    const after = view.plans.find((p) => p.id === plan.id)!;

    assert.equal(after.status, "partial");
    const failed = step(after, "Oakline invoice deposit.pdf");
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /permission/);
    // The index still lists what did happen (the CSV doesn't lag the verified moves).
    const index = after.ops.find((o) => o.kind === "write_index")!;
    assert.equal(index.state, "verified");
    assert.deepEqual(
      after.ops.filter((o) => o !== failed && o !== index).map((o) => o.state),
      Array(7).fill("verified"),
    );
    assert.equal(after.canResume, true);
    assert.equal(rig.drive.pathOf(deposit), inWorkspace("Oakline invoice deposit.pdf"));
    // Nothing claims it's done.
    assert.equal(view.kiki.state, "error");
    assert.ok(view.activity.events.some((e) => e.kind === "plan_incomplete" && /8 of 9 steps/.test(e.message)));
    assert.equal(view.activity.events.some((e) => e.kind === "verified"), false);
    assert.match(rig.app.notifyPreview()?.text ?? "", /8 of 9 steps were checked in Drive/);
  });

  test("resuming a partial plan retries only the unfinished steps", async (t) => {
    const { rig, plan, deposit } = await partialPlan(t);
    const mark = rig.drive.calls.length;
    rig.app.resumePlan(plan.id);
    await rig.app.settle();

    const after = await planById(rig, plan.id);
    assert.equal(after.status, "applied");
    assert.equal(after.counts.verified, 9);
    assert.equal(callsSince(rig.drive, mark, "createFolder").length, 0, "no folder is created again");
    assert.deepEqual(callsSince(rig.drive, mark, "update").map((c) => c.id), [deposit], "only the failed move runs again");
    assert.equal(callsSince(rig.drive, mark, "createFile").length, 0, "the index isn't created a second time");
    assert.equal(callsSince(rig.drive, mark, "updateContent").length, 1, "it's rewritten once, now with the retried move");
    assert.equal(rig.drive.pathOf(deposit), inWorkspace(INVOICES, "2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf"));
  });
});

// 6. Restarts --------------------------------------------------------------------------------

describe("a restart does not repeat a completed action", () => {
  test("a move whose response was lost is confirmed by reading Drive back, and a restart doesn't repeat it", async (t) => {
    const dbPath = tempDbPath();
    const drive = new FakeDrive("mock");
    const first = newRig(t, { drive, db: dbPath });
    const plan = await proposed(first);
    const deposit = only(drive, "Oakline invoice deposit.pdf").id;
    drive.fail({ op: "update", fileId: deposit, mode: "lost_after_apply" });
    approve(first, plan);
    await first.app.settle();
    assert.equal(step(await planById(first, plan.id), "Oakline invoice deposit.pdf").state, "verified");
    first.app.close();

    const mark = drive.calls.length;
    const second = await restarted(t, dbPath, drive);
    const after = await planById(second, plan.id);
    assert.equal(after.status, "applied");
    assert.equal(step(after, "Oakline invoice deposit.pdf").state, "verified");
    assert.equal(drive.calls.filter((c) => c.op === "update" && c.id === deposit).length, 1, "moved once");
    assert.deepEqual(mutations(drive, mark), [], "the restart changed nothing in Drive");
    assert.equal(drive.pathOf(deposit), inWorkspace(INVOICES, "2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf"));
  });

  test("a restart in the middle of a move checks Drive instead of moving the file again", async (t) => {
    const dbPath = tempDbPath();
    const drive = new CrashingDrive("mock");
    const first = newRig(t, { drive, db: dbPath });
    const plan = await proposed(first);
    const deposit = only(drive, "Oakline invoice deposit.pdf").id;
    drive.crashOnUpdateOf = deposit;
    approve(first, plan);
    void first.app.settle(); // never finishes: the process "dies" inside the Drive call
    await drive.crashed;
    first.app.close();

    const second = await restarted(t, dbPath, drive);
    const after = await planById(second, plan.id);
    assert.equal(after.status, "applied");
    assert.equal(step(after, "Oakline invoice deposit.pdf").state, "verified");
    assert.equal(drive.calls.filter((c) => c.op === "update" && c.id === deposit).length, 1, "moved once, before the crash");
    assert.equal(drive.pathOf(deposit), inWorkspace(INVOICES, "2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf"));
  });

  test("a folder whose creation response was lost is adopted by its pre-generated id, not created twice", async (t) => {
    const rig = newRig(t);
    const plan = await proposed(rig);
    const mark = rig.drive.calls.length;
    rig.drive.fail({ op: "createFolder", mode: "lost_after_apply" }); // the first folder Kiki creates
    approve(rig, plan);
    await rig.app.settle();

    assert.equal((await planById(rig, plan.id)).status, "applied");
    const renovations = rig.drive.childrenOf(only(rig.drive, WORKSPACE).id).filter((f) => f.name === "Renovations");
    assert.equal(renovations.length, 1);
    const creates = callsSince(rig.drive, mark, "createFolder");
    assert.equal(creates.length, 4, "one call per planned folder, no retry");
    assert.equal(creates[0]?.id, renovations[0]?.id, "the folder carries the ID Kiki generated before asking");
  });

  test("a restart in the middle of creating a folder adopts it instead of creating another", async (t) => {
    const dbPath = tempDbPath();
    const drive = new CrashingDrive("mock");
    const first = newRig(t, { drive, db: dbPath });
    const plan = await proposed(first);
    const mark = drive.calls.length;
    drive.crashOnFolderNamed = "Renovations";
    approve(first, plan);
    void first.app.settle();
    await drive.crashed;
    first.app.close();
    const generated = callsSince(drive, mark, "createFolder")[0]?.id;
    assert.ok(generated);

    const second = await restarted(t, dbPath, drive);
    assert.equal((await planById(second, plan.id)).status, "applied");
    assert.deepEqual(
      drive.childrenOf(only(drive, WORKSPACE).id).filter((f) => f.name === "Renovations").map((f) => f.id),
      [generated],
    );
    assert.equal(callsSince(drive, mark, "createFolder").filter((c) => c.id === generated).length, 1, "created once, before the crash");
    const view = await second.app.view();
    assert.equal(view.inventory.files.find((f) => f.fileId === generated)?.origin, "created_by_kiki");
  });

  test(
    "a step confirmed by reading Drive back doesn't keep showing the lost response as an error",
    async (t) => {
      const rig = newRig(t);
      const plan = await proposed(rig);
      rig.drive.fail({ op: "update", fileId: only(rig.drive, "Oakline invoice deposit.pdf").id, mode: "lost_after_apply" });
      approve(rig, plan);
      await rig.app.settle();
      const confirmed = step(await planById(rig, plan.id), "Oakline invoice deposit.pdf");
      assert.equal(confirmed.state, "verified");
      assert.equal(confirmed.error, null);
    },
  );
});

// 7. Undo ------------------------------------------------------------------------------------

describe("undo", () => {
  test("undo puts files back under their original names and folders, and keeps the folders Kiki created", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    const applied = await appliedPlan(rig);
    const original = applied.ops
      .filter((o) => o.kind === "move_rename")
      .map((o) => ({ id: only(rig.drive, o.after!.name).id, name: o.before!.name, path: o.before!.path }));
    const folders = ["Renovations", "Flooring", "Invoices", "Quotes"].map((n) => only(rig.drive, n).id);

    const { planId } = rig.app.proposeUndo(applied.id);
    assert.equal(rig.app.proposeUndo(applied.id).planId, planId, "asking twice gives the same undo plan");
    const undo = await planById(rig, planId);
    assert.deepEqual([...new Set(undo.ops.map((o) => o.kind))].sort(), ["move_rename", "write_index"], "undo only moves files back and updates the index");
    approve(rig, undo);
    await rig.app.settle();

    assert.equal((await planById(rig, planId)).status, "applied");
    for (const f of original) assert.equal(rig.drive.pathOf(f.id), inWorkspace(f.path, f.name));
    for (const id of folders) assert.equal(rig.drive.files.get(id)?.trashed, false, `${rig.drive.pathOf(id)} is still there`);
    assert.equal(rig.drive.pathOf(folders[3]!), inWorkspace(QUOTES));
    const rows = indexRows(rig.drive);
    assert.deepEqual(rows.map((r) => r["File name"]).sort(), original.map((f) => f.name).sort());
    assert.ok(rows.every((r) => r.Folder === "(workspace folder)"), "the index says where the files are now");
    assert.throws(() => rig.app.proposeUndo(applied.id), conflictError, "nothing is left to undo");
  });

  test("a file changed after organizing makes its undo step stale instead of overwriting the change", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    const applied = await appliedPlan(rig);
    const bright = only(rig.drive, "2026-09-20 Quote - Bright Floors Ltd. - BF-77.pdf").id;
    const scan = only(rig.drive, "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf").id;
    rig.drive.touch(bright, { name: "Bright Floors - keep.pdf" });

    const { planId } = rig.app.proposeUndo(applied.id);
    approve(rig, await planById(rig, planId));
    await rig.app.settle();

    const undo = await planById(rig, planId);
    assert.equal(undo.status, "stale");
    const brightStep = undo.ops.find((o) => o.kind === "move_rename" && o.after?.name === "IMG_2041.pdf");
    assert.equal(brightStep?.state, "stale");
    assert.match(brightStep?.error ?? "", /changed since you previewed/);
    assert.equal(rig.drive.pathOf(bright), inWorkspace(QUOTES, "Bright Floors - keep.pdf"), "their rename is kept");
    // The step before it was undone; the ones after it didn't run, and say so.
    assert.equal(undo.ops.find((o) => o.after?.name === "scan_0012.pdf")?.state, "verified");
    assert.equal(rig.drive.pathOf(scan), inWorkspace("scan_0012.pdf"));
    assert.ok(undo.ops.filter((o) => o.seq > brightStep!.seq).every((o) => o.state === "skipped"));
  });
});

// 8. Supplier inference ----------------------------------------------------------------------

describe("supplier inference", () => {
  test("a projectless invoice from a supplier already filed under Flooring is proposed into Renovations/Flooring/Invoices, citing the supplier", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    await rig.app.stageRevision("invoice");
    await rig.app.settle();

    const plan = await proposal(rig);
    const moves = plan.ops.filter((o) => o.kind === "move_rename");
    assert.equal(moves.length, 1);
    const move = step(plan, "Northside invoice Oct 17.pdf");
    assert.equal(move.after?.path, INVOICES);
    assert.match(move.reason, /No project on it/);
    assert.match(move.reason, /Northside Building Supply/);
    assert.match(move.reason, /Flooring/);

    approve(rig, plan);
    await rig.app.settle();
    assert.equal(rig.drive.pathOf(only(rig.drive, move.after!.name).id), inWorkspace(INVOICES, move.after!.name));
  });

  test(
    "an invoice filed into Flooring by supplier inference is listed in the Flooring index",
    async (t) => {
      const rig = newRig(t);
      await organized(rig);
      await rig.app.stageRevision("invoice");
      await rig.app.settle();
      const plan = await proposal(rig);
      const filedAs = step(plan, "Northside invoice Oct 17.pdf").after!.name;
      approve(rig, plan);
      await rig.app.settle();
      assert.equal((await planById(rig, plan.id)).status, "applied");

      const flooring = (await rig.app.view()).index.find((p) => p.name === "Flooring");
      assert.ok(flooring?.rows.some((r) => r.reference === "N-5602"), "the app's Flooring index lists N-5602");
      const row = indexRows(rig.drive).find((r) => r.Reference === "N-5602");
      assert.deepEqual([row?.["File name"], row?.Folder], [filedAs, INVOICES], "the index CSV in Drive lists N-5602 where it was filed");
    },
  );

  test("a document from an unknown issuer with no project is left in place", async (t) => {
    const rig = newRig(t);
    await rig.app.createDemoWorkspace();
    const acme = addPdf(rig.drive, only(rig.drive, WORKSPACE).id, "Acme invoice.pdf", "INVOICE", ACME_INVOICE);
    await rig.app.settle();

    const plan = await proposal(rig);
    assert.equal(plan.ops.some((o) => o.before?.name === "Acme invoice.pdf"), false);
    assert.equal(plan.notes.find((n) => n.name === "Acme invoice.pdf")?.status, "left_in_place");
    approve(rig, plan);
    await rig.app.settle();
    assert.equal(rig.drive.pathOf(acme), inWorkspace("Acme invoice.pdf"));
    assert.equal(indexRows(rig.drive).some((r) => r["File name"] === "Acme invoice.pdf"), false);
  });

  test("a projectless invoice from a supplier with documents in two projects isn't guessed", async (t) => {
    const rig = newRig(t);
    await rig.app.createDemoWorkspace();
    addPdf(rig.drive, only(rig.drive, WORKSPACE).id, "kitchen bill.pdf", "INVOICE", NORTHSIDE_KITCHEN);
    await rig.app.settle();
    approve(rig, await proposal(rig));
    await rig.app.settle();
    assert.ok(only(rig.drive, "2026-10-08 Invoice - Northside Building Supply - N-5590.pdf"), "Northside now has documents in Flooring and Kitchen");

    await rig.app.stageRevision("invoice");
    await rig.app.settle();
    rig.app.proposeOrganize();
    const open = (await rig.app.view()).plans.find((p) => p.status === "proposed");
    assert.equal(open?.ops.some((o) => o.before?.name === "Northside invoice Oct 17.pdf") ?? false, false, "Kiki doesn't pick a project for it");
    assert.equal(rig.drive.pathOf(only(rig.drive, "Northside invoice Oct 17.pdf").id), inWorkspace("Northside invoice Oct 17.pdf"));
  });
});

// 9. The index in Drive ----------------------------------------------------------------------

describe("the project index", () => {
  test("the index CSV Kiki writes to Drive lists every filed document with its new name and folder", async (t) => {
    const rig = newRig(t);
    await organized(rig);
    const applied = await appliedPlan(rig);

    assert.equal(rig.drive.pathOf(only(rig.drive, INDEX).id), inWorkspace("Renovations/Flooring", INDEX));
    const rows = indexRows(rig.drive);
    const filed = applied.ops.filter((o) => o.kind === "move_rename").map((o) => `${o.after!.path}/${o.after!.name}`);
    assert.deepEqual(rows.map((r) => `${r.Folder}/${r["File name"]}`).sort(), filed.sort());
    assert.equal(rows.some((r) => /licence/i.test(r["File name"] ?? "")), false, "the business licence isn't part of the Flooring project");
    const quote = rows.find((r) => r.Reference === "Q-1042");
    assert.deepEqual(
      [quote?.Type, quote?.["Contractor or supplier"], quote?.Date, quote?.Total, quote?.Status],
      ["quote", "Oakline Flooring Co.", "2026-09-28", "$8,450.00", "Not yet confirmed"],
    );
  });
});
