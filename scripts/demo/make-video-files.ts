/**
 * The files for the demo video: synthetic but realistic paperwork with the names people really
 * give files. Drop them at the top of My Drive (Kiki watching the whole Drive) when the script
 * says so.
 *   node scripts/demo/make-video-files.ts [out-dir]   (default: demo-files/video)
 */
import fs from "node:fs";
import path from "node:path";
import { makePdf } from "../../server/demo/pdf.ts";

const out = path.resolve(process.argv[2] ?? "demo-files/video");

const quote = makePdf("QUOTE", [
  "Oakline Flooring Co.",
  "Quote No: Q-1042",
  "Date: 2026-09-28",
  "Project: Flooring",
  "",
  "Engineered oak, 640 sq ft, supply and install: $7,900.00",
  "Removal and disposal of old carpet: $550.00",
  "",
  "Total (CAD): $8,450.00",
  "Valid for 30 days.",
]);

const files: Record<string, Buffer> = {
  // Round 1: the messy folder.
  "scan_0012.pdf": quote,
  "IMG_2041.pdf": makePdf("ESTIMATE / QUOTE", [
    "Bright Floors Ltd.",
    "Estimate #: BF-77",
    "Date: 2026-09-20",
    "Project: Flooring",
    "",
    "Laminate, 640 sq ft, installed: $6,980.00",
    "",
    "Total (CAD): $6,980.00",
  ]),
  "Oakline invoice deposit.pdf": makePdf("INVOICE", [
    "Oakline Flooring Co.",
    "Invoice No: INV-3307",
    "Date: 2026-10-01",
    "Project: Flooring",
    "Deposit for Quote Q-1042",
    "",
    "Deposit, 20%: $1,690.00",
    "",
    "Total (CAD): $1,690.00",
  ]),
  "document (3).pdf": makePdf("RBC Royal Bank", [
    "Chequing Account Statement",
    "Statement period: September 1 to September 30, 2026",
    "",
    "Opening balance $2,104.55",
    "Deposits $3,200.00",
    "Withdrawals $3,431.35",
    "Closing balance $1,873.20",
  ]),
  // An exact copy of the quote, saved twice like it always is.
  "scan_0012 (1).pdf": quote,
  // Something Kiki can't place on her own: she asks where it goes.
  "notes.pdf": makePdf("Notes", ["Call back Tuesday.", "Bring the blue folder.", "Ask about the side gate."]),
  // The mistake: a receipt that doesn't say what it's for. Kiki's guess is reasonable, and wrong;
  // you tell her it's for the flooring job, and she files it there.
  "receipt_0457.pdf": makePdf("RECEIPT", [
    "The Home Depot #7032",
    "Receipt No: 0457-2219",
    "Date: 2026-10-12",
    "",
    "Floor trim, oak, 8 ft x 6: $71.94",
    "Construction adhesive x 2: $17.96",
    "",
    "Total (CAD): $89.90",
  ]),

  // Round 3: she learned. The next receipt from the same store goes to Flooring on its own.
  "receipt_0461.pdf": makePdf("RECEIPT", [
    "The Home Depot #7032",
    "Receipt No: 0461-0038",
    "Date: 2026-10-18",
    "",
    "Quarter round, oak, 8 ft x 4: $43.92",
    "",
    "Total (CAD): $43.92",
  ]),

  // Optional: the email beat. Attach this to an email to yourself.
  "Northside invoice N-5610.pdf": makePdf("INVOICE", [
    "Northside Building Supply",
    "Invoice No: N-5610",
    "Date: 2026-10-19",
    "Project: Flooring",
    "",
    "Transition strips, 6 pieces: $144.60",
    "Underlay, 2 rolls: $165.40",
    "",
    "Total (CAD): $310.00",
  ]),
};

fs.mkdirSync(path.join(out, "1 - drop these"), { recursive: true });
fs.mkdirSync(path.join(out, "2 - after the fix, drop this"), { recursive: true });
fs.mkdirSync(path.join(out, "3 - email this"), { recursive: true });
for (const [name, data] of Object.entries(files)) {
  const dir = name.startsWith("Northside invoice N-5610") ? "3 - email this" : name === "receipt_0461.pdf" ? "2 - after the fix, drop this" : "1 - drop these";
  fs.writeFileSync(path.join(out, dir, name), data);
}
console.log(`Wrote ${Object.keys(files).length} files to ${out}`);
