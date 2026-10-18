import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { all, now, one, run, tx, type Db, type FoTaskRow, type TaskState } from "../db.ts";
import { isWaitingForUser } from "../domain/outreach.ts";
import { conflict } from "../errors.ts";
import { FoCallError, type FoClient, type FoReply } from "./types.ts";

/** Domain logic plugged into the engine. Both hooks run inside the engine's transaction. */
export interface TaskHandler {
  /** Fo finished a turn. Return Fo's question for the user, or null when the task is done. */
  onComplete(task: FoTaskRow, response: string): { question: string | null };
  /** Called after every state change so domain tables can follow (for example, closing a dispatch). */
  onStateChange(task: FoTaskRow): void;
}

export interface EngineOptions {
  pollWaitSeconds?: number;
  /** After this long in "working", stop polling and ask the user whether to keep waiting. */
  maxWorkingMs?: number;
  backoffBaseMs?: number;
}

export function insertTask(db: Db, kind: string, mode: FoTaskRow["mode"]): string {
  const id = randomUUID();
  const at = now();
  run(db, "INSERT INTO fo_tasks (id, kind, mode, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)", id, kind, mode, at, at);
  return id;
}

export function getTask(db: Db, id: string): FoTaskRow | undefined {
  return one<FoTaskRow>(db, "SELECT * FROM fo_tasks WHERE id = ?", id);
}

/**
 * Drives app-initiated Fo conversations: ask_fo, the get_fo_reply polling loop, user-input
 * continuations, crash recovery and read-only reconciliation. Every transition is persisted, so a
 * browser reload or server restart picks up where things were without repeating an action.
 */
export class FoEngine {
  private readonly db: Db;
  private readonly fo: FoClient;
  private readonly handlers: Record<string, TaskHandler>;
  private readonly pollWaitSeconds: number;
  private readonly maxWorkingMs: number;
  private readonly backoffBaseMs: number;
  private readonly pollers = new Map<string, Promise<void>>();
  private readonly background = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(db: Db, fo: FoClient, handlers: Record<string, TaskHandler>, options: EngineOptions = {}) {
    this.db = db;
    this.fo = fo;
    this.handlers = handlers;
    this.pollWaitSeconds = options.pollWaitSeconds ?? 25;
    this.maxWorkingMs = options.maxWorkingMs ?? 10 * 60_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
  }

  get mode(): FoClient["mode"] {
    return this.fo.mode;
  }

  /** Starts a pending task in a new Fo conversation. Returns the background work. */
  start(taskId: string, message: string): Promise<void> {
    const claimed = tx(this.db, () => {
      const at = now();
      const n = run(this.db, "UPDATE fo_tasks SET state = 'asking', ask_started_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'", at, at, taskId);
      if (n === 1) this.recordTurn(taskId, "to_fo", "ask_fo", null, message);
      return n === 1;
    });
    if (!claimed) return Promise.resolve();
    return this.track(this.ask(taskId, { message, newConversation: true }));
  }

  /**
   * Starts a pending task as a follow-up inside an existing, app-mapped conversation. Checks first
   * (read-only) that Fo isn't mid-turn there: a new message never goes into a working turn.
   */
  async startInConversation(taskId: string, conversationId: string, message: string): Promise<void> {
    let status: FoReply;
    try {
      status = await this.fo.getFoReply({ conversationId, waitSeconds: 0 });
    } catch (err) {
      const detail = `Couldn't check the conversation first, so nothing was sent (${err instanceof Error ? err.message : String(err)}).`;
      tx(this.db, () => this.setState(taskId, "failed", { failure_kind: "not_started", failure_detail: detail }));
      throw err;
    }
    if (status.status === "working") {
      tx(this.db, () => this.setState(taskId, "failed", { failure_kind: "not_started", failure_detail: "Fo was still working in this conversation, so nothing was sent. Try again when it's done." }));
      throw conflict("Fo is still working in this conversation. Try again when it's done.");
    }
    const claimed = tx(this.db, () => {
      const at = now();
      const n = run(this.db, "UPDATE fo_tasks SET state = 'asking', conversation_id = ?, ask_started_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'", conversationId, at, at, taskId);
      if (n === 1) {
        this.recordTurn(taskId, "to_fo", "ask_fo", null, message);
        this.notify(taskId);
      }
      return n === 1;
    });
    if (!claimed) return;
    await this.track(this.ask(taskId, { message, conversationId }));
  }

  /**
   * Sends the user's answer when Fo is waiting for it: the documented continuation flow. Throws a
   * 409 conflict if Fo isn't waiting, so a double-submitted answer is never sent twice.
   */
  continue(taskId: string, message: string): Promise<void> {
    const conversationId = tx(this.db, () => {
      const task = getTask(this.db, taskId);
      if (!task || task.state !== "needs_user_input" || !task.conversation_id) return null;
      const at = now();
      run(this.db, "UPDATE fo_tasks SET state = 'asking', ask_started_at = ?, question = NULL, poll_paused = 0, poll_error = NULL, updated_at = ? WHERE id = ?", at, at, taskId);
      this.recordTurn(taskId, "to_fo", "ask_fo", null, message);
      this.notify(taskId);
      return task.conversation_id;
    });
    if (!conversationId) throw conflict("Fo isn't waiting for an answer on this right now.");
    return this.track(this.ask(taskId, { message, conversationId }));
  }

  private async ask(taskId: string, args: { message: string; conversationId?: string; newConversation?: boolean }): Promise<void> {
    let reply: FoReply;
    try {
      reply = await this.fo.askFo(args);
    } catch (err) {
      const e = err instanceof FoCallError ? err : new FoCallError(err instanceof Error ? err.message : String(err), "unknown", "other");
      tx(this.db, () => {
        this.recordTurn(taskId, "error", "ask_fo", e.kind, e.message);
        if (e.delivery === "not_sent") this.setState(taskId, "failed", { failure_kind: "not_sent", failure_detail: e.message });
        else this.setState(taskId, "uncertain", { failure_kind: e.kind === "timeout" ? "lost_response" : e.kind, failure_detail: e.message });
      });
      return;
    }
    this.recordReply(taskId, "ask_fo", reply);
    this.applyReply(taskId, reply, ["asking"]);
  }

  private applyReply(taskId: string, reply: FoReply, allowedFrom: TaskState[]): void {
    let poll = false;
    tx(this.db, () => {
      const task = getTask(this.db, taskId);
      if (!task || !allowedFrom.includes(task.state)) return;
      if (task.conversation_id && task.conversation_id !== reply.conversationId) {
        this.setState(taskId, "uncertain", { failure_kind: "malformed", failure_detail: "Fo answered on a different conversation than expected." });
        return;
      }
      if (!task.conversation_id) run(this.db, "UPDATE fo_tasks SET conversation_id = ? WHERE id = ?", reply.conversationId, taskId);

      if (reply.awaitingUser === true && reply.status !== "failed") {
        this.setState(taskId, "needs_user_input", { question: reply.response ?? reply.progress ?? "Fo is waiting for your answer.", final_response: reply.response ?? null, progress: null });
      } else if (reply.status === "working") {
        if (isWaitingForUser(reply.progress, reply.response)) {
          this.setState(taskId, "needs_user_input", { question: reply.progress ?? reply.response ?? "Fo is waiting for your answer.", progress: reply.progress ?? null });
        } else {
          this.setState(taskId, "working", { progress: reply.progress ?? null, elapsed_seconds: reply.elapsedSeconds ?? null });
          poll = true;
        }
      } else if (reply.status === "complete") {
        const response = reply.response ?? "";
        const fresh = getTask(this.db, taskId)!;
        const { question } = this.handlers[fresh.kind]?.onComplete(fresh, response) ?? { question: null };
        if (question) this.setState(taskId, "needs_user_input", { question, final_response: response, progress: null });
        else this.setState(taskId, "complete", { final_response: response, progress: null });
      } else {
        this.setState(taskId, "failed", { failure_kind: "fo_failed", failure_detail: reply.response ?? "Fo reported that it couldn't finish.", progress: null });
      }
    });
    if (poll) this.ensurePolling(taskId);
  }

  private ensurePolling(taskId: string): void {
    if (this.stopped || this.pollers.has(taskId)) return;
    const p = this.pollLoop(taskId).finally(() => this.pollers.delete(taskId));
    this.pollers.set(taskId, p);
    this.track(p);
  }

  private async pollLoop(taskId: string): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const task = getTask(this.db, taskId);
      if (!task || task.state !== "working" || task.poll_paused || !task.conversation_id) return;
      if (task.ask_started_at && Date.now() - Date.parse(task.ask_started_at) > this.maxWorkingMs) {
        tx(this.db, () => {
          run(this.db, "UPDATE fo_tasks SET poll_paused = 1, updated_at = ? WHERE id = ?", now(), taskId);
          this.notify(taskId);
        });
        return;
      }
      try {
        const reply = await this.fo.getFoReply({ conversationId: task.conversation_id, waitSeconds: this.pollWaitSeconds });
        failures = 0;
        if (reply.status !== "working" || reply.progress !== task.progress) this.recordReply(taskId, "get_fo_reply", reply);
        run(this.db, "UPDATE fo_tasks SET poll_error = NULL WHERE id = ?", taskId);
        this.applyReply(taskId, reply, ["working"]);
      } catch (err) {
        // Polling is read-only. An error here says nothing about the outcome, so the state stays
        // "working"; we only note the problem and back off.
        failures++;
        const e = err instanceof FoCallError ? err : null;
        const message = e?.message ?? (err instanceof Error ? err.message : String(err));
        const pause = e?.kind === "not_connected";
        tx(this.db, () => {
          run(this.db, "UPDATE fo_tasks SET poll_error = ?, poll_paused = ?, updated_at = ? WHERE id = ?", message, pause ? 1 : 0, now(), taskId);
          this.notify(taskId);
        });
        if (pause) return;
        await sleep(Math.min(30_000, this.backoffBaseMs * 2 ** Math.min(failures, 5)));
      }
    }
  }

  /** The user chose to keep waiting after the long-running pause, or after reconnecting Fo. */
  resumePolling(taskId: string): void {
    const n = run(this.db, "UPDATE fo_tasks SET poll_paused = 0, poll_error = NULL, ask_started_at = ?, updated_at = ? WHERE id = ? AND state = 'working'", now(), now(), taskId);
    if (n !== 1) throw conflict("Fo isn't working on this right now.");
    this.ensurePolling(taskId);
  }

  /**
   * Called at startup. A task that was mid-ask when the process stopped might have reached Fo, so
   * it becomes uncertain; it is never re-sent. Working tasks resume polling.
   */
  recover(): void {
    tx(this.db, () => {
      for (const task of all<FoTaskRow>(this.db, "SELECT * FROM fo_tasks WHERE state = 'pending'")) {
        this.setState(task.id, "failed", { failure_kind: "not_started", failure_detail: "Kiki restarted before this reached Fo. Nothing was sent." });
      }
      for (const task of all<FoTaskRow>(this.db, "SELECT * FROM fo_tasks WHERE state = 'asking'")) {
        this.setState(task.id, "uncertain", {
          failure_kind: "interrupted",
          failure_detail: "Kiki stopped while waiting for Fo's response. The request may have reached Fo.",
        });
      }
    });
    for (const task of all<FoTaskRow>(this.db, "SELECT * FROM fo_tasks WHERE state = 'working' AND poll_paused = 0")) this.ensurePolling(task.id);
  }

  /**
   * Read-only reconciliation for an uncertain task: find the Fo conversation (by stored id, or by
   * the reference code in our message) and read its latest status. Never sends anything.
   */
  async reconcile(taskId: string, reference: string): Promise<{ found: boolean; note: string }> {
    const task = getTask(this.db, taskId);
    if (!task || task.state !== "uncertain") throw conflict("Only an uncertain request can be checked.");
    let conversationId = task.conversation_id;
    let searched = 0;
    if (!conversationId) {
      const since = Date.parse(task.ask_started_at ?? task.created_at) - 5 * 60_000;
      const recent = (await this.fo.listConversations()).filter((c) => !c.startedAt || Date.parse(c.startedAt) >= since).slice(0, 10);
      for (const c of recent) {
        searched++;
        const turns = await this.fo.getConversation(c.conversationId);
        if (turns.some((t) => t.role === "user" && t.text.includes(reference))) {
          conversationId = c.conversationId;
          break;
        }
      }
      if (!conversationId) {
        const note = `Checked ${searched} recent Fo conversation${searched === 1 ? "" : "s"}; none contained reference ${reference}. It still may have reached Fo.`;
        tx(this.db, () => this.recordTurn(taskId, "error", "reconcile", "not_found", note));
        return { found: false, note };
      }
      tx(this.db, () => {
        run(this.db, "UPDATE fo_tasks SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL", conversationId, taskId);
        this.recordTurn(taskId, "error", "reconcile", "found", `Found the Fo conversation containing reference ${reference}.`);
      });
    }
    const reply = await this.fo.getFoReply({ conversationId, waitSeconds: 0 });
    this.recordReply(taskId, "get_fo_reply", reply);
    this.applyReply(taskId, reply, ["uncertain"]);
    return { found: true, note: `Read Fo's latest status for reference ${reference}.` };
  }

  stop(): void {
    this.stopped = true;
  }

  /** Resolves when all background work has settled (used by tests and shutdown). */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    void p.finally(() => this.background.delete(p)).catch(() => undefined);
    return p;
  }

  private setState(taskId: string, state: TaskState, fields: Partial<Pick<FoTaskRow, "progress" | "elapsed_seconds" | "question" | "final_response" | "failure_kind" | "failure_detail">> = {}): void {
    const sets = ["state = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [state, now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      values.push(v as string | number | null);
    }
    run(this.db, `UPDATE fo_tasks SET ${sets.join(", ")} WHERE id = ?`, ...values, taskId);
    this.notify(taskId);
  }

  private notify(taskId: string): void {
    const task = getTask(this.db, taskId);
    if (task) this.handlers[task.kind]?.onStateChange(task);
  }

  private recordTurn(taskId: string, direction: "to_fo" | "from_fo" | "error", tool: string, status: string | null, text: string | null): void {
    run(this.db, "INSERT INTO fo_turns (task_id, at, direction, tool, status, text) VALUES (?, ?, ?, ?, ?, ?)", taskId, now(), direction, tool, status, text);
  }

  private recordReply(taskId: string, tool: string, reply: FoReply): void {
    const text = reply.status === "working" ? (reply.progress ?? reply.response ?? null) : (reply.response ?? null);
    tx(this.db, () => this.recordTurn(taskId, "from_fo", tool, reply.status, text));
  }
}
