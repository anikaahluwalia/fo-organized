// Types shared by the server's view builder and the browser. Type-only: no runtime code.

export type Mode = "live" | "mock";
export type KikiState = "idle" | "reading" | "organizing" | "needs_approval" | "waiting" | "needs_clarification" | "verified" | "error";

export interface KikiView {
  state: KikiState;
  label: string;
  detail?: string;
}

export interface IntegrationsView {
  drive: {
    mode: Mode;
    connection: "connected" | "needs_auth" | "not_configured" | "error";
    account: string | null;
    message?: string;
    scopes: "narrow" | "full";
    missingScopes: string[];
    /** Optional read-only Gmail access, used to find a contractor's emailed attachment. */
    gmail: "connected" | "not_connected" | "mock" | "off";
  };
  claude: { mode: Mode; credentialsDetected: boolean; model: string };
  fo: { mode: Mode; connection: "connected" | "needs_auth" | "error"; message?: string };
}

export interface WorkspaceView {
  name: string;
  origin: "selected" | "staged_demo";
  mode: Mode;
  link: string | null;
  lastInventoryAt: string | null;
}

export interface FactView {
  value: string | null;
  quote: string | null;
  quoteFound: boolean | null;
}

export interface DocView {
  docId: string;
  docType: string;
  readStatus: "pending" | "reading" | "read" | "unreadable" | "failed";
  readMode: Mode | null;
  readError: string | null;
  issuer: FactView;
  reference: FactView;
  date: FactView;
  total: FactView;
  project: string | null;
  scope: string | null;
  revision: string | null;
  aiDirectedText: string[];
  textChecked: boolean;
  versionStatus: "proposed" | "current" | "superseded" | "unresolved" | null;
  acceptedAt: string | null;
}

export interface FileView {
  fileId: string;
  name: string;
  path: string;
  kind: "folder" | "file" | "shortcut";
  origin: "found" | "staged_demo" | "supplied_by_user" | "created_by_kiki";
  link: string | null;
  doc: DocView | null;
  isNew: boolean;
}

export interface InventoryView {
  status: "never" | "running" | "done" | "failed";
  lastError: string | null;
  files: FileView[];
  reading: number;
}

export type OpState = "pending" | "running" | "verified" | "failed" | "stale" | "skipped" | "uncertain" | "excluded";

export interface OpView {
  seq: number;
  kind: "create_folder" | "move_rename" | "set_status" | "write_index";
  state: OpState;
  title: string;
  before: { name: string; path: string } | null;
  after: { name: string; path: string } | null;
  reason: string;
  error: string | null;
  editable: boolean;
}

export interface NoteView {
  name: string;
  path: string;
  status: "already_organized" | "needs_review" | "left_in_place" | "waiting";
  reason: string;
}

export interface QuoteDiffView {
  lines: string[];
  total: { from: number | null; to: number | null; delta: number | null } | null;
}

export interface EvidenceView {
  source: string;
  statement: string;
  sourceKind: string | null;
  interpreter: Mode | null;
  candidateReasons: string[];
}

export type PlanStatus = "proposed" | "approved" | "executing" | "applied" | "partial" | "stale" | "failed" | "superseded" | "discarded";

export interface PlanView {
  id: string;
  version: number;
  kind: "organize" | "version_update" | "undo";
  status: PlanStatus;
  title: string;
  summary: string;
  contentHash: string;
  createdAt: string;
  approvedAt: string | null;
  finishedAt: string | null;
  ops: OpView[];
  notes: NoteView[];
  diff: QuoteDiffView | null;
  evidence: EvidenceView | null;
  conflict: string | null;
  counts: Record<OpState, number> & { total: number };
  canUndo: boolean;
  canResume: boolean;
}

export interface IndexRowView {
  docId: string;
  fileName: string;
  link: string | null;
  folder: string;
  docType: string;
  issuer: string | null;
  reference: string | null;
  date: string | null;
  total: string | null;
  status: "proposed" | "current" | "superseded" | "unresolved" | null;
  latestReceived: boolean;
  acceptedAt: string | null;
  supersedes: string | null;
  evidence: string | null;
  canAsk: boolean;
}

export interface ProjectIndexView {
  name: string;
  category: string;
  indexFileLink: string | null;
  rows: IndexRowView[];
}

export interface FoTaskView {
  taskId: string;
  mode: Mode;
  state: "pending" | "asking" | "working" | "needs_user_input" | "complete" | "failed" | "uncertain";
  progress: string | null;
  elapsedSeconds: number | null;
  question: string | null;
  pollPaused: boolean;
  pollError: string | null;
  failureKind: string | null;
  failureDetail: string | null;
  finalResponse: string | null;
}

export type DispatchState = "approved" | "dispatching" | "working" | "needs_user_input" | "reported_sent" | "not_sent" | "failed" | "uncertain" | "retired";

export interface WatchView {
  id: string;
  state: "watching" | "paused" | "closed";
  checks: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface DispatchView {
  id: string;
  attempt: number;
  version: number;
  state: DispatchState;
  open: boolean;
  task: FoTaskView;
  reference: string;
  createdAt: string;
  recipientName: string;
  recipientEmail: string;
  subject: string;
  body: string;
  reconciledAt: string | null;
  reconcileNote: string | null;
  retiredAt: string | null;
  stopRequested: boolean;
  watch: WatchView | null;
}

export interface DraftView {
  versionId: string;
  version: number;
  recipientName: string;
  recipientEmail: string;
  consentConfirmed: boolean;
  purpose: string;
  subject: string;
  body: string;
  contentHash: string;
  createdAt: string;
  problems: string[];
}

export interface OutreachView {
  documentId: string;
  kind: "ask_final" | "request_copy";
  /** The card's heading: "Ask about …" or "Ask … for a copy of …". */
  title: string;
  quoteLabel: string;
  draft: DraftView | null;
  dispatches: DispatchView[];
}

export interface CandidateView {
  docId: string;
  name: string;
  link: string | null;
  reasons: string[];
  reference: string | null;
  date: string | null;
  total: string | null;
}

export interface UpdateView {
  id: string;
  watchId: string;
  status: "interpreting" | "no_outcome" | "needs_clarification" | "proposed" | "resolved" | "dismissed" | "failed";
  createdAt: string;
  source: "fo_conversation" | "pasted_by_user";
  sourceLabel: string;
  message: string;
  statement: string | null;
  quote: string | null;
  interpreter: Mode | null;
  question: string | null;
  candidates: CandidateView[];
  planId: string | null;
  error: string | null;
  ignoredRequests: string[];
  /** Attachments Kiki found in the contractor's email (read-only), if she looked. */
  emailAttachments: { index: number; filename: string; from: string; subject: string; date: string | null; saved: boolean }[];
}

export interface TurnView {
  at: string;
  kind: string;
  mode: Mode;
  direction: "to_fo" | "from_fo" | "error";
  tool: string;
  status: string | null;
  text: string | null;
}

export interface EventView {
  at: string;
  kind: string;
  message: string;
}

export interface NotificationView {
  taskId: string;
  purpose: "find" | "done" | "summary";
  /** The plan the text was about. */
  planId: string | null;
  reply: { status: "waiting" | "approved" | "declined" | "expired" | "stale" | "failed"; text: string | null; source: "text_reply" | "relayed_by_fo" | null } | null;
  mode: Mode;
  state: FoTaskView["state"];
  outcome: "reported_sent" | "not_sent" | "unclear" | null;
  text: string | null;
  progress: string | null;
  question: string | null;
  failureDetail: string | null;
  finalResponse: string | null;
  createdAt: string;
}

export interface AttentionItemView {
  key: string;
  kind: "missing" | "expired" | "which_current" | "duplicate" | "expiring" | "undecided" | "unreadable";
  project: string | null;
  title: string;
  detail: string | null;
  evidence: string | null;
  /** A quote Fo could ask the contractor about, when asking makes sense right now. */
  askDocId: string | null;
  /** For a missing document: who could send a copy, and whether Kiki already asked. */
  copy: { documentId: string; reference: string; issuer: string | null; asked: boolean } | null;
}

export interface AppView {
  notifications: NotificationView[];
  integrations: IntegrationsView;
  settings: { userName: string | null; autoText?: boolean };
  workspace: WorkspaceView | null;
  inventory: InventoryView;
  plans: PlanView[];
  index: ProjectIndexView[];
  /** What Kiki thinks needs a person's look: missing documents, dates running out, unclear quotes. */
  attention: AttentionItemView[];
  outreach: OutreachView[];
  updates: UpdateView[];
  activity: { events: EventView[]; turns: TurnView[] };
  busy: { inventory: boolean; reading: boolean; executing: boolean; interpreting: boolean };
  kiki: KikiView;
  /** Added by the HTTP layer: whether a Chrome side panel is paired with this app. */
  extension?: { paired: boolean };
}
