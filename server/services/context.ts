import type { Db } from "../db.ts";
import type { Reader } from "../extractor.ts";
import type { FoEngine } from "../fo/engine.ts";
import type { FoClient } from "../fo/types.ts";
import type { DriveAdapter } from "../google/types.ts";
import type { JobQueue } from "../jobs.ts";

/** Everything a service needs. Live and mock adapters share these interfaces. */
export interface Ctx {
  db: Db;
  drive: DriveAdapter;
  reader: Reader;
  fo: FoClient;
  engine: FoEngine;
  jobs: JobQueue;
  watchIntervalSeconds: number;
}
