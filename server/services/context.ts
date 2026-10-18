import type { Db } from "../db.ts";
import type { Reader } from "../extractor.ts";
import type { FoEngine } from "../fo/engine.ts";
import type { FoClient } from "../fo/types.ts";
import type { DriveAdapter } from "../google/types.ts";
import type { GmailAdapter } from "../google/gmail.ts";
import type { JobQueue } from "../jobs.ts";

/** Everything a service needs. Live and mock adapters share these interfaces. */
export interface Ctx {
  db: Db;
  drive: DriveAdapter;
  /** Optional, read-only: finds emailed attachments when a contractor says "I emailed it". */
  gmail: GmailAdapter | null;
  reader: Reader;
  fo: FoClient;
  engine: FoEngine;
  jobs: JobQueue;
  watchIntervalSeconds: number;
  /** Kiki's public https address for answer links in texts, if she has one. */
  publicUrl?: string | null;
  /** Fo's webhook is set up: Wajo tells Kiki when you text Fo, so a text reply can be an answer. */
  foWebhook?: boolean;
}
