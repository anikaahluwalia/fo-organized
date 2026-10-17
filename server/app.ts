import type { IntegrationsView } from "../shared/api.ts";
import { logEvent, now, one, run, tx, type Db, type DocumentRow, type PlanRow, type WatchRow } from "./db.ts";
import { badRequest, notFound } from "./errors.ts";
import type { Reader } from "./extractor.ts";
import { FoEngine, type EngineOptions } from "./fo/engine.ts";
import type { FoClient } from "./fo/types.ts";
import type { DriveAdapter, DriveConnection } from "./google/types.ts";
import { JobQueue } from "./jobs.ts";
import type { Ctx } from "./services/context.ts";
import { executePlan } from "./services/executor.ts";
import {
  approveAndSend,
  createOutreachDraft,
  discardOutreach,
  dispatchHandler,
  followUpHandler,
  reconcileDispatch,
  replyToTask,
  retireDispatch,
  reviseOutreach,
  setUserName,
  stopDispatch,
} from "./services/outreach.ts";
import { approvePlan, autoPropose, discardPlan, proposeOrganize, proposeUndo, resumePlan, revisePlan } from "./services/plans.ts";
import { autoNotifyProposal, autoTextEnabled, notifyHandler, notifyPreview, notifySend, setAutoText } from "./services/notify.ts";
import { buildAppView } from "./services/view.ts";
import { dismissOutcome, followUp, pasteReply, recheckOutcome, resolveOutcome, runOutcome, setWatching, watchJob } from "./services/watch.ts";
import { activeWorkspace, createDemoWorkspace, requireWorkspace, runInventory, runReading, selectWorkspace, stageRevisedQuote } from "./services/workspace.ts";

export interface AppDeps {
  db: Db;
  drive: DriveAdapter;
  reader: Reader;
  fo: FoClient;
  anthropicModel: string;
  claudeCredentialsDetected: boolean;
  google?: { scopes: "narrow" | "full"; missingScopes: () => string[] };
  engineOptions?: EngineOptions;
  watchIntervalSeconds?: number;
  /** Seconds between read-only looks at the workspace; 0 turns watching off (tests). */
  workspacePollSeconds?: number;
}

/** Composes adapters, the job queue, the Fo engine and the services. */
export function createApp(deps: AppDeps) {
  const { db, drive, reader, fo } = deps;
  const jobs = new JobQueue(db);
  const ctx = { db, drive, reader, fo, jobs, watchIntervalSeconds: deps.watchIntervalSeconds ?? 30 } as Ctx;
  ctx.engine = new FoEngine(db, fo, { dispatch: dispatchHandler(ctx), followup: followUpHandler, notify: notifyHandler }, deps.engineOptions);

  const pollSeconds = deps.workspacePollSeconds ?? 10;
  // Kiki keeps looking at the selected folder (read-only) so she notices new files on her own.
  jobs.register("inventory", async (p) => {
    const wsId = String(p.workspaceId);
    await runInventory(ctx, wsId);
    return pollSeconds > 0 && activeWorkspace(db)?.id === wsId ? { rescheduleSeconds: pollSeconds } : undefined;
  });
  // After reading something new, she prepares a proposal herself and (if allowed) has Fo text you.
  jobs.register("read", async (p) => {
    await runReading(ctx, String(p.workspaceId));
    const proposal = autoPropose(ctx);
    if (proposal?.created) autoNotifyProposal(ctx, proposal.plan);
  });
  jobs.register("execute_plan", async (p, job) => executePlan(ctx, String(p.planId), job.attempts + 1));
  jobs.register("watch", async (p) => watchJob(ctx, String(p.watchId), ctx.watchIntervalSeconds));
  jobs.register("outcome", async (p) => runOutcome(ctx, String(p.outcomeId)));

  let driveConn: { at: number; value: DriveConnection } | null = null;
  async function integrations(): Promise<IntegrationsView> {
    if (!driveConn || Date.now() - driveConn.at > 60_000) driveConn = { at: Date.now(), value: await drive.connection() };
    const d = driveConn.value;
    const f = await fo.connection();
    return {
      drive: {
        mode: drive.mode,
        connection: d.state,
        account: d.state === "connected" ? d.account : null,
        ...("message" in d ? { message: d.message } : {}),
        scopes: deps.google?.scopes ?? "narrow",
        missingScopes: d.state === "connected" ? (deps.google?.missingScopes() ?? []) : [],
      },
      claude: { mode: reader.mode, credentialsDetected: deps.claudeCredentialsDetected, model: deps.anthropicModel },
      fo: { mode: fo.mode, connection: f.state, ...(f.state === "error" ? { message: f.message } : {}) },
    };
  }

  function acceptQuote(documentId: string, accepted: boolean): void {
    const doc = one<DocumentRow>(db, "SELECT * FROM documents WHERE id = ?", documentId);
    if (!doc || doc.doc_type !== "quote") throw notFound("That quote isn't in the index.");
    tx(db, () => {
      run(db, "UPDATE documents SET accepted_at = ?, updated_at = ? WHERE id = ?", accepted ? now() : null, now(), documentId);
      run(
        db,
        "INSERT INTO version_events (document_id, kind, detail, at) VALUES (?, ?, ?, ?)",
        documentId,
        accepted ? "accepted" : "acceptance_withdrawn",
        accepted ? "You marked this quote's price as accepted." : "You withdrew your acceptance of this quote's price.",
        now(),
      );
      logEvent(db, doc.workspace_id, "accepted", accepted ? "You marked a quote's price as accepted. Kiki never infers this." : "You withdrew acceptance of a quote's price.");
    });
  }

  return {
    ctx,
    db,
    jobs,
    engine: ctx.engine,
    async view() {
      return buildAppView(ctx, await integrations());
    },
    forgetConnectionCache() {
      driveConn = null;
    },
    updateSettings(input: { userName?: string; autoText?: boolean }) {
      if (input.userName !== undefined) setUserName(db, input.userName);
      if (input.autoText !== undefined) setAutoText(ctx, input.autoText);
    },
    autoTextEnabled: () => autoTextEnabled(ctx),
    selectWorkspace: (input: string) => selectWorkspace(ctx, input),
    createDemoWorkspace: () => createDemoWorkspace(ctx),
    stageRevision: (variant: "single" | "ambiguous" | "invoice") => stageRevisedQuote(ctx, variant),
    refreshInventory() {
      const ws = requireWorkspace(db);
      jobs.enqueue("inventory", `inventory:${ws.id}`, { workspaceId: ws.id });
    },
    proposeOrganize: () => proposeOrganize(ctx),
    revisePlan: (planId: string, edits: { seq: number; newName?: string; exclude?: boolean }[]) => ({ planId: revisePlan(ctx, planId, edits) }),
    approvePlan: (planId: string, input: { contentHash?: string; clientRequestId?: string }) => approvePlan(ctx, planId, input),
    discardPlan: (planId: string) => discardPlan(ctx, planId),
    resumePlan: (planId: string) => resumePlan(ctx, planId),
    proposeUndo: (planId: string) => ({ planId: proposeUndo(ctx, planId) }),
    acceptQuote,
    notifyPreview: () => notifyPreview(ctx),
    notifySend: (input: { contentHash?: string; clientRequestId?: string }) => notifySend(ctx, input),
    createOutreachDraft: (documentId: string, input: { contractorName?: string; contractorEmail?: string; consent?: boolean }) => ({ versionId: createOutreachDraft(ctx, documentId, input) }),
    reviseOutreach: (versionId: string, input: { recipientName?: string; recipientEmail?: string; subject?: string; body?: string; consent?: boolean }) => ({
      versionId: reviseOutreach(ctx, versionId, input),
    }),
    discardOutreach: (versionId: string) => discardOutreach(ctx, versionId),
    approveAndSend: (versionId: string, input: { contentHash?: string; clientRequestId?: string; confirmResend?: boolean }) => approveAndSend(ctx, versionId, input),
    reply(taskId: string, answer: string) {
      void replyToTask(ctx, taskId, answer).catch(() => undefined);
    },
    stopDispatch(dispatchId: string) {
      void stopDispatch(ctx, dispatchId).catch(() => undefined);
    },
    reconcileDispatch: (dispatchId: string) => reconcileDispatch(ctx, dispatchId),
    retireDispatch: (dispatchId: string, acknowledge: boolean) => retireDispatch(ctx, dispatchId, acknowledge),
    keepWaiting: (taskId: string) => ctx.engine.resumePolling(taskId),
    pasteReply: (watchId: string, text: string) => ({ updateId: pasteReply(ctx, watchId, text) }),
    followUp: (watchId: string, text: string) => followUp(ctx, watchId, text),
    setWatching: (watchId: string, watching: boolean) => setWatching(ctx, watchId, watching),
    checkNow(watchId: string) {
      const w = one<WatchRow>(db, "SELECT * FROM watches WHERE id = ?", watchId);
      if (!w) throw notFound("That conversation isn't being followed.");
      if (w.state !== "watching") throw badRequest("Kiki isn't following this conversation right now.");
      jobs.enqueue("watch", `watch:${w.id}`, { watchId: w.id });
    },
    resolveOutcome: (outcomeId: string, documentId: string | null) => resolveOutcome(ctx, outcomeId, documentId),
    recheckOutcome: (outcomeId: string) => recheckOutcome(ctx, outcomeId),
    dismissOutcome: (outcomeId: string) => dismissOutcome(ctx, outcomeId),

    /**
     * After a restart: Drive steps that were mid-call become uncertain (the executor reads the
     * file back before deciding), executing plans resume, Fo tasks recover, watches restart.
     */
    recover() {
      // A workspace from the other mode (e.g. a mock rehearsal) can't be reached now; set it aside.
      run(db, "UPDATE workspaces SET active = 0 WHERE active = 1 AND mode <> ?", drive.mode);
      jobs.recover();
      ctx.engine.recover();
      run(db, "UPDATE plan_ops SET state = 'uncertain', error = 'Kiki restarted during this step; she will check Drive before doing anything.' WHERE state = 'running'");
      for (const p of db.prepare("SELECT * FROM plans WHERE status IN ('approved', 'executing')").all() as unknown as PlanRow[]) {
        jobs.enqueue("execute_plan", `execute:${p.id}`, { planId: p.id });
      }
      for (const w of db.prepare("SELECT * FROM watches WHERE state = 'watching'").all() as unknown as WatchRow[]) {
        jobs.enqueue("watch", `watch:${w.id}`, { watchId: w.id });
      }
      const ws = activeWorkspace(db);
      if (ws) jobs.enqueue("read", `read:${ws.id}`, { workspaceId: ws.id });
    },
    start() {
      jobs.start();
    },
    /** For tests: run until no job is due and no Fo work is in flight. */
    async settle() {
      for (let i = 0; i < 100; i++) {
        await ctx.engine.whenIdle();
        const ran = await jobs.runDue();
        await ctx.engine.whenIdle();
        if (ran === 0 && (await jobs.runDue()) === 0) return;
      }
      throw new Error("App didn't settle.");
    },
    close() {
      jobs.stop();
      ctx.engine.stop();
    },
  };
}

export type App = ReturnType<typeof createApp>;
