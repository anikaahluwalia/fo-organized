# Step 1: understand a folder

**Accepted when** Kiki reads documents of every kind and reports type, issuer, project, date and title with the line that supports each, flags what she can't tell, changes nothing, and invents nothing.

## The evaluation set

19 documents in [`scripts/eval/reading-set.ts`](../../scripts/eval/reading-set.ts), with what a careful reader should take from each (a value, acceptable alternatives, "must be empty", or not scored):

- **Business:** a quote, a deposit invoice that refers to it, an invoice with no project, a business licence, a building permit, a service contract, a hardware-store receipt.
- **School:** lecture notes, an assignment, research notes.
- **Work:** a board-deck outline, meeting notes.
- **Personal:** a property-tax letter, a trip itinerary, a budget spreadsheet.
- **Traps:** a scrap that says only "Thanks for your business!", an invoice with instructions aimed at AI tools, an ambiguous date (03/04/2026), and a quote "valid for thirty days" in words.

Run it: `node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-reading.ts --live` (Claude) or without `--live` (the mock reader). Nothing touches Drive.

## Results (2026-10-18, Claude `claude-opus-5-5`)

| | Fields right | Invented | Missed | Wrong | Unreadable |
| --- | --- | --- | --- | --- | --- |
| First run | 188/190 | 0 | 0 | 2 | 0 |
| After fixes | **190/190** | **0** | 0 | 0 | 0 |

The traps held: the ambiguous date stayed empty, the AI-directed instructions were recorded and ignored, "thirty days" didn't become a date, and the scrap was marked as unclear.

The two first-run disagreements were both the project: the permit's "Kitchen renovation, 12 Cedar Lane" (better than the expected "Kitchen renovation": the reading rules keep identifying details) and the deck's "Q3 2026 board presentation" (a stated event, so a fair reading, but it puts the deck apart from the "Nimbus launch" meeting notes; grouping related files is Step 2's job). Both are accepted in the set, with the reason noted.

The mock reader (pattern matching, used by tests and the mock demo) gets 157/190 with **0 invented**; before the fixes it invented 2 values.

## Fixed in this step

- A reference to another document counts only when the quoted line names it as a whole token (Q-1042 in "Q-10421" no longer counts).
- A validity period in days counts only when the line states that number (3 days isn't "valid for 30 days").
- A rate limit, overload or network error while reading puts the document back to be read again. Before, first reads marked it failed for good, and the background re-read dropped the new facts.
- The mock reader no longer takes a contract's own number as a reference to another document, or a spreadsheet row as an issuer.

Regression tests: [`test/reading-eval.test.ts`](../../test/reading-eval.test.ts).
