import type { DispatchView, KikiView, RequestView } from "../../shared/api.ts";

const ACTIVE = new Set(["pending", "asking", "working"]);

/**
 * Kiki's expression follows persisted state only, in priority order: anything that needs the
 * user's judgement first, then work in progress, then outcomes. Never a timer.
 */
export function deriveKiki(view: RequestView | null): KikiView {
  if (!view) return { state: "idle", label: "Ready when you are." };

  const ex = view.extraction;
  if (ex.status === "running") return { state: "reading", label: "Reading the request…" };
  if (ex.status === "failed") return { state: "error", label: "I couldn't read that request yet.", detail: ex.error ?? undefined };

  const dispatches: DispatchView[] = view.outreach.flatMap((o) => o.dispatches).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const inv = view.inventory?.task ?? null;

  if (view.risk?.hasWarnings && !view.risk.reviewedAt) return { state: "alert", label: "Something doesn't match. Review before sharing." };
  if (dispatches.some((d) => d.state === "uncertain")) return { state: "alert", label: "I'm not sure the email went out. Check before trying again." };

  const asking = dispatches.find((d) => d.state === "needs_user_input");
  if (asking || inv?.state === "needs_user_input") return { state: "needs_you", label: "Fo has a question for you." };

  const sending = dispatches.find((d) => d.state === "approved" || d.state === "dispatching" || d.state === "working");
  if (sending) {
    return sending.task.pollPaused
      ? { state: "waiting", label: "Fo is still on it, and keeps working even if you leave." }
      : { state: "waiting", label: `Waiting on ${sending.task.mode === "mock" ? "Mock Fo" : "Fo"} to send your approved email…` };
  }
  if (inv && ACTIVE.has(inv.state)) {
    return inv.pollPaused
      ? { state: "searching", label: "Fo is still checking, and keeps working even if you leave." }
      : { state: "searching", label: "Checking your Drive for documents…" };
  }

  const latest = dispatches[0];
  if (latest && (latest.state === "failed" || latest.state === "not_sent")) {
    return { state: "error", label: latest.state === "not_sent" ? "Fo didn't send the email." : "The email wasn't sent.", detail: latest.task.failureDetail ?? undefined };
  }
  if (latest && (latest.state === "reported_sent" || latest.state === "verified_sent")) {
    if (latest.task.mode === "mock") return { state: "done", label: "Mock Fo reports it sent. Nothing left this computer." };
    return { state: "done", label: latest.state === "verified_sent" ? "Message sent and verified. View the evidence." : "Fo reports the email was sent. View the evidence." };
  }

  if (inv && (inv.state === "failed" || inv.state === "uncertain")) return { state: "error", label: "I couldn't verify that yet." };
  if (!view.checklistConfirmedAt) return { state: "needs_you", label: "Check what I found before we search." };
  if (!view.inventory) return { state: "idle", label: "Ready to check your Drive, read-only." };

  const draft = view.outreach.find((o) => o.draft && !o.dispatches.some((d) => d.open))?.draft;
  if (draft) return { state: "needs_you", label: `Review this before I ask ${draft.recipientName || "anyone"}.` };
  if (view.items.some((i) => i.status === "candidate" || i.status === "needs_review")) return { state: "needs_you", label: "A few documents need your review." };
  if (view.items.some((i) => i.status === "missing")) return { state: "needs_you", label: "Something's missing. I can draft a request for you." };
  return { state: "idle", label: "Every item is marked handled." };
}
