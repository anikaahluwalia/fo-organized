import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);

-- The one Drive folder Kiki is allowed to organize (MVP: a single active workspace).
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  root_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  drive_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'mock')),
  origin TEXT NOT NULL CHECK (origin IN ('selected', 'staged_demo')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_inventory_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_workspace ON workspaces(active) WHERE active = 1;

-- Latest read-only inventory of everything under the workspace root.
CREATE TABLE IF NOT EXISTS files (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  parent_id TEXT,
  path TEXT NOT NULL,
  version TEXT,
  modified_time TEXT,
  created_time TEXT,
  size INTEGER,
  is_folder INTEGER NOT NULL,
  is_shortcut INTEGER NOT NULL,
  can_rename INTEGER NOT NULL,
  can_move INTEGER NOT NULL,
  can_add_children INTEGER NOT NULL,
  web_link TEXT,
  origin TEXT NOT NULL DEFAULT 'found' CHECK (origin IN ('found', 'staged_demo', 'supplied_by_user', 'created_by_kiki')),
  present INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, file_id)
);

CREATE TABLE IF NOT EXISTS inventory_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  files_seen INTEGER,
  new_files INTEGER,
  changed_files INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  index_file_id TEXT,
  index_file_version TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, category, name)
);

-- The project/document index. Facts come only from content Kiki could read.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  file_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  doc_type TEXT NOT NULL DEFAULT 'unknown',
  facts_json TEXT,
  read_status TEXT NOT NULL DEFAULT 'pending' CHECK (read_status IN ('pending', 'reading', 'read', 'unreadable', 'failed')),
  read_mode TEXT CHECK (read_mode IN ('live', 'mock')),
  read_error TEXT,
  read_file_version TEXT,
  -- Version status for quotes: identified as current, superseded, still open, or just proposed.
  version_status TEXT CHECK (version_status IN ('proposed', 'current', 'superseded', 'unresolved')),
  supersedes_id TEXT REFERENCES documents(id),
  -- The user accepted this quote's price. Separate from "current" on purpose.
  accepted_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, file_id)
);

CREATE TABLE IF NOT EXISTS version_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence_json TEXT,
  plan_id TEXT,
  at TEXT NOT NULL
);

-- Proposed changes. Every edit is a new version in the same series; approvals bind to one version.
-- What Kiki learned from your answers: where a kind of document goes, or that you keep names.
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('place', 'keep_names')),
  description TEXT NOT NULL,
  keywords_json TEXT,
  place TEXT,
  examples INTEGER NOT NULL DEFAULT 1,
  from_plan_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  series_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organize', 'version_update', 'undo')),
  status TEXT NOT NULL
    CHECK (status IN ('proposed', 'approved', 'executing', 'applied', 'partial', 'stale', 'failed', 'superseded', 'discarded')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  details_json TEXT,
  source_json TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  finished_at TEXT,
  UNIQUE (series_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_plan_per_series ON plans(series_id) WHERE status IN ('proposed', 'approved', 'executing');
CREATE UNIQUE INDEX IF NOT EXISTS one_executing_plan_per_workspace ON plans(workspace_id) WHERE status = 'executing';

CREATE TABLE IF NOT EXISTS plan_ops (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create_folder', 'move_rename', 'set_status', 'write_index')),
  file_id TEXT,
  doc_id TEXT,
  folder_path TEXT,
  parent_ref TEXT,
  new_name TEXT,
  pre_name TEXT,
  pre_parent_id TEXT,
  pre_version TEXT,
  pre_path TEXT,
  new_path TEXT,
  pre_status TEXT,
  target_status TEXT,
  target_supersedes_id TEXT,
  reason TEXT NOT NULL,
  evidence_json TEXT,
  depends_on TEXT,
  generated_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'verified', 'failed', 'stale', 'skipped', 'uncertain', 'excluded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (plan_id, seq)
);

CREATE TABLE IF NOT EXISTS plan_approvals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id),
  content_hash TEXT NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,
  approved_at TEXT NOT NULL
);

-- Original and resulting name/parent for every verified Drive change, for undo.
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  plan_op_id TEXT NOT NULL UNIQUE REFERENCES plan_ops(id),
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_name TEXT,
  before_parent_id TEXT,
  after_name TEXT NOT NULL,
  after_parent_id TEXT,
  after_version TEXT,
  applied_at TEXT NOT NULL,
  undone_by_op_id TEXT
);

-- Durable background work. dedupe_key keeps one row per logical job.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One Fo conversation driven by the app.
CREATE TABLE IF NOT EXISTS fo_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'mock')),
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'asking', 'working', 'needs_user_input', 'complete', 'failed', 'uncertain')),
  conversation_id TEXT,
  ask_started_at TEXT,
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

CREATE TABLE IF NOT EXISTS fo_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES fo_tasks(id),
  at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('to_fo', 'from_fo', 'error')),
  tool TEXT NOT NULL,
  status TEXT,
  text TEXT
);

-- Outreach drafts: every edit is a new immutable version.
CREATE TABLE IF NOT EXISTS outreach_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  version INTEGER NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  consent_confirmed INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  -- ask_final: "is this the final quote?" request_copy: "could you send a copy of X?" (X in request_json)
  kind TEXT NOT NULL DEFAULT 'ask_final' CHECK (kind IN ('ask_final', 'request_copy')),
  request_json TEXT,
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS outreach_approvals (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES outreach_versions(id),
  content_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_id TEXT NOT NULL REFERENCES outreach_versions(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES outreach_approvals(id),
  attempt INTEGER NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL UNIQUE,
  fo_task_id TEXT NOT NULL UNIQUE REFERENCES fo_tasks(id),
  open INTEGER NOT NULL DEFAULT 1,
  outcome TEXT CHECK (outcome IN ('reported_sent', 'not_sent')),
  stop_requested_at TEXT,
  reconciled_at TEXT,
  reconcile_note TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (version_id, attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_dispatch_per_document ON dispatches(document_id) WHERE open = 1;

-- A Fo conversation Kiki follows after an approved dispatch, to pick up its outcome.
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(id),
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('watching', 'paused', 'closed')),
  checks INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observed_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL REFERENCES watches(id),
  turn_key TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT,
  source TEXT NOT NULL CHECK (source IN ('fo_conversation', 'pasted_by_user')),
  baseline INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  UNIQUE (watch_id, turn_key)
);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES watches(id),
  turn_id INTEGER NOT NULL UNIQUE REFERENCES observed_turns(id),
  interpretation_json TEXT,
  interpreter_mode TEXT CHECK (interpreter_mode IN ('live', 'mock')),
  status TEXT NOT NULL
    CHECK (status IN ('interpreting', 'no_outcome', 'needs_clarification', 'proposed', 'resolved', 'dismissed', 'failed')),
  question TEXT,
  candidates_json TEXT,
  chosen_document_id TEXT,
  plan_series_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Columns added after a database was first created. Each step is idempotent. */
function migrate(db: Db): void {
  const has = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has("outreach_versions", "kind")) db.exec("ALTER TABLE outreach_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask_final' CHECK (kind IN ('ask_final', 'request_copy'))");
  if (!has("outreach_versions", "request_json")) db.exec("ALTER TABLE outreach_versions ADD COLUMN request_json TEXT");
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT. fn must be synchronous: no awaits inside a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
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

export function logEvent(db: Db, workspaceId: string | null, kind: string, message: string): void {
  run(db, "INSERT INTO events (workspace_id, at, kind, message) VALUES (?, ?, ?, ?)", workspaceId, now(), kind, message);
}

// Row shapes ------------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  root_file_id: string;
  name: string;
  drive_id: string | null;
  mode: "live" | "mock";
  origin: "selected" | "staged_demo";
  active: number;
  created_at: string;
  last_inventory_at: string | null;
}

export type FileOrigin = "found" | "staged_demo" | "supplied_by_user" | "created_by_kiki";

export interface FileRow {
  workspace_id: string;
  file_id: string;
  name: string;
  mime_type: string;
  parent_id: string | null;
  path: string;
  version: string | null;
  modified_time: string | null;
  created_time: string | null;
  size: number | null;
  is_folder: number;
  is_shortcut: number;
  can_rename: number;
  can_move: number;
  can_add_children: number;
  web_link: string | null;
  origin: FileOrigin;
  present: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface InventoryRunRow {
  id: string;
  workspace_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "done" | "failed";
  files_seen: number | null;
  new_files: number | null;
  changed_files: number | null;
  error: string | null;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  category: string;
  name: string;
  index_file_id: string | null;
  index_file_version: string | null;
  created_at: string;
}

export type VersionStatus = "proposed" | "current" | "superseded" | "unresolved";

export interface DocumentRow {
  id: string;
  workspace_id: string;
  file_id: string;
  project_id: string | null;
  doc_type: string;
  facts_json: string | null;
  read_status: "pending" | "reading" | "read" | "unreadable" | "failed";
  read_mode: "live" | "mock" | null;
  read_error: string | null;
  read_file_version: string | null;
  version_status: VersionStatus | null;
  supersedes_id: string | null;
  accepted_at: string | null;
  updated_at: string;
}

export interface VersionEventRow {
  id: number;
  document_id: string;
  kind: string;
  detail: string;
  evidence_json: string | null;
  plan_id: string | null;
  at: string;
}

export type PlanKind = "organize" | "version_update" | "undo";
export type PlanStatus = "proposed" | "approved" | "executing" | "applied" | "partial" | "stale" | "failed" | "superseded" | "discarded";

export interface LessonRow {
  id: string;
  workspace_id: string;
  kind: "place" | "keep_names";
  description: string;
  keywords_json: string | null;
  place: string | null;
  examples: number;
  from_plan_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: string;
  workspace_id: string;
  series_id: string;
  version: number;
  kind: PlanKind;
  status: PlanStatus;
  title: string;
  summary: string;
  content_hash: string;
  details_json: string | null;
  source_json: string | null;
  created_at: string;
  approved_at: string | null;
  finished_at: string | null;
}

export type OpKind = "create_folder" | "move_rename" | "set_status" | "write_index";
export type OpState = "pending" | "running" | "verified" | "failed" | "stale" | "skipped" | "uncertain" | "excluded";

export interface PlanOpRow {
  id: string;
  plan_id: string;
  seq: number;
  kind: OpKind;
  file_id: string | null;
  doc_id: string | null;
  folder_path: string | null;
  parent_ref: string | null;
  new_name: string | null;
  pre_name: string | null;
  pre_parent_id: string | null;
  pre_version: string | null;
  pre_path: string | null;
  new_path: string | null;
  pre_status: string | null;
  target_status: string | null;
  target_supersedes_id: string | null;
  reason: string;
  evidence_json: string | null;
  depends_on: string | null;
  generated_id: string | null;
  state: OpState;
  attempts: number;
  result_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ChangeLogRow {
  id: number;
  workspace_id: string;
  plan_op_id: string;
  file_id: string;
  kind: string;
  before_name: string | null;
  before_parent_id: string | null;
  after_name: string;
  after_parent_id: string | null;
  after_version: string | null;
  applied_at: string;
  undone_by_op_id: string | null;
}

export interface JobRow {
  id: string;
  kind: string;
  dedupe_key: string;
  payload_json: string;
  state: "queued" | "running" | "done" | "failed";
  attempts: number;
  run_after: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskState = "pending" | "asking" | "working" | "needs_user_input" | "complete" | "failed" | "uncertain";

export interface FoTaskRow {
  id: string;
  kind: string;
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

export interface OutreachVersionRow {
  id: string;
  workspace_id: string;
  document_id: string;
  version: number;
  recipient_name: string;
  recipient_email: string;
  consent_confirmed: number;
  purpose: string;
  subject: string;
  body: string;
  content_hash: string;
  created_at: string;
  superseded_at: string | null;
  kind: "ask_final" | "request_copy";
  /** For request_copy: the document asked for, { docType, reference }. */
  request_json: string | null;
}

export interface OutreachApprovalRow {
  id: string;
  version_id: string;
  content_hash: string;
  approved_at: string;
}

export interface DispatchRow {
  id: string;
  document_id: string;
  version_id: string;
  approval_id: string;
  attempt: number;
  client_request_id: string;
  reference: string;
  fo_task_id: string;
  open: number;
  outcome: "reported_sent" | "not_sent" | null;
  stop_requested_at: string | null;
  reconciled_at: string | null;
  reconcile_note: string | null;
  retired_at: string | null;
  created_at: string;
}

export interface WatchRow {
  id: string;
  workspace_id: string;
  dispatch_id: string;
  conversation_id: string;
  state: "watching" | "paused" | "closed";
  checks: number;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ObservedTurnRow {
  id: number;
  watch_id: string;
  turn_key: string;
  role: string;
  text: string;
  at: string | null;
  source: "fo_conversation" | "pasted_by_user";
  baseline: number;
  observed_at: string;
}

export type OutcomeStatus = "interpreting" | "no_outcome" | "needs_clarification" | "proposed" | "resolved" | "dismissed" | "failed";

export interface OutcomeRow {
  id: string;
  watch_id: string;
  turn_id: number;
  interpretation_json: string | null;
  interpreter_mode: "live" | "mock" | null;
  status: OutcomeStatus;
  question: string | null;
  candidates_json: string | null;
  chosen_document_id: string | null;
  plan_series_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  workspace_id: string | null;
  at: string;
  kind: string;
  message: string;
}
