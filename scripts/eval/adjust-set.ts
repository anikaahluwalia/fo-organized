/**
 * Step 3 evaluation set: the user's answer to a proposal, relayed by Fo, and the changes Kiki
 * should make to the proposal from it. Approving or declining is never taken from these: only
 * Fo's bound decision does that. What matters most is never inventing a change the user didn't
 * ask for (it would land in the next version they're asked to approve).
 */
export interface ProposalItem {
  n: number;
  /** "move": a file Kiki proposes to move or rename. "unplaced": a file Kiki couldn't place. */
  kind: "move" | "unplaced";
  name: string;
  to?: string;
  why?: string;
}

export type EditAction = "skip" | "rename" | "keep_name" | "move";
export interface ExpectedEdit {
  item: number;
  action: EditAction;
  /** For rename: text the new name must contain. For move: the collection or folder named. */
  value?: string;
}

export interface AdjustCase {
  id: string;
  reply: string;
  expected: {
    kind: "changes" | "question" | "none";
    edits: ExpectedEdit[];
    /** Items the reply may or may not touch without it counting against Kiki. */
    optional?: number[];
    /** Asks Kiki can't do in a proposal (delete, share, email someone). */
    unsupported: "some" | "none";
  };
}

export const PROPOSAL: ProposalItem[] = [
  { n: 1, kind: "move", name: "scan_0012.pdf", to: "Projects/Flooring/Quotes/2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf" },
  { n: 2, kind: "move", name: "Oakline invoice deposit.pdf", to: "Projects/Flooring/Invoices/2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf" },
  { n: 3, kind: "move", name: "IMG_2041.pdf", to: "Projects/Flooring/Quotes/2026-09-20 Quote - Bright Floors Ltd. - BF-77.pdf" },
  { n: 4, kind: "move", name: "invoice final FINAL.pdf", to: "Projects/Flooring/Invoices/2026-10-03 Invoice - Northside Building Supply - N-5581.pdf" },
  { n: 5, kind: "unplaced", name: "Business licence 2026.pdf", why: "Kiki couldn't tell which project or folder it belongs to." },
];

const moves = [1, 2, 3, 4];

export const ADJUST_SET: AdjustCase[] = [
  { id: "skip-one", reply: "Skip the Bright Floors quote, the rest is fine.", expected: { kind: "changes", edits: [{ item: 3, action: "skip" }], unsupported: "none" } },
  { id: "move-one", reply: "Yes, but the Northside invoice is for the kitchen, not the floors.", expected: { kind: "changes", edits: [{ item: 4, action: "move", value: "Kitchen" }], unsupported: "none" } },
  { id: "rename-one", reply: "Call the deposit one \"Oakline deposit\".", expected: { kind: "changes", edits: [{ item: 2, action: "rename", value: "Oakline deposit" }], unsupported: "none" } },
  { id: "keep-names", reply: "Don't rename anything, just move them.", expected: { kind: "changes", edits: moves.map((item) => ({ item, action: "keep_name" as const })), unsupported: "none" } },
  { id: "place-unplaced", reply: "Put the business licence in a folder called Business.", expected: { kind: "changes", edits: [{ item: 5, action: "move", value: "Business" }], unsupported: "none" } },
  { id: "by-type", reply: "File the quotes but leave the invoices where they are for now.", expected: { kind: "changes", edits: [{ item: 2, action: "skip" }, { item: 4, action: "skip" }], unsupported: "none" } },
  { id: "two-changes", reply: "Northside's invoice goes under Kitchen, and rename IMG_2041 to Bright Floors quote.", expected: { kind: "changes", edits: [{ item: 4, action: "move", value: "Kitchen" }, { item: 3, action: "rename", value: "Bright Floors quote" }], unsupported: "none" } },
  { id: "rename-all-collection", reply: "Use Kitchen Reno as the folder for all four instead of Flooring.", expected: { kind: "changes", edits: moves.map((item) => ({ item, action: "move" as const, value: "Kitchen Reno" })), unsupported: "none" } },
  { id: "by-number", reply: "Skip number 3, and keep the original name for number 2.", expected: { kind: "changes", edits: [{ item: 3, action: "skip" }, { item: 2, action: "keep_name" }], unsupported: "none" } },
  { id: "question", reply: "What's IMG_2041? I don't remember that one.", expected: { kind: "question", edits: [], unsupported: "none" } },
  { id: "described-folder", reply: "Put the licence in a new work folder.", expected: { kind: "changes", edits: [{ item: 5, action: "move", value: "Work" }], unsupported: "none" } },
  { id: "plain-yes", reply: "Yes, go ahead.", expected: { kind: "none", edits: [], unsupported: "none" } },
  { id: "plain-no", reply: "No thanks, leave it all as it is.", expected: { kind: "none", edits: [], unsupported: "none" } },
  { id: "unsure", reply: "Hmm, maybe later.", expected: { kind: "none", edits: [], unsupported: "none" } },
  {
    id: "unsupported",
    reply: "Also delete the old scans and email Oakline that the deposit is paid.",
    expected: { kind: "none", edits: [], unsupported: "some" },
  },
  {
    id: "skip-unplaced",
    reply: "The Northside one is for the kitchen. And don't bother with the licence.",
    expected: { kind: "changes", edits: [{ item: 4, action: "move", value: "Kitchen" }], optional: [5], unsupported: "none" },
  },
];
