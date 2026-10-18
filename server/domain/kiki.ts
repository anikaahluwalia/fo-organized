import type { AppView, KikiView } from "../../shared/api.ts";

/**
 * Kiki's expression follows persisted state only, never a timer. Priority: things that went
 * wrong, then things that need the user's answer, then work in progress, then decisions,
 * waiting on someone, and finally a verified result.
 */
export function deriveKiki(v: Omit<AppView, "kiki">): KikiView {
  if (!v.workspace) {
    if (v.integrations.drive.connection !== "connected") return { state: "idle", label: "Connect Google Drive to start." };
    return { state: "idle", label: "Which folder should I organize?" };
  }

  const live = v.plans.filter((p) => p.status !== "superseded" && p.status !== "discarded");
  const dispatches = v.outreach.flatMap((o) => o.dispatches);

  const failedPlan = live.find((p) => p.status === "partial" || p.status === "failed");
  if (failedPlan) return { state: "error", label: "Some changes didn't finish.", detail: failedPlan.title };
  if (v.inventory.status === "failed") return { state: "error", label: "I couldn't look through the folder.", detail: v.inventory.lastError ?? undefined };
  const failedUpdate = v.updates.find((u) => u.status === "failed");
  if (failedUpdate) return { state: "error", label: "I couldn't read Fo's update yet.", detail: failedUpdate.error ?? undefined };
  const lastDispatch = [...dispatches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (lastDispatch && (lastDispatch.state === "failed" || lastDispatch.state === "not_sent")) {
    return { state: "error", label: lastDispatch.state === "not_sent" ? "Fo didn't send the email." : "The email wasn't sent.", detail: lastDispatch.task.failureDetail ?? undefined };
  }

  const ambiguous = v.updates.find((u) => u.status === "needs_clarification");
  if (ambiguous) {
    return {
      state: "needs_clarification",
      label: ambiguous.candidates.length > 1 ? `${ambiguous.candidates.length} files could be the revised quote. Which one?` : "I need a little help with Fo's update.",
    };
  }
  if (dispatches.some((d) => d.state === "needs_user_input")) return { state: "needs_clarification", label: "Fo has a question for you." };
  if (dispatches.some((d) => d.state === "uncertain")) return { state: "needs_clarification", label: "I'm not sure the email went out. Let's check before trying again." };
  if (live.some((p) => p.status === "stale")) return { state: "needs_clarification", label: "Something changed since you previewed. Let's refresh the plan." };

  if (v.busy.executing || live.some((p) => p.status === "executing" || p.status === "approved")) return { state: "organizing", label: "Organizing…" };
  if (v.busy.interpreting || v.updates.some((u) => u.status === "interpreting")) return { state: "reading", label: "Reading Fo's update…" };
  // Background polling isn't news; only the very first look counts as reading.
  if (!v.inventory.files.length && (v.busy.inventory || v.inventory.status === "running")) return { state: "reading", label: "Looking through the folder…" };
  if (v.busy.reading || v.inventory.reading > 0) return { state: "reading", label: "Reading your documents…" };

  const proposed = live.find((p) => p.status === "proposed");
  if (proposed) return { state: "needs_approval", label: "I have a plan. Take a look.", detail: proposed.title };
  const unsent = (o: (typeof v.outreach)[number]) => o.draft && !o.dispatches.some((d) => d.version === o.draft!.version && !["failed", "not_sent", "retired"].includes(d.state));
  const draft = v.outreach.find(unsent);
  if (draft?.draft) return { state: "needs_approval", label: `Review the message before Fo sends it to ${draft.draft.recipientName}.` };

  const sending = dispatches.find((d) => d.state === "approved" || d.state === "dispatching" || d.state === "working");
  if (sending) return { state: "waiting", label: sending.task.pollPaused ? "Fo is still on it, and keeps working even if you leave." : "Waiting on Fo to send your approved email…" };
  const watching = dispatches.find((d) => d.watch?.state === "watching" && !v.updates.some((u) => u.watchId === d.watch!.id && (u.status === "proposed" || u.status === "resolved")));
  if (watching) return { state: "waiting", label: `Waiting for ${watching.recipientName} to reply.`, detail: "I'm following the Fo conversation and will pick up the answer." };

  const look = v.attention.length;
  const lookLine = look ? `${look} thing${look === 1 ? "" : "s"} in the folder could use a look.` : null;
  const latest = [...live].sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
  if (latest?.status === "applied") return { state: "verified", label: "All done.", detail: lookLine ?? latest.title };
  if (!v.inventory.files.length) return { state: "idle", label: "Ready." };
  return { state: "idle", label: "Ready when you are.", ...(lookLine ? { detail: lookLine } : {}) };
}
