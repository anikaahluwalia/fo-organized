# Step 2: propose an organization

**Accepted when**, for mixed folders, Kiki proposes exact names and destinations with reasons, groups related files into the same collection, reuses the user's existing folders, and never proposes touching anything outside the workspace. Measured on a set of folders with expected destinations.

## The evaluation set

7 workspaces, 33 files, in [`scripts/eval/organize-set.ts`](../../scripts/eval/organize-set.ts). Each file says where it should end up after the proposal is approved and applied (a folder, sometimes an exact name), or that it must stay exactly as it is. Each workspace also lists files that must end up in the same collection, or must not.

- **renovation:** four flooring documents with unhelpful names, and a business licence that belongs to no project.
- **student:** two lectures of one course spelled differently ("CS 245 - Logic and Computation", "CS245"), an assignment for another course, and research notes that name no course.
- **existing-folders:** the user already keeps `School/CS 245`, `School/MATH 135` and `Taxes`. New files go into them; what's there stays.
- **work:** a launch's deck, meeting notes and contract, each naming the project differently, and another project's standup notes.
- **personal:** a trip itinerary and its hotel booking, and a receipt and a budget sheet that belong to nothing in particular.
- **catch-all:** files in `Old scans` and `Downloads` are still waiting to be filed; files in `Archive` and `School` stay.
- **already-organized:** filed documents stay; an exact copy is set aside; a shortcut, an unreadable file and two empty files are left alone.

The runner, [`scripts/eval-organize.ts`](../../scripts/eval-organize.ts), runs Kiki's real pipeline in a fake Drive: it reads every file, proposes, approves, applies, then checks where each file actually is. A file outside the workspace sits next to each one; if it moves, the run fails. Verdicts per file: right, not filed, wrong place, wrong name, moved unnecessarily, renamed unnecessarily.

Run it: `node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-organize.ts --live` (Claude reads, about 35 calls) or without `--live` (the mock reader). Nothing touches the real Drive.

## Results (2026-10-18, Claude `claude-opus-5-5`)

| | Files right | Groups right | Unnecessary changes | Wrong place | Not filed |
| --- | --- | --- | --- | --- | --- |
| Before this step (first 6 workspaces) | 17/29 | 5/8 | 5 | 7 | 0 |
| After | **33/33** | **9/9** | **0** | 0 | 0 |

The file outside the workspace never moved. The catch-all workspace was added during the step to measure the "already filed" rule.

What was wrong before:

- **One project became several folders.** Claude read the same project as "Flooring" and "Flooring - main floor, 12 Cedar Lane"; Kiki filed each spelling into its own folder and moved documents already filed into the longer one. The same happened to "CS245" and "CS 245 - Logic and Computation".
- **The user's folders were ignored.** A new CS 245 lecture went to `Projects/CS 245 - Logic and Computation` instead of `School/CS 245`, and the tax letter to `Projects/12 Cedar Lane` instead of `Taxes`. The files already in those folders were moved out.
- **Related files were split.** The launch's deck went to its own "Q3 2026 board presentation" collection, away from the launch's notes and contract.
- **Two empty files were treated as copies** (they share Drive's checksum), and one was set aside.

## What Kiki does now

- **Collections are decided across the whole workspace**, not one document at a time ([`server/domain/collections.ts`](../../server/domain/collections.ts)):
  - The same project spelled differently is one collection, compared by its words ("CS245" is "CS 245", "Nimbus launch website" is "Nimbus launch").
  - A collection Kiki already made keeps its name.
  - A document alone in its collection joins a bigger one when its title names it (the deck titled "Nimbus - Investor update" joins Nimbus launch).
  - A supplier's invoice, quote or receipt with no project goes where that supplier's other documents are, if that's one place.
- **The user's folders come first.** A folder is used when all its identifying words are in the document's project, title or issuer (`School/CS 245`, `Taxes`). Only otherwise does Kiki propose `Projects/<collection>/<type>`.
- **Filed means filed.** Anything in Kiki's folders, or in a folder the user made (`School`, `Taxes`, `Archive`), stays where it is under its name. Only loose files are filed: those at the top of the workspace or in catch-all folders (`Old scans`, `Downloads`, `New folder`).
- **Every move cites what it rests on**, for example:
  - `Into your "School/CS 245" folder: it says "CS 245 - Logic and Computation".`
  - `Goes with Nimbus launch: its title is "Nimbus - Investor update".`
  - `No project on it, but Oakline Flooring Co.'s other 2 documents are in Flooring.`

  A document Kiki can't place says so and stays where it is.
- **Names:**
  - A long title is cut at a clause break ("2026 Property Assessment - 12 Cedar Lane"), and a reference cut from it is put back.
  - A project named with ":" or "/" gets a folder-safe name ("CS 245: Logic" becomes "CS 245 - Logic") instead of losing its project.
  - A project name that climbs out of a folder ("../../outside") is still refused.
- **Each collection's index lists every document filed into it**, however the document spelled the project.

The mock reader, used by tests and the mock demo, gets 21/33 right with 0 unnecessary changes. It only understands labelled lines like "Project:", so most free-text workspaces stay unfiled, which is the safe way to fail.

## Findings settled in this step

Each was reproduced with a test before it was fixed ([`test/step2-findings.test.ts`](../../test/step2-findings.test.ts)):

1. A name the user chose was proposed back after it was applied. Fixed: filed documents keep their names.
2. Edits to an open proposal were dropped when a version update took a different file out of it. Fixed: edits are kept per file and carried into the new version.
3. "Don't redo what the user undid" never matched. Fixed: what the user undid is left out file by file until that file changes. This includes copies that were set aside.
4. Choosing which exact copy to keep could set aside the copy the user accepted. Fixed: the accepted (or current) copy is the one kept.
5. A checksum match alone decided an exact copy. Reproduced for empty files, which all share one checksum; they're no longer copies of each other. For files with content, the same checksum means the same bytes, so that part is dismissed.
6. A plan with no copies could be titled "Set aside duplicate copies". Fixed: titles say what the plan does, for example `Organize "Semester files"` or "Update the index".
7. Related files landed in different collections. Fixed by the grouping above (the work workspace keeps the deck, notes and contract together).

Found and fixed during the step:

- A collection's index missed documents whose text spelled the project differently. For example, a lecture filed into CS 245 but recorded as "CS245" was left out. Filing now makes the collection the document's project. A new document whose project is another spelling of a collection Kiki keeps joins that collection when it's read.
- A project named with ":" or "/" was dropped while reading.
- A long title was cut mid-phrase ("Roll No.…"), and the reference in it was lost.

## Limits

- A document Kiki can't place only gets a note. Fo asking where it goes is filed under Step 3.
- A user's folder is matched by words. A folder named after an issuer (say, "Riverton") would also take other documents from that issuer.
- A file in a folder the user made stays even when Kiki could tell where it belongs. That's deliberate: the cost is a missed filing, never an unwanted move.

Regression tests: [`test/step2-findings.test.ts`](../../test/step2-findings.test.ts), [`test/collections.test.ts`](../../test/collections.test.ts).
