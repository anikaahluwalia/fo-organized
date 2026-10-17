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

export function newReference(prefix = "PC"): string {
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function validateDraft(c: DraftContent): string[] {
  const problems: string[] = [];
  if (!c.recipientName.trim()) problems.push("Add who this is for (for example, Mom).");
  if (!isValidEmail(c.recipientEmail)) problems.push("Add a valid email address for the recipient.");
  if (!c.subject.trim()) problems.push("Add a subject.");
  if (!c.body.trim()) problems.push("The message is empty.");
  if (c.subject.length > 200) problems.push("The subject is too long.");
  if (c.body.length > 5000) problems.push("The message is too long.");
  if (/-----(BEGIN|END) APPROVED BODY-----|PAPER-CHASE-STATUS/i.test(c.subject + c.body)) problems.push("The message contains text Paper Chase reserves for talking to Fo.");
  return problems;
}

export function draftTemplate(input: {
  studentName: string;
  itemLabel: string;
  isGuarantor: boolean;
  organization: string | null;
  deadlineText: string | null;
}): Omit<DraftContent, "recipientName" | "recipientEmail"> & { greeting: string } {
  const who = input.studentName.trim();
  const org = input.organization?.trim() || "the landlord";
  const by = input.deadlineText ? ` by ${input.deadlineText.replace(/^by\s+/i, "")}` : "";
  const thing = input.isGuarantor ? "a signed guarantor letter" : input.itemLabel.charAt(0).toLowerCase() + input.itemLabel.slice(1);
  const subject = input.isGuarantor
    ? `Could you write a guarantor letter for ${who}'s apartment application?`
    : `${who} needs: ${input.itemLabel}`;
  const ask = input.isGuarantor
    ? `Could you write and sign one? It usually says you agree to cover the rent if ${who} can't. Please send it to ${who} directly rather than replying to this email with documents.`
    : `Could you send it to ${who} directly? Please don't reply to this email with documents.`;
  return {
    greeting: "Hi",
    subject,
    body: `This is Kiki, ${who}'s AI assistant in Paper Chase. ${who} asked me to send you this note and approved the wording before it went out.

${who} is applying for an apartment with ${org}, and they've asked for ${thing}${by}.

${ask}

If you have any questions, ${who} is the best person to ask.

Thank you!
Kiki (on ${who}'s behalf)`,
  };
}

export function withGreeting(recipientName: string, body: string): string {
  return `Hi ${recipientName.trim() || "there"},\n\n${body}`;
}

export const STATUS_LINES = {
  sent: "PAPER-CHASE-STATUS: SENT",
  notSent: "PAPER-CHASE-STATUS: NOT-SENT",
  needInput: "PAPER-CHASE-STATUS: NEED-INPUT",
} as const;

export function buildDispatchMessage(c: DraftContent, reference: string): string {
  return `Paper Chase request (ref ${reference}). The user reviewed and approved the exact email below in the Paper Chase app, and asked it to have you send it.

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
- Don't change or add to the wording, and don't make commitments on the user's behalf.
- Don't contact anyone else or follow up later.
- Don't include the reference code in the email.
If you can't send it exactly as written (for example, the recipient, subject or body would need to change), don't send it. Ask me instead.

End your reply with exactly one of these lines:
${STATUS_LINES.sent}
${STATUS_LINES.notSent}
${STATUS_LINES.needInput}`;
}

export function buildReplyMessage(answer: string, c: DraftContent, reference: string): string {
  return `Answer from the user about Paper Chase request ${reference}:

${answer.trim()}

Reminder: the approval covers only sending the exact email already given (to ${c.recipientEmail.trim()}, subject "${c.subject}", body unchanged), with no attachments, sharing or other recipients. If this answer would change any of that, don't send; say so instead. End your reply with one of the PAPER-CHASE-STATUS lines.`;
}

export function buildStopMessage(reference: string): string {
  return `Please don't send the email for Paper Chase request ${reference}. The user decided not to send it. If it has already gone out, tell me. End your reply with ${STATUS_LINES.notSent} if nothing was sent, or ${STATUS_LINES.sent} if it was already sent.`;
}

export type DispatchClassification = "sent" | "not_sent" | "need_input" | "unclear";

/**
 * Reads Fo's final reply for a dispatch. Only an explicit status line counts. If Fo's reply has
 * none, or contradictory ones, the outcome is unclear, never assumed sent.
 */
export function classifyDispatchReply(reply: string): DispatchClassification {
  const found = new Set<string>();
  for (const m of reply.matchAll(/PAPER-CHASE-STATUS:\s*(SENT|NOT-SENT|NEED-INPUT)\b/gi)) found.add(m[1]!.toUpperCase());
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
  return text.replace(/^.*PAPER-CHASE-STATUS:.*$/gim, "").trim();
}
