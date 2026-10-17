import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('pasted', 'demo')),
  demo_key TEXT,
  raw_text TEXT NOT NULL,
  trusted_domain TEXT,
  trusted_source TEXT,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('running', 'ready', 'failed')),
  extraction_mode TEXT CHECK (extraction_mode IN ('live', 'mock')),
  extraction_json TEXT,
  extraction_error TEXT,
  checklist_confirmed_at TEXT,
  risk_json TEXT,
  risk_reviewed_at TEXT,
  risk_review_note TEXT
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  source_quote TEXT,
  quote_found INTEGER NOT NULL DEFAULT 0,
  involves_other_person INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL CHECK (origin IN ('extracted', 'user')),
  removed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_searched'
    CHECK (status IN ('not_searched', 'candidate', 'confirmed', 'missing', 'needs_review')),
  status_reason TEXT,
  candidates_json TEXT,
  updated_at TEXT NOT NULL
);

-- One Fo conversation driven by the app: a read-only inventory search or one email dispatch.
CREATE TABLE IF NOT EXISTS fo_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('inventory', 'dispatch')),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'mock')),
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'asking', 'working', 'needs_user_input', 'complete', 'failed', 'uncertain')),
  conversation_id TEXT,          -- server-issued by Fo; never sent to the browser
  ask_started_at TEXT,           -- written before every ask_fo call, so a crash mid-call is detectable
  progress TEXT,
  elapsed_seconds INTEGER,
  question TEXT,
  final_response TEXT,
  failure_kind TEXT,
  failure_detail TEXT,
  poll_paused INTEGER NOT NULL DEFAULT 0,
  poll_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Evidence: every message sent to Fo and every reply or error, verbatim.
CREATE TABLE IF NOT EXISTS fo_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES fo_tasks(id),
  at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('to_fo', 'from_fo', 'error')),
  tool TEXT NOT NULL,
  status TEXT,
  text TEXT
);

CREATE TABLE IF NOT EXISTS inventory_runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  fo_task_id TEXT NOT NULL UNIQUE REFERENCES fo_tasks(id),
  client_request_id TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL UNIQUE,
  search_items_json TEXT NOT NULL, -- the C1..Cn -> item mapping sent to Fo, needed to parse its reply
  open INTEGER NOT NULL DEFAULT 1,
  parse_status TEXT CHECK (parse_status IN ('parsed', 'partial', 'malformed')),
  parse_notes TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_inventory_per_request ON inventory_runs(request_id) WHERE open = 1;

-- Every edit of an outreach draft is a new immutable version.
CREATE TABLE IF NOT EXISTS action_versions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  item_id TEXT NOT NULL REFERENCES checklist_items(id),
  version INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'email'),
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE (item_id, version)
);

-- An approval is bound to one version and the hash of exactly what the user saw.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action_version_id TEXT NOT NULL REFERENCES action_versions(id),
  content_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  risk_review_acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES checklist_items(id),
  action_version_id TEXT NOT NULL REFERENCES action_versions(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  attempt INTEGER NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL UNIQUE,
  fo_task_id TEXT NOT NULL UNIQUE REFERENCES fo_tasks(id),
  open INTEGER NOT NULL DEFAULT 1,
  outcome TEXT CHECK (outcome IN ('reported_sent', 'verified_sent', 'not_sent')),
  stop_requested_at TEXT,
  reconciled_at TEXT,
  reconcile_note TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (action_version_id, attempt)
);
-- At most one dispatch per checklist item can be in flight or unresolved at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_dispatch_per_item ON dispatches(item_id) WHERE open = 1;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT. fn must be synchronous: no awaits inside a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function one<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export function now(): string {
  return new Date().toISOString();
}

export function kvGet(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, "SELECT value FROM kv WHERE key = ?", key)?.value;
}

export function kvSet(db: Db, key: string, value: string | undefined): void {
  if (value === undefined) run(db, "DELETE FROM kv WHERE key = ?", key);
  else
    run(db, "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, value, now());
}

export function logEvent(db: Db, requestId: string | null, kind: string, message: string): void {
  run(db, "INSERT INTO events (request_id, at, kind, message) VALUES (?, ?, ?, ?)", requestId, now(), kind, message);
}

// Row shapes ------------------------------------------------------------------------------

export interface RequestRow {
  id: string;
  created_at: string;
  input_kind: "pasted" | "demo";
  demo_key: string | null;
  raw_text: string;
  trusted_domain: string | null;
  trusted_source: string | null;
  extraction_status: "running" | "ready" | "failed";
  extraction_mode: "live" | "mock" | null;
  extraction_json: string | null;
  extraction_error: string | null;
  checklist_confirmed_at: string | null;
  risk_json: string | null;
  risk_reviewed_at: string | null;
  risk_review_note: string | null;
}

export type ItemStatus = "not_searched" | "candidate" | "confirmed" | "missing" | "needs_review";

export interface ItemRow {
  id: string;
  request_id: string;
  position: number;
  label: string;
  category: string;
  source_quote: string | null;
  quote_found: number;
  involves_other_person: number;
  origin: "extracted" | "user";
  removed: number;
  status: ItemStatus;
  status_reason: string | null;
  candidates_json: string | null;
  updated_at: string;
}

export type TaskState = "pending" | "asking" | "working" | "needs_user_input" | "complete" | "failed" | "uncertain";

export interface FoTaskRow {
  id: string;
  kind: "inventory" | "dispatch";
  mode: "live" | "mock";
  state: TaskState;
  conversation_id: string | null;
  ask_started_at: string | null;
  progress: string | null;
  elapsed_seconds: number | null;
  question: string | null;
  final_response: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  poll_paused: number;
  poll_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FoTurnRow {
  id: number;
  task_id: string;
  at: string;
  direction: "to_fo" | "from_fo" | "error";
  tool: string;
  status: string | null;
  text: string | null;
}

export interface InventoryRunRow {
  id: string;
  request_id: string;
  fo_task_id: string;
  client_request_id: string;
  reference: string;
  search_items_json: string;
  open: number;
  parse_status: "parsed" | "partial" | "malformed" | null;
  parse_notes: string | null;
  created_at: string;
}

export interface ActionVersionRow {
  id: string;
  request_id: string;
  item_id: string;
  version: number;
  channel: "email";
  recipient_name: string;
  recipient_email: string;
  subject: string;
  body: string;
  content_hash: string;
  created_at: string;
  superseded_at: string | null;
}

export interface ApprovalRow {
  id: string;
  action_version_id: string;
  content_hash: string;
  approved_at: string;
  risk_review_acknowledged: number;
}

export interface DispatchRow {
  id: string;
  item_id: string;
  action_version_id: string;
  approval_id: string;
  attempt: number;
  client_request_id: string;
  reference: string;
  fo_task_id: string;
  open: number;
  outcome: "reported_sent" | "verified_sent" | "not_sent" | null;
  stop_requested_at: string | null;
  reconciled_at: string | null;
  reconcile_note: string | null;
  retired_at: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  request_id: string | null;
  at: string;
  kind: string;
  message: string;
}
