import type { IntegrationsView } from "../shared/api.ts";
import { logEvent, now, one, run, tx, type Db, type DocumentRow, type PlanRow, type WatchRow } from "./db.ts";
import { badRequest, notFound } from "./errors.ts";
import type { Reader } from "./extractor.ts";
import { FoEngine, type EngineOptions } from "./fo/engine.ts";
import type { FoClient } from "./fo/types.ts";
import type { DriveAdapter, DriveConnection } from "./google/types.ts";
import type { GmailAdapter } from "./google/gmail.ts";
import { JobQueue } from "./jobs.ts";
import type { Ctx } from "./services/context.ts";
import { executePlan } from "./services/executor.ts";
import {
  approveAndSend,
  createCopyRequestDraft,
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
import { approvePlan, autoPropose, discardPlan, placeFile, proposeOrganize, proposeUndo, resumePlan, revisePlan } from "./services/plans.ts";
import { askThroughFo, handleChangeRequest } from "./services/askfo.ts";
import { refreshPlan } from "./services/refresh.ts";
import { textFromWebhook, watchTextReplies } from "./services/textreply.ts";
import { fileAlone, forgetLesson, learnFromPlan, setFilesAlone } from "./services/lessons.ts";
import { acceptHandoff, checkEmailNow, emailScoutOn, lookupHandoff, scoutHandler, setEmailScout } from "./services/emailscout.ts";
import { autoNotifyProposal, autoTextEnabled, checkTextReply, composeAndSend, notifyHandler, notifyPreview, notifySend, sendDoneText, setAutoText, reopenQuestions } from "./services/notify.ts";
import { buildAppView } from "./services/view.ts";
import { saveEmailedAttachment, searchEmailedAttachments } from "./services/attachments.ts";
import { dismissAttention } from "./services/attention.ts";
import { proposeMarkCurrent } from "./services/current.ts";
import { dismissOutcome, followUp, pasteReply, pickUpArrivals, pickUpCopies, recheckOutcome, resolveOutcome, runOutcome, setWatching, watchJob } from "./services/watch.ts";
import { activeWorkspace, createDemoWorkspace, requireWorkspace, retryFailedReads, runInventory, runReading, selectWorkspace, stageRevisedQuote } from "./services/workspace.ts";

export interface AppDeps {
  db: Db;
  drive: DriveAdapter;
  gmail?: GmailAdapter | null;
  reader: Reader;
  fo: FoClient;
  anthropicModel: string;
  claudeCredentialsDetected: boolean;
  google?: { scopes: "narrow" | "full"; missingScopes: () => string[] };
  engineOptions?: EngineOptions;
  watchIntervalSeconds?: number;
  publicUrl?: string | null;
  foWebhook?: boolean;
  /** Seconds between read-only looks at the workspace; 0 turns watching off (tests). */
  workspacePollSeconds?: number;
}

/** Composes adapters, the job queue, the Fo engine and the services. */
export function createApp(deps: AppDeps) {
  const { db, drive, reader, fo } = deps;
  const jobs = new JobQueue(db);
  const ctx = { db, drive, gmail: deps.gmail ?? null, reader, fo, jobs, watchIntervalSeconds: deps.watchIntervalSeconds ?? 30, publicUrl: deps.publicUrl ?? null, foWebhook: deps.foWebhook ?? false } as Ctx;
  ctx.engine = new FoEngine(db, fo, { dispatch: dispatchHandler(ctx), followup: followUpHandler, notify: notifyHandler(ctx), scout: scoutHandler }, deps.engineOptions);

  const pollSeconds = deps.workspacePollSeconds ?? 10;
  // Kiki keeps looking at the selected folder (read-only) to notice new files as they arrive.
  jobs.register("inventory", async (p) => {
    const wsId = String(p.workspaceId);
    await runInventory(ctx, wsId);
    return pollSeconds > 0 && activeWorkspace(db)?.id === wsId ? { rescheduleSeconds: pollSeconds } : undefined;
  });
  // After reading something new, Kiki prepares a proposal unasked and (if allowed) has Fo text you.
  jobs.register("read", async (p) => {
    const wsId = String(p.workspaceId);
    await runReading(ctx, wsId);
    // A revised quote Kiki was waiting for goes to its follow-up first, not into a filing plan;
    // a copy Kiki asked for closes its request (and is filed like any new document).
    await pickUpArrivals(ctx, wsId);
    pickUpCopies(ctx, wsId);
    const proposal = autoPropose(ctx);
    // A kind of document you said Kiki may file without asking is filed now (with a text after); the rest is asked.
    if (proposal?.created && !fileAlone(ctx, proposal.plan)) autoNotifyProposal(ctx, proposal.plan);
    // Then, in the background, older documents get any newer kinds of facts.
    jobs.enqueue("upgrade_facts", `upgrade_facts:${wsId}`, { workspaceId: wsId });
  });
  jobs.register("upgrade_facts", async (p) => {
    await runReading(ctx, String(p.workspaceId), { upgrades: true });
    // What Kiki now knows may place files that couldn't be placed before (where a résumé or a screenshot goes).
    const proposal = autoPropose(ctx);
    if (proposal?.created && !fileAlone(ctx, proposal.plan)) autoNotifyProposal(ctx, proposal.plan);
  });
  jobs.register("execute_plan", async (p, job) => {
    await executePlan(ctx, String(p.planId), job.attempts + 1);
    sendDoneText(ctx, String(p.planId));
    ctx.jobs.enqueue("learn", `learn:${p.planId}`, { planId: String(p.planId) });
  });
  // A filing you approved is in Drive: what it teaches Kiki about where things go.
  jobs.register("learn", async (p) => learnFromPlan(ctx, String(p.planId)));
  // Watches for your reply to Fo's text ("go ahead"), read-only, until it arrives or expires.
  jobs.register("text_reply", async (p) => checkTextReply(ctx, String(p.taskId)));
  // A text for Fo to send you: written for the moment and checked, then sent.
  jobs.register("compose_text", async (p) => composeAndSend(ctx, String(p.taskId)));
  // You asked Fo for changes to a proposal: Kiki makes the new version and sends it back to Fo.
  // A text you send Fo while a proposal waits: Kiki has Fo read it and report your decision.
  // Fo handed a file from your email to Kiki, who copies it into the folder (then it's a new file like any other).
  jobs.register("handoff", async (p) => acceptHandoff(ctx, String(p.fileId)));
  jobs.register("handoff_lookup", async (p) => lookupHandoff(ctx, String(p.conversationId), p.runId ? String(p.runId) : null));
  jobs.register("text_watch", async (p) => watchTextReplies(ctx, String(p.taskId)));
  // Fo's webhook said Fo answered a text of yours: if a proposal waits on you, Fo reads it for Kiki.
  jobs.register("text_hook", async (p) => textFromWebhook(ctx, { conversationId: String(p.conversationId), channel: String(p.channel), at: String(p.at), key: String(p.key) }));
  jobs.register("adjust", async (p) => handleChangeRequest(ctx, String(p.taskId), { quiet: p.quiet === true }));
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
        gmail: !ctx.gmail ? "off" : ctx.gmail.mode === "mock" ? "mock" : ctx.gmail.available() ? "connected" : "not_connected",
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
    /** Kiki forgets a lesson: the next proposal is made without it. */
    forgetLesson(id: string) {
      forgetLesson(ctx, id);
    },
    /** Fo checks your email for files (twice a day, asking you first), or stops. */
    setEmailScout: (on: boolean) => setEmailScout(ctx, on),
    checkEmailNow: () => checkEmailNow(ctx),
    emailScoutOn: () => emailScoutOn(ctx),
    /** You let Kiki file a kind of document without asking, or take that back. */
    setFilesAlone(id: string, on: boolean) {
      setFilesAlone(ctx, id, on);
    },
    updateSettings(input: { userName?: string; autoText?: boolean }) {
      if (input.userName !== undefined) setUserName(db, input.userName);
      if (input.autoText !== undefined) setAutoText(ctx, input.autoText);
    },
    autoTextEnabled: () => autoTextEnabled(ctx),
    selectWorkspace: (input: string) => selectWorkspace(ctx, input),
    createDemoWorkspace: () => createDemoWorkspace(ctx),
    stageRevision: (variant: "single" | "ambiguous" | "invoice") => stageRevisedQuote(ctx, variant),
    clearWorkspace() {
      run(db, "UPDATE workspaces SET active = 0 WHERE active = 1");
    },
    refreshInventory() {
      const ws = requireWorkspace(db);
      retryFailedReads(db, ws.id);
      jobs.enqueue("inventory", `inventory:${ws.id}`, { workspaceId: ws.id });
    },
    proposeOrganize: () => proposeOrganize(ctx),
    revisePlan: (planId: string, edits: { seq: number; newName?: string; exclude?: boolean }[]) => ({ planId: revisePlan(ctx, planId, edits) }),
    approvePlan: (planId: string, input: { contentHash?: string; clientRequestId?: string }) => approvePlan(ctx, planId, input),
    discardPlan: (planId: string) => discardPlan(ctx, planId),
    resumePlan: (planId: string) => resumePlan(ctx, planId),
    proposeUndo: (planId: string) => ({ planId: proposeUndo(ctx, planId) }),
    askThroughFo: (planId: string) => askThroughFo(ctx, planId),
    refreshPlan: (planId: string) => refreshPlan(ctx, planId),
    placeFile: (planId: string, fileId: string, place: string) => placeFile(ctx, planId, fileId, place),
    acceptQuote,
    notifyPreview: () => notifyPreview(ctx),
    notifySend: (input: { contentHash?: string; clientRequestId?: string }) => notifySend(ctx, input),
    createOutreachDraft: (documentId: string, input: { contractorName?: string; contractorEmail?: string; consent?: boolean }) => ({ versionId: createOutreachDraft(ctx, documentId, input) }),
    reviseOutreach: (versionId: string, input: { recipientName?: string; recipientEmail?: string; subject?: string; body?: string; consent?: boolean }) => ({
      versionId: reviseOutreach(ctx, versionId, input),
    }),
    discardOutreach: (versionId: string) => discardOutreach(ctx, versionId),
    approveAndSend: (versionId: string, input: { contentHash?: string; clientRequestId?: string; confirmResend?: boolean }) => approveAndSend(ctx, versionId, input),
    /** Resolves once your answer is on its way to Fo; Fo's reply comes back later. */
    reply: (taskId: string, answer: string) => replyToTask(ctx, taskId, answer),
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
    searchGmail: (outcomeId: string) => searchEmailedAttachments(ctx, outcomeId).then((found) => ({ found: found.length })),
    saveGmailAttachment: (outcomeId: string, index: number) => saveEmailedAttachment(ctx, outcomeId, index),
    dismissOutcome: (outcomeId: string) => dismissOutcome(ctx, outcomeId),
    dismissAttention: (key: string) => dismissAttention(ctx, key),
    markCurrent: (documentId: string) => proposeMarkCurrent(ctx, documentId),
    requestCopy: (documentId: string, input: { reference?: string; contractorName?: string; contractorEmail?: string; consent?: boolean }) => ({
      versionId: createCopyRequestDraft(ctx, documentId, input),
    }),

    /**
     * After a restart: Drive steps that were mid-call become uncertain (the executor reads the
     * file back before deciding), executing plans resume, Fo tasks recover, watches restart.
     */
    recover() {
      // A workspace from the other mode (e.g. a mock rehearsal) can't be reached now; set it aside.
      run(db, "UPDATE workspaces SET active = 0 WHERE active = 1 AND mode <> ?", drive.mode);
      jobs.recover();
      ctx.engine.recover();
      run(db, "UPDATE plan_ops SET state = 'uncertain', error = 'Kiki restarted during this step and will check Drive before doing anything.' WHERE state = 'running'");
      for (const p of db.prepare("SELECT * FROM plans WHERE status IN ('approved', 'executing')").all() as unknown as PlanRow[]) {
        jobs.enqueue("execute_plan", `execute:${p.id}`, { planId: p.id });
      }
      // A proposal Fo was bringing you, interrupted mid-call: read where it stands before you answer again.
      for (const t of db.prepare("SELECT id FROM fo_tasks WHERE kind = 'notify' AND state = 'uncertain' AND conversation_id IS NOT NULL").all() as { id: string }[]) {
        jobs.enqueue("text_reply", `text_reply:${t.id}`, { taskId: t.id });
      }
      for (const w of db.prepare("SELECT * FROM watches WHERE state = 'watching'").all() as unknown as WatchRow[]) {
        jobs.enqueue("watch", `watch:${w.id}`, { watchId: w.id });
      }
      const ws = activeWorkspace(db);
      if (ws) retryFailedReads(db, ws.id);
      if (ws) jobs.enqueue("read", `read:${ws.id}`, { workspaceId: ws.id });
      // An open proposal that never reached Fo (made while Kiki ran older code, or texts were off):
      // with texts on, Fo brings it now. Each proposal is texted at most once.
      for (const p of db.prepare("SELECT * FROM plans WHERE status = 'proposed' AND workspace_id = ?").all(ws?.id ?? "") as unknown as PlanRow[]) autoNotifyProposal(ctx, p);
      reopenQuestions(ctx);
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
