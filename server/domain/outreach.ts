import { createHash, randomBytes } from "node:crypto";

export interface DraftContent {
  recipientName: string;
  recipientEmail: string;
  subject: string;
  body: string;
}

/** The approval is bound to this hash: channel, recipient and exact text. */
export function contentHash(c: DraftContent): string {
  const canonical = JSON.stringify(["email", c.recipientName.trim(), c.recipientEmail.trim().toLowerCase(), c.subject, c.body]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@<>(),;:"\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(email.trim());
}

export function newReference(prefix = "KIKI"): string {
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

const RESERVED = /-----(BEGIN|END) APPROVED BODY-----|KIKI-STATUS/i;

export function validateDraft(c: DraftContent): string[] {
  const problems: string[] = [];
  if (!c.recipientName.trim()) problems.push("Add the contractor's name.");
  if (!isValidEmail(c.recipientEmail)) problems.push("Add a valid email address for the contractor.");
  if (!c.subject.trim()) problems.push("Add a subject.");
  if (!c.body.trim()) problems.push("The message is empty.");
  if (c.subject.length > 200) problems.push("The subject is too long.");
  if (c.body.length > 4000) problems.push("The message is too long.");
  if (RESERVED.test(c.subject + c.body)) problems.push("The message contains text Kiki reserves for talking to Fo.");
  return problems;
}

export interface QuoteSummary {
  issuer: string | null;
  reference: string | null;
  date: string | null;
  total: string | null;
}

export function describeQuote(q: QuoteSummary): string {
  const ref = q.reference ? `quote ${q.reference}` : "quote";
  const date = q.date ? ` dated ${q.date}` : "";
  const total = q.total ? ` (total ${q.total})` : "";
  return `${ref}${date}${total}`;
}

/** The question to the contractor: honest about who is asking, no commitments, nothing attached. */
export function contractorDraft(input: { userName: string; contractorName: string; project: string; quote: QuoteSummary }): { subject: string; body: string; purpose: string } {
  const who = input.userName.trim();
  const project = input.project.toLowerCase();
  return {
    purpose: `Confirm which ${project} quote is current, so the project index points to the right document.`,
    subject: `Question about your ${project} ${input.quote.reference ? `quote ${input.quote.reference}` : "quote"}`,
    body: `Hi ${input.contractorName.trim()},

I'm Kiki, an AI assistant helping ${who} keep the renovation paperwork organized. ${who} reviewed this message before it was sent.

Is your ${describeQuote(input.quote)} the final quote for the ${project} work, or is there a newer version we should use?

A short reply to this email is all we need. Thank you!

Kiki, on behalf of ${who}`,
  };
}

export const STATUS_LINES = {
  sent: "KIKI-STATUS: SENT",
  notSent: "KIKI-STATUS: NOT-SENT",
  needInput: "KIKI-STATUS: NEED-INPUT",
} as const;

export function buildDispatchMessage(c: DraftContent, reference: string): string {
  return `Fo-rganized request (ref ${reference}). The user reviewed and approved the exact email below in the Fo-rganized app, and asked it to have you send it.

Please send ONE email with exactly these details:
To: ${c.recipientName.trim()} <${c.recipientEmail.trim()}>
Subject: ${c.subject}
Body (send it verbatim; it is everything between the two marker lines):
-----BEGIN APPROVED BODY-----
${c.body}
-----END APPROVED BODY-----

Limits of this approval:
- Send only to the address above. No CC, BCC or other recipients.
- No attachments and no file or document sharing.
- Don't negotiate, agree to prices, or make any other commitment on the user's behalf.
- Don't contact anyone else.
- Don't include the reference code in the email.
If you can't send it exactly as written, don't send it. Ask me instead.

If ${c.recipientName.trim()} replies, please tell me in this conversation and quote their reply exactly.

End this reply with exactly one of these lines:
${STATUS_LINES.sent}
${STATUS_LINES.notSent}
${STATUS_LINES.needInput}`;
}

export function buildReplyMessage(answer: string, c: DraftContent, reference: string): string {
  return `Answer from the user about Fo-rganized request ${reference}:

${answer.trim()}

Reminder: the approval covers only sending the exact email already given (to ${c.recipientEmail.trim()}, subject "${c.subject}", body unchanged), with no attachments, sharing, commitments or other recipients. If this answer would change any of that, don't send; say so instead. End your reply with one of the KIKI-STATUS lines.`;
}

export function buildStopMessage(reference: string): string {
  return `Please don't send the email for Fo-rganized request ${reference}. The user decided not to send it. If it has already gone out, tell me. End your reply with ${STATUS_LINES.notSent} if nothing was sent, or ${STATUS_LINES.sent} if it was already sent.`;
}

/** A follow-up in the mapped conversation. It carries the same limits; it can't widen them. */
export function buildFollowUpMessage(text: string, reference: string): string {
  return `About Fo-rganized request ${reference}:

${text.trim()}

Please don't send anything new, share files, or contact anyone because of this message. If the contractor has replied, quote their reply exactly.`;
}

export type DispatchClassification = "sent" | "not_sent" | "need_input" | "unclear";

/**
 * Reads Fo's final reply for a dispatch. Only an explicit status line counts. With none, or
 * contradictory ones, the outcome is unclear, never assumed sent.
 */
export function classifyDispatchReply(reply: string): DispatchClassification {
  const found = new Set<string>();
  for (const m of reply.matchAll(/KIKI-STATUS:\s*(SENT|NOT-SENT|NEED-INPUT)\b/gi)) found.add(m[1]!.toUpperCase());
  if (found.size === 1) {
    const value = [...found][0];
    return value === "SENT" ? "sent" : value === "NOT-SENT" ? "not_sent" : "need_input";
  }
  if (found.size === 0 && looksLikeQuestion(reply)) return "need_input";
  return "unclear";
}

/** Fo is asking the user something: a question near the end of the reply. */
export function looksLikeQuestion(text: string): boolean {
  const tail = text.trim().slice(-400);
  return /\?\s*$/.test(tail) || /\?\s*\n/.test(tail);
}

/** A "working" reply whose progress says Fo is waiting on the user (documented in Fo's instructions). */
export function isWaitingForUser(progress: string | null | undefined, response: string | null | undefined): boolean {
  const text = `${progress ?? ""}\n${response ?? ""}`;
  return (
    /\bwaiting (for|on) (your|the user'?s?) (answer|reply|input|response|confirmation|decision)\b/i.test(text) ||
    /\bneeds? your (answer|input|confirmation|decision)\b/i.test(text) ||
    /\?\s*$/.test((progress ?? "").trim())
  );
}

export function stripStatusLines(text: string): string {
  return text.replace(/^.*KIKI-STATUS:.*$/gim, "").trim();
}
