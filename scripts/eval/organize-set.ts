/**
 * Step 2 evaluation set: whole workspaces, and where every file should end up after Kiki's
 * proposal is approved and applied. Measures filing, keeping related files together (and
 * unrelated ones apart), reusing folders the user already has, and leaving alone what's already
 * filed, shortcuts, unreadable files and anything Kiki can't place.
 *
 * Paths are relative to the workspace folder; "" is its top level.
 */
import { MESSY_FOLDER } from "../../server/demo/renovation.ts";

type Match = string | RegExp;

export interface OrgFile {
  key: string;
  name: string;
  /** Folder it starts in. Folders on the way are created. */
  path: string;
  kind: "pdf" | "text" | "binary" | "empty" | "shortcut";
  title?: string;
  lines?: string[];
  /** Byte-identical copy of another file in the scenario. */
  copyOf?: string;
  /** Leave it exactly where and as it is, or file it into one of these folders (and optionally under this name). */
  expect: { stay: true } | { folder: Match | Match[]; name?: Match | "keep" | "any" };
}

export interface Scenario {
  id: string;
  about: string;
  files: OrgFile[];
  /** Empty folders that exist before Kiki looks. */
  folders?: string[];
  /** Files that must end up in the same collection. */
  together?: string[][];
  /** Files that must not end up in the same collection. */
  apart?: string[][];
}

const demo = (key: string) => MESSY_FOLDER.find((d) => d.key === key)!;
const pdf = (key: string, name: string, path = "") => ({ key, name, path, kind: "pdf" as const, title: demo(key).title, lines: demo(key).lines });

const CS245_7 = ["CS 245 - Logic and Computation", "Lecture 7: Induction and invariants", "Oct 2, 2026", "- Weak vs strong induction", "- Loop invariants: initialization, maintenance, termination"];
const MATH135_A4 = ["Assignment 4", "Due: Friday, October 23, 2026 at 11:59 pm", "Instructor: Prof. L. Chen", "1. Prove that the sum of two odd integers is even."];
const TAX_2026 = ["September 30, 2026", "Dear Anika Ahluwalia,", "Re: 2026 Property Assessment - 12 Cedar Lane, Roll No. 4401-220-118", "Your property has been reassessed at $612,000.", "Sincerely, Assessment Services"];

export const ORGANIZE_SET: Scenario[] = [
  {
    id: "renovation",
    about: "The renovation dump: four flooring documents and a business licence, all at the top level with unhelpful names.",
    files: [
      { ...pdf("oakline-quote", "scan_0012.pdf"), expect: { folder: "Projects/Flooring/Quotes", name: "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf" } },
      { ...pdf("oakline-deposit", "Oakline invoice deposit.pdf"), expect: { folder: "Projects/Flooring/Invoices", name: "2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf" } },
      { ...pdf("bright-quote", "IMG_2041.pdf"), expect: { folder: "Projects/Flooring/Quotes", name: "2026-09-20 Quote - Bright Floors Ltd. - BF-77.pdf" } },
      { ...pdf("northside-invoice", "invoice final FINAL.pdf"), expect: { folder: "Projects/Flooring/Invoices", name: "2026-10-03 Invoice - Northside Building Supply - N-5581.pdf" } },
      // A business licence belongs to no project; Kiki shouldn't invent one.
      { ...pdf("business-licence", "Business licence 2026.pdf"), expect: { stay: true } },
    ],
    together: [["oakline-quote", "oakline-deposit", "bright-quote", "northside-invoice"]],
  },
  {
    id: "student",
    about: "Two lectures of one course (worded differently), an assignment for another course, and research notes that name no course.",
    files: [
      { key: "cs245-7", name: "notes oct 2.txt", path: "", kind: "text", lines: CS245_7, expect: { folder: /^Projects\/CS 245[^/]*\/Notes$/, name: "any" } },
      {
        key: "cs245-8",
        name: "CS245 lecture 8.txt",
        path: "",
        kind: "text",
        lines: ["CS245 Lecture 8", "Recursion and structural induction", "October 7, 2026", "- Structural induction on lists and trees"],
        expect: { folder: /^Projects\/CS ?245[^/]*\/Notes$/, name: "any" },
      },
      { key: "math135-a4", name: "a4.pdf", path: "", kind: "pdf", title: "MATH 135 Fall 2026", lines: MATH135_A4, expect: { folder: /^Projects\/MATH 135[^/]*\/Assignments$/, name: "any" } },
      {
        key: "research",
        name: "Untitled document.txt",
        path: "",
        kind: "text",
        lines: ["Research notes - Sleep and memory consolidation", "Sources read this week:", "1. Walker, M. (2017). Why We Sleep.", "Key idea: slow-wave sleep supports declarative memory."],
        expect: { stay: true },
      },
    ],
    together: [["cs245-7", "cs245-8"]],
    apart: [["cs245-7", "math135-a4"]],
  },
  {
    id: "existing-folders",
    about: "The user already keeps School/<course> and Taxes folders. New files should go into them, and what's already there stays put.",
    files: [
      {
        key: "cs245-6",
        name: "CS245 lecture 6.txt",
        path: "School/CS 245",
        kind: "text",
        lines: ["CS 245 - Logic and Computation", "Lecture 6: Propositional logic proofs", "Sep 29, 2026"],
        expect: { stay: true },
      },
      { key: "tax-2025", name: "2025 assessment.pdf", path: "Taxes", kind: "pdf", title: "Riverton Property Tax Office", lines: ["September 28, 2025", "Re: 2025 Property Assessment - 12 Cedar Lane", "Assessed value: $598,000."], expect: { stay: true } },
      { key: "cs245-7", name: "notes oct 2.txt", path: "", kind: "text", lines: CS245_7, expect: { folder: "School/CS 245", name: "any" } },
      { key: "math135-a4", name: "a4.pdf", path: "", kind: "pdf", title: "MATH 135 Fall 2026", lines: MATH135_A4, expect: { folder: "School/MATH 135", name: "any" } },
      { key: "tax-2026", name: "scan 9.pdf", path: "", kind: "pdf", title: "Riverton Property Tax Office", lines: TAX_2026, expect: { folder: "Taxes", name: "any" } },
    ],
    folders: ["School/MATH 135"],
    together: [
      ["cs245-6", "cs245-7"],
      ["tax-2025", "tax-2026"],
    ],
  },
  {
    id: "work",
    about: "A launch's deck, meeting notes and contract (each naming the project differently), plus another project's standup notes.",
    files: [
      {
        key: "deck",
        name: "deck v3 FINAL.txt",
        path: "",
        kind: "text",
        lines: ["Nimbus - Investor update", "Q3 2026 board presentation", "Slide 1: Highlights", "Slide 2: $1.2M ARR, 31% QoQ growth", "Prepared by Priya Shah, September 30, 2026"],
        expect: { folder: /^Projects\/Nimbus[^/]*\/Presentations$/, name: "any" },
      },
      {
        key: "sync",
        name: "sync.txt",
        path: "",
        kind: "text",
        lines: ["Meeting notes - Nimbus launch weekly sync", "Date: 2026-10-09", "Attendees: Priya, Marco, Anika", "Decisions: launch date stays November 3."],
        expect: { folder: /^Projects\/Nimbus[^/]*\/Notes$/, name: "any" },
      },
      {
        key: "msa",
        name: "msa.pdf",
        path: "",
        kind: "pdf",
        title: "MASTER SERVICES AGREEMENT",
        lines: ["Between Nimbus Labs Inc. and Brightline Design LLC", "Effective date: August 15, 2026", "Project: Nimbus launch website", "Fees: $18,000.00, payable in three milestones."],
        expect: { folder: /^Projects\/Nimbus[^/]*\/Contracts$/, name: "any" },
      },
      {
        key: "standup",
        name: "standup notes.txt",
        path: "",
        kind: "text",
        lines: ["Meeting notes - Orbit migration standup", "Date: 2026-10-08", "Blockers: database cutover window."],
        expect: { folder: /^Projects\/Orbit[^/]*\/Notes$/, name: "any" },
      },
    ],
    together: [["deck", "sync", "msa"]],
    apart: [["sync", "standup"]],
  },
  {
    id: "personal",
    about: "A trip itinerary and its hotel booking, a store receipt and a budget sheet that belong to nothing in particular.",
    files: [
      {
        key: "trip",
        name: "trip.txt",
        path: "",
        kind: "text",
        lines: ["Trip itinerary - Kyoto, spring 2027", "Booking ref: QX7P2L", "Mar 28, 2027  Air Canada AC 3  Toronto (YYZ) to Tokyo Haneda (HND)", "Hotel: Kyoto Gion Inn, Mar 29 to Apr 3"],
        expect: { folder: /^Projects\/Kyoto[^/]*\/Itineraries$/, name: "any" },
      },
      {
        key: "hotel",
        name: "confirmation.pdf",
        path: "",
        kind: "pdf",
        title: "Kyoto Gion Inn",
        lines: ["Reservation confirmation HTL-2219", "Guest: Anika Ahluwalia", "Check-in: March 29, 2027", "Check-out: April 3, 2027", "Trip: Kyoto, spring 2027"],
        expect: { folder: /^Projects\/Kyoto[^/]*\/[^/]+$/, name: "any" },
      },
      { key: "receipt", name: "IMG_3381.txt", path: "", kind: "text", lines: ["HOME HARDWARE #4471", "2026-10-05 14:32", "Wood glue 2x  $17.98", "TOTAL  $17.98"], expect: { stay: true } },
      { key: "budget", name: "budget.csv", path: "", kind: "text", lines: ["Item,Estimate,Actual", "Flooring,8450,", "Paint,900,"], expect: { stay: true } },
    ],
    together: [["trip", "hotel"]],
  },
  {
    id: "catch-all",
    about: "Files in catch-all folders (Old scans, Downloads) are still waiting to be filed; files in folders the user made (Archive, School) stay where they are.",
    files: [
      { ...pdf("oakline-quote", "scan_0012.pdf", "Old scans"), expect: { folder: "Projects/Flooring/Quotes", name: "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf" } },
      { ...pdf("bright-quote", "IMG_2041.pdf", "Downloads"), expect: { folder: "Projects/Flooring/Quotes", name: "2026-09-20 Quote - Bright Floors Ltd. - BF-77.pdf" } },
      { ...pdf("oakline-deposit", "Oakline invoice deposit.pdf", "Archive"), expect: { stay: true } },
      // No School/CS 245 folder to put it in, and the user chose School: Kiki doesn't move it out.
      { key: "cs245-7", name: "notes oct 2.txt", path: "School", kind: "text", lines: CS245_7, expect: { stay: true } },
    ],
    together: [["oakline-quote", "bright-quote"]],
  },
  {
    id: "already-organized",
    about: "Filed documents stay as they are; an exact copy is set aside; a shortcut, an unreadable file and two empty files are left alone.",
    files: [
      { ...pdf("oakline-quote", "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf", "Projects/Flooring/Quotes"), expect: { stay: true } },
      { ...pdf("oakline-deposit", "2026-10-01 Invoice - Oakline Flooring Co. - INV-3307.pdf", "Projects/Flooring/Invoices"), expect: { stay: true } },
      { key: "copy", name: "scan_0012 (1).pdf", path: "", kind: "pdf", copyOf: "oakline-quote", expect: { folder: "Projects/Flooring/Quotes/Duplicates", name: "2026-09-28 Quote - Oakline Flooring Co. - Q-1042.pdf" } },
      { key: "shortcut", name: "Tax letter (shortcut)", path: "", kind: "shortcut", expect: { stay: true } },
      { key: "binary", name: "scan.heic", path: "", kind: "binary", expect: { stay: true } },
      { key: "empty-1", name: "notes.txt", path: "", kind: "empty", expect: { stay: true } },
      { key: "empty-2", name: "notes copy.txt", path: "", kind: "empty", expect: { stay: true } },
    ],
  },
];
