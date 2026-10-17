import type { ModesView } from "../shared/api.ts";
import type { Db } from "./db.ts";
import { FoEngine, type EngineOptions } from "./fo/engine.ts";
import type { FoClient } from "./fo/types.ts";
import type { Extractor } from "./extractor.ts";
import { inventoryHandler, startInventory } from "./services/inventory.ts";
import {
  approveAndSend,
  createDraft,
  discardDraft,
  dispatchHandler,
  reconcileDispatch,
  replyToTask,
  retireDispatch,
  reviseDraft,
  setStudentName,
  stopDispatch,
} from "./services/outreach.ts";
import { confirmChecklist, createRequest, decideItem, retryExtraction, reviewRisk, setTrustedDomain, type ItemDecision } from "./services/requests.ts";
import { buildAppView } from "./services/view.ts";

export interface AppDeps {
  db: Db;
  fo: FoClient;
  extractor: Extractor;
  anthropicModel: string;
  claudeCredentialsDetected: boolean;
  engineOptions?: EngineOptions;
}

/** Composes the services. Background work is tracked so tests and shutdown can wait for it. */
export function createApp(deps: AppDeps) {
  const { db, fo, extractor } = deps;
  const engine = new FoEngine(db, fo, { inventory: inventoryHandler(db), dispatch: dispatchHandler(db) }, deps.engineOptions);
  const background = new Set<Promise<unknown>>();

  function track(p: Promise<unknown>): void {
    background.add(p);
    p.catch((err: unknown) => console.error("Background task failed:", err instanceof Error ? err.message : String(err))).finally(() => background.delete(p));
  }

  async function modes(): Promise<ModesView> {
    const connection = await fo.connection();
    return {
      claude: { mode: extractor.mode, credentialsDetected: deps.claudeCredentialsDetected, model: deps.anthropicModel },
      fo: { mode: fo.mode, connection: connection.state, ...(connection.state === "error" ? { message: connection.message } : {}) },
    };
  }

  return {
    db,
    engine,
    async view(requestId: string | null) {
      return buildAppView(db, await modes(), requestId);
    },
    createRequest(input: { text?: string; trustedDomain?: string | null; demoKey?: string | null }) {
      const { id, work } = createRequest(db, extractor, input);
      track(work);
      return { id };
    },
    retryExtraction(id: string) {
      track(retryExtraction(db, extractor, id));
    },
    setTrustedDomain: (id: string, domain: string) => setTrustedDomain(db, id, domain),
    reviewRisk: (id: string, input: { acknowledge?: boolean; note?: string }) => reviewRisk(db, id, input),
    confirmChecklist: (id: string, items: { id?: string; label?: string; removed?: boolean }[]) => confirmChecklist(db, id, items),
    decideItem: (itemId: string, decision: ItemDecision) => decideItem(db, itemId, decision),
    startInventory(requestId: string, clientRequestId: string) {
      const { runId, created, work } = startInventory(db, engine, requestId, clientRequestId);
      track(work);
      return { runId, created };
    },
    setStudentName: (name: string) => setStudentName(db, name),
    createDraft: (itemId: string, input: { recipientName?: string; recipientEmail?: string }) => ({ versionId: createDraft(db, itemId, input) }),
    reviseDraft: (versionId: string, input: { recipientName?: string; recipientEmail?: string; subject?: string; body?: string }) => ({
      versionId: reviseDraft(db, versionId, input),
    }),
    discardDraft: (versionId: string) => discardDraft(db, versionId),
    approveAndSend(versionId: string, input: { contentHash?: string; clientRequestId?: string; confirmResend?: boolean }) {
      const { dispatchId, created, work } = approveAndSend(db, engine, versionId, input);
      track(work);
      return { dispatchId, created };
    },
    reply(taskId: string, answer: string) {
      track(replyToTask(db, engine, taskId, answer));
    },
    stopDispatch(dispatchId: string) {
      track(stopDispatch(db, engine, dispatchId));
    },
    reconcileDispatch: (dispatchId: string) => reconcileDispatch(db, engine, dispatchId),
    retireDispatch: (dispatchId: string, acknowledge: boolean) => retireDispatch(db, dispatchId, acknowledge),
    keepWaiting: (taskId: string) => engine.resumePolling(taskId),
    recover: () => engine.recover(),
    async whenIdle() {
      do {
        await engine.whenIdle();
        if (background.size) await Promise.allSettled([...background]);
      } while (background.size > 0);
      await engine.whenIdle();
    },
    close() {
      engine.stop();
    },
  };
}

export type App = ReturnType<typeof createApp>;
