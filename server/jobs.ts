import { randomUUID } from "node:crypto";
import { all, now, one, run, tx, type Db, type JobRow } from "./db.ts";

export type JobResult = { rescheduleSeconds?: number } | void;
export type JobHandler = (payload: Record<string, unknown>, job: JobRow) => Promise<JobResult>;

/** Errors that should end a job without retrying (they need a person, not another attempt). */
export class PermanentJobError extends Error {}

const MAX_ATTEMPTS = 6;

/**
 * A small durable job queue in SQLite. One row per logical job (dedupe_key), so enqueueing the
 * same work twice is harmless. Handlers must be idempotent: after a crash, running jobs are
 * queued again and run from the start.
 */
export class JobQueue {
  private readonly db: Db;
  private readonly handlers: Record<string, JobHandler>;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  private stopped = false;

  constructor(db: Db, handlers: Record<string, JobHandler> = {}) {
    this.db = db;
    this.handlers = handlers;
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers[kind] = handler;
  }

  /** Adds a job, or re-queues a finished one with the same key. A queued or running job is left alone. */
  enqueue(kind: string, dedupeKey: string, payload: Record<string, unknown>, delaySeconds = 0): void {
    const at = now();
    const runAfter = new Date(Date.now() + delaySeconds * 1000).toISOString();
    tx(this.db, () => {
      const existing = one<JobRow>(this.db, "SELECT * FROM jobs WHERE dedupe_key = ?", dedupeKey);
      if (!existing) {
        run(this.db, "INSERT INTO jobs (id, kind, dedupe_key, payload_json, state, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)", randomUUID(), kind, dedupeKey, JSON.stringify(payload), runAfter, at, at);
      } else if (existing.state === "done" || existing.state === "failed") {
        run(this.db, "UPDATE jobs SET state = 'queued', payload_json = ?, attempts = 0, last_error = NULL, run_after = ?, updated_at = ? WHERE id = ?", JSON.stringify(payload), runAfter, at, existing.id);
      } else if (existing.state === "queued" && runAfter < existing.run_after) {
        run(this.db, "UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ?", runAfter, at, existing.id);
      }
    });
    this.poke();
  }

  /** After a restart: work that was running is run again (handlers are idempotent). */
  recover(): void {
    run(this.db, "UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'running'", now());
  }

  start(intervalMs = 400): void {
    this.stopped = false;
    this.timer ??= setInterval(() => this.poke(), intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poke(): void {
    if (this.stopped || this.busy || !this.timer) return;
    this.busy = this.runDue().then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.busy = null;
    });
  }

  /** Runs every job that is due now, one at a time. Returns how many ran. */
  async runDue(): Promise<number> {
    let ran = 0;
    for (;;) {
      if (this.stopped) break;
      const job = one<JobRow>(this.db, "SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? ORDER BY run_after, created_at LIMIT 1", now());
      if (!job) break;
      ran++;
      await this.runOne(job);
    }
    return ran;
  }

  /** For tests: keep running due jobs until none are left. Future-scheduled jobs are not waited for. */
  async drain(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.runDue()) === 0) return;
    }
    throw new Error("Jobs didn't settle.");
  }

  private async runOne(job: JobRow): Promise<void> {
    const claimed = run(this.db, "UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'queued'", now(), job.id);
    if (claimed !== 1) return;
    const handler = this.handlers[job.kind];
    try {
      if (!handler) throw new PermanentJobError(`No handler for job kind ${job.kind}`);
      const result = await handler(JSON.parse(job.payload_json) as Record<string, unknown>, job);
      const reschedule = result && typeof result === "object" ? result.rescheduleSeconds : undefined;
      if (reschedule !== undefined) {
        run(this.db, "UPDATE jobs SET state = 'queued', attempts = 0, last_error = NULL, run_after = ?, updated_at = ? WHERE id = ?", new Date(Date.now() + reschedule * 1000).toISOString(), now(), job.id);
      } else {
        run(this.db, "UPDATE jobs SET state = 'done', last_error = NULL, updated_at = ? WHERE id = ?", now(), job.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;
      if (err instanceof PermanentJobError || attempts >= MAX_ATTEMPTS) {
        run(this.db, "UPDATE jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?", message, now(), job.id);
      } else {
        const backoff = Math.min(300, 2 ** attempts);
        run(this.db, "UPDATE jobs SET state = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?", message, new Date(Date.now() + backoff * 1000).toISOString(), now(), job.id);
      }
    }
  }

  pending(kind?: string): JobRow[] {
    return kind
      ? all<JobRow>(this.db, "SELECT * FROM jobs WHERE kind = ? AND state IN ('queued', 'running')", kind)
      : all<JobRow>(this.db, "SELECT * FROM jobs WHERE state IN ('queued', 'running')");
  }

  get(dedupeKey: string): JobRow | undefined {
    return one<JobRow>(this.db, "SELECT * FROM jobs WHERE dedupe_key = ?", dedupeKey);
  }
}
