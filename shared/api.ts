// Types shared by the server's view builder and the browser. Type-only: no runtime code.

export type Mode = "live" | "mock";
export type KikiState = "idle" | "reading" | "searching" | "needs_you" | "waiting" | "alert" | "done" | "error";

export interface KikiView {
  state: KikiState;
  label: string;
  detail?: string;
}

export interface ModesView {
  claude: { mode: Mode; credentialsDetected: boolean; model: string };
  fo: { mode: Mode; connection: "connected" | "needs_auth" | "error"; message?: string };
}

export interface AppView {
  modes: ModesView;
  settings: { studentName: string | null };
  requests: RequestSummary[];
  current: RequestView | null;
  kiki: KikiView;
  demos: { key: string; title: string; description: string }[];
}

export interface RequestSummary {
  id: string;
  label: string;
  createdAt: string;
  inputKind: "pasted" | "demo";
}

export interface RiskSignalView {
  id: string;
  level: "warning" | "info";
  title: string;
  detail: string;
  evidence: string[];
}

export interface RiskView {
  signals: RiskSignalView[];
  hasWarnings: boolean;
  summary: string;
  baseline: { domain: string | null; source: string | null };
  requesterDomain: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface QuotedView {
  sourceQuote: string | null;
  quoteFound: boolean;
}

export interface ExtractionView {
  status: "running" | "ready" | "failed";
  mode: Mode | null;
  error: string | null;
  requester: { name: string | null; email: string | null; domain: string | null; organization: string | null } | null;
  deadline: ({ text: string; isoDate: string | null } & QuotedView) | null;
  payments: ({ amountText: string | null; method: string | null; purpose: string | null } & QuotedView)[];
  links: { url: string; host: string | null }[];
  sensitive: { kind: string; sourceQuote: string }[];
  notes: string[];
}

export type ItemStatus = "not_searched" | "candidate" | "confirmed" | "missing" | "needs_review";

export interface CandidateView {
  name: string;
  link: string | null;
  linkNote: string | null;
}

export interface ItemView extends QuotedView {
  id: string;
  label: string;
  category: string;
  involvesOtherPerson: boolean;
  origin: "extracted" | "user";
  status: ItemStatus;
  statusReason: string | null;
  candidates: CandidateView[];
  searchable: boolean;
}

export type TaskState = "pending" | "asking" | "working" | "needs_user_input" | "complete" | "failed" | "uncertain";

export interface FoTaskView {
  taskId: string;
  mode: Mode;
  state: TaskState;
  progress: string | null;
  elapsedSeconds: number | null;
  question: string | null;
  pollPaused: boolean;
  pollError: string | null;
  failureKind: string | null;
  failureDetail: string | null;
  finalResponse: string | null;
  startedAt: string | null;
}

export interface InventoryView {
  runId: string;
  createdAt: string;
  parseStatus: "parsed" | "partial" | "malformed" | null;
  parseNotes: string[];
  task: FoTaskView;
}

export type DispatchState =
  | "approved"
  | "dispatching"
  | "working"
  | "needs_user_input"
  | "reported_sent"
  | "verified_sent"
  | "not_sent"
  | "failed"
  | "uncertain"
  | "retired";

export interface DispatchView {
  id: string;
  attempt: number;
  version: number;
  state: DispatchState;
  open: boolean;
  task: FoTaskView;
  reference: string;
  createdAt: string;
  approvedAt: string;
  recipientName: string;
  recipientEmail: string;
  subject: string;
  body: string;
  reconciledAt: string | null;
  reconcileNote: string | null;
  retiredAt: string | null;
  stopRequested: boolean;
}

export interface DraftView {
  versionId: string;
  version: number;
  recipientName: string;
  recipientEmail: string;
  subject: string;
  body: string;
  contentHash: string;
  createdAt: string;
  problems: string[];
}

export interface OutreachView {
  itemId: string;
  itemLabel: string;
  draft: DraftView | null;
  versionCount: number;
  dispatches: DispatchView[];
}

export interface TurnView {
  at: string;
  kind: "inventory" | "dispatch";
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

export interface RequestView {
  id: string;
  createdAt: string;
  inputKind: "pasted" | "demo";
  demoTitle: string | null;
  rawText: string;
  trusted: { domain: string | null; source: string | null };
  extraction: ExtractionView;
  checklistConfirmedAt: string | null;
  items: ItemView[];
  risk: RiskView | null;
  inventory: InventoryView | null;
  outreach: OutreachView[];
  evidence: { turns: TurnView[]; events: EventView[] };
}
