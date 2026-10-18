# Step 3: Fo brings the proposal to you

**Accepted when** Fo explains the exact proposal; your answer inside Kiki (approve, decline, adjust, question) comes back linked to it; anything unbound, stale or ambiguous approves nothing.

## How it works now

1. **Kiki sends Fo the exact proposal.** This happens through "Have Fo ask me" on any proposal, or automatically with "Text me when Kiki finds something new" on. The proposal is numbered like Kiki's own steps, each step has its reason, and files Kiki couldn't place are listed with the places that fit. File names, folder names and document facts are inert: each becomes one line, no line breaks of any kind, and none of Kiki's protocol markers in any spelling ([`server/domain/inert.ts`](../../server/domain/inert.ts)).
2. **Fo's question shows in Kiki, and you answer there.** Your answer goes back on the same Fo conversation, never into a turn Fo is still working on. For now you always answer in Kiki: a text reply starts a separate Fo conversation that can't be tied to the request (Lukas, Wajo).
3. **Fo reports your decision as a bound `KIKI-DECISION`.** It's tied to the request, the plan and its content hash, and it can be approved, declined, changes requested, or clarification. An approval counts only if all of these hold:
   - it's Fo's reply to your latest answer in Kiki;
   - it quotes your words;
   - your words are a plain, unconditional yes.

   "Not sure", "maybe later" and "yes, but…" never approve. Approve in Kiki is always one click away.
4. **Changes you ask for become a new version.** For example, "skip the Bright Floors quote", "the Northside invoice is for the kitchen", or "put the licence in Business". Kiki reads your own words ([`server/domain/adjust.ts`](../../server/domain/adjust.ts)), makes version N+1 and sends it to the same conversation, where it needs its own decision. The version you answered can't be approved any more.
5. **A file Kiki can't place becomes a question.** With nothing else to file, Kiki proposes "Where does … go?". It shows in Needs a look and goes to Fo with texts on. You answer, or type where it goes in the app, and that becomes a proposal. "Leave it" closes the question for good.

## Measured (2026-10-18, Claude `claude-opus-5-5`)

Turning your answer into changes ([`scripts/eval/adjust-set.ts`](../../scripts/eval/adjust-set.ts): 15 answers covering skip, rename, keep names, move, place an unplaced file, step numbers, questions, plain yes and no, "later", and asks Kiki can't do):

| | Changes found | Invented | Kind right | Unsupported asks flagged |
| --- | --- | --- | --- | --- |
| Claude | **19/19** | **0** | 15/15 | 15/15 |
| Mock (rehearsals) | 19/19 | 0 | 15/15 | 15/15 |

Run it: `node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-adjust.ts --live`.

## Findings settled

Every finding filed under Step 3, and about 30 more that automated reviews found, was reproduced with a test first. They're all in `test/repro/S3*.test.ts`, which now runs with the suite:

- marker imitation through names and facts, including Unicode line separators and look-alike markers;
- approvals that slipped through: before any answer, quoting words you didn't say, older than Fo's newest reply, or hedged;
- "Text me a summary" sending nothing, and a failed text showing as still sending;
- the pairing code staying on screen;
- unplaced files that only got a note;
- an expired request being a dead end, and a restart leaving a request stuck;
- raw decision lines shown to you;
- quote updates never brought to Fo.

Where a reproduction test pinned an earlier design (approval by text reply, an old line format, a separate placement protocol), its mechanism was updated and what it protects was kept. The test files say so.

## Texts written for the moment (`scripts/eval-compose.ts`)

Fo's texts are written by Claude from Kiki's facts and checked by Kiki before they go out: every file named (by a short name made only of words from its name or what Kiki read), every folder, each new name (or how many, past two), nothing said done before you've answered, no links, paths, versions or protocol lines, and an answer that fits (a place for a question, never a yes; no text reply invited when only the link works). A text that fails a check goes out in Kiki's own words. Fo still gets the exact proposal alongside, not to be texted.

Live (claude-opus-5-5), 12 situations (one file, a rename, link only, no link, three renames, seven files, a question, a copy, a revised and an unchanged version, done, stopped): 12/12 passed Kiki's checks, longest 150 characters. Before the rename and question rules: 11/12 (three full new names ran past the length limit; a question ended "Reply yes").

## Learning from your answers (`scripts/eval-lessons.ts`)

When you choose where a file goes and that filing is applied and verified, Claude says what kind of document it was ("weekly timesheets", told by "timesheet"); Kiki keeps it only if the words come from the document and tell documents apart (no months, numbers on their own, file types or words like "scan"). A later document Kiki can't otherwise place that has those words is proposed for the same place, "like the weekly timesheets you filed there before"; a document that states its project still goes there. Keeping files' own names on two separate proposals stops renames. Lessons are listed in the app ("What Kiki learned") and can be forgotten; they never approve anything.

Live (claude-opus-5-5), 4 kinds (a timesheet with the person's name in it, a utility bill, a pay stub, course lecture notes): 4/4 descriptions kept, 4/4 recognize the next one and leave an unrelated one alone (the résumé with the same person's name, another company's bill, a receipt, other meeting notes). Kiki's own fallback: 4/4 after it stopped picking a person's surname from a file name.

## Filing a kind of document on her own (`test/standing.test.ts`)

After Kiki has filed a kind of document twice with your yes (you chose the place once, then approved her "like last time" suggestion), she offers once to file new ones there on her own. The offer goes through Fo like a proposal, bound to that lesson as it stood; only a plain yes turns it on (or "File on her own" in the app), and "Ask me first" turns it off. With it on, a proposal is carried out without asking only when every file in it is a new one of such a kind going exactly where those go, with nothing else in it (no copies, questions, edits or renames of filed documents); its approval is recorded as on your standing OK, and Fo texts you after ("I filed … on my own, as you allowed. You can stop that in the Kiki app."). Live text check: 13/13 situations passed Kiki's checks, including that one.
