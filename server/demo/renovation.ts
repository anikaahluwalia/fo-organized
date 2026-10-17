import { makePdf } from "./pdf.ts";

/**
 * Synthetic renovation paperwork for the staged demo. Every document says it is synthetic, the
 * companies and addresses are invented, and each file is labelled "Staged demo file" in the app.
 */
export interface DemoDoc {
  key: string;
  fileName: string;
  mimeType: string;
  title: string;
  lines: string[];
}

const FOOTER = ["", "SYNTHETIC DEMO DOCUMENT - not a real business record."];

export const DEMO_WORKSPACE_NAME = "Fo-rganized demo - renovation paperwork (synthetic)";

/** The "messy folder": everything dumped in one place with unhelpful names. */
export const MESSY_FOLDER: DemoDoc[] = [
  {
    key: "oakline-quote",
    fileName: "scan_0012.pdf",
    mimeType: "application/pdf",
    title: "QUOTE",
    lines: [
      "Oakline Flooring Co.",
      "48 Birch Road, Unit 2, Riverton",
      "Quote No: Q-1042",
      "Date: 2026-09-28",
      "Project: Flooring - main floor, 12 Cedar Lane",
      "",
      "Scope of work",
      "Supply 620 sq ft engineered oak, 7 inch planks: $6,200.00",
      "Installation labour: $1,850.00",
      "Underlay and trims: $400.00",
      "",
      "Total (CAD): $8,450.00",
      "Valid for 30 days.",
      ...FOOTER,
    ],
  },
  {
    key: "oakline-deposit",
    fileName: "Oakline invoice deposit.pdf",
    mimeType: "application/pdf",
    title: "INVOICE",
    lines: [
      "Oakline Flooring Co.",
      "Invoice No: INV-3307",
      "Date: 2026-10-01",
      "Project: Flooring - main floor, 12 Cedar Lane",
      "",
      "Deposit (20%) for Quote Q-1042: $1,690.00",
      "",
      "Amount due (CAD): $1,690.00",
      ...FOOTER,
    ],
  },
  {
    key: "bright-quote",
    fileName: "IMG_2041.pdf",
    mimeType: "application/pdf",
    title: "ESTIMATE / QUOTE",
    lines: [
      "Bright Floors Ltd.",
      "Quote No: BF-77",
      "Date: 2026-09-20",
      "Project: Flooring - main floor laminate option",
      "",
      "Supply and install 620 sq ft laminate: $6,980.00",
      "",
      "Total (CAD): $6,980.00",
      ...FOOTER,
    ],
  },
  {
    key: "northside-invoice",
    fileName: "invoice final FINAL.pdf",
    mimeType: "application/pdf",
    title: "INVOICE",
    lines: [
      "Northside Building Supply",
      "Invoice No: N-5581",
      "Date: 2026-10-03",
      "Project: Flooring materials",
      "",
      "Acoustic underlay, 7 rolls: $412.37",
      "",
      "Total (CAD): $412.37",
      ...FOOTER,
    ],
  },
  {
    key: "business-licence",
    fileName: "Business licence 2026.pdf",
    mimeType: "application/pdf",
    title: "BUSINESS LICENCE",
    lines: ["City of Riverton", "Licence No: BL-2026-0193", "Valid: 2026-01-01 to 2026-12-31", "Licensed activity: general contracting", ...FOOTER],
  },
];

/** What the contractor emails after Fo's question: the revised quote. */
export const REVISED_QUOTE: DemoDoc = {
  key: "oakline-quote-r1",
  fileName: "Oakline Flooring - revised quote.pdf",
  mimeType: "application/pdf",
  title: "QUOTE (REVISED)",
  lines: [
    "Oakline Flooring Co.",
    "Quote No: Q-1042-R1",
    "Date: 2026-10-17",
    "Revision 1 - replaces Quote Q-1042",
    "Project: Flooring - main floor, 12 Cedar Lane",
    "",
    "Scope of work",
    "Supply 620 sq ft engineered oak, 5 inch planks: $5,780.00",
    "Installation labour: $1,850.00",
    "Remove and dispose of existing carpet: $350.00",
    "Underlay: supplied by owner",
    "",
    "Total (CAD): $7,980.00",
    ...FOOTER,
  ],
};

/** The ambiguity scenario: a second same-day revision, so "the revised quote" is unclear. */
export const SECOND_REVISION: DemoDoc = {
  key: "oakline-quote-r2",
  fileName: "Oakline quote rev 2.pdf",
  mimeType: "application/pdf",
  title: "QUOTE (REVISED)",
  lines: [
    "Oakline Flooring Co.",
    "Quote No: Q-1042-R2",
    "Date: 2026-10-17",
    "Revision 2 - replaces Quote Q-1042",
    "Project: Flooring - main floor, 12 Cedar Lane",
    "",
    "Scope of work",
    "Supply 620 sq ft engineered oak, 5 inch planks: $5,780.00",
    "Installation labour: $1,850.00",
    "Remove and dispose of existing carpet: $350.00",
    "Stair nosing, 2 pieces: $140.00",
    "",
    "Total (CAD): $8,120.00",
    ...FOOTER,
  ],
};

export function demoFileContent(doc: DemoDoc): Buffer {
  return makePdf(doc.title, doc.lines);
}

/** The demo's star: a new supplier invoice dropped into Drive. It doesn't say which project it's for. */
export const NEW_SUPPLIER_INVOICE: DemoDoc = {
  key: "northside-invoice-2",
  fileName: "Northside invoice Oct 17.pdf",
  mimeType: "application/pdf",
  title: "INVOICE",
  lines: [
    "Northside Building Supply",
    "Invoice No: N-5602",
    "Date: 2026-10-17",
    "Bill to: 12 Cedar Lane",
    "",
    "Transition strips, 4 pieces: $96.40",
    "Floor levelling compound, 4 bags: $190.00",
    "",
    "Total (CAD): $286.40",
    ...FOOTER,
  ],
};
