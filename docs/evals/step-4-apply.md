# Step 4: Apply and verify

**Accepted when** only the approved version runs; Drive is read back; partial failures stay visible and resumable; replays and restarts make no duplicates; undo works where nothing changed since.

## What changed

- **The index file.** Kiki writes an index only where she wrote it before:
  - never to an index file that left its folder, for example one you moved out of the workspace;
  - only over her own last write, recognized by the version she recorded or by a checksum of the bytes she sent, saved before sending;
  - if another plan created the project's index meanwhile, she updates that one instead of making a second.
- **Undo.** Undo puts back every file that didn't change, and leaves alone the one you changed. Undoing a plan that filed into two projects rewrites both indexes. Earlier changes stay listed with their own Undo after later filings.
- **Partial runs.**
  - Moves a partly applied plan didn't finish belong to its Try again: they aren't proposed again, or texted as if they'd just landed.
  - Try again explains an open proposal instead of crashing.
  - A step Drive refused shows as failed, not "checking".
  - A "done" text can follow a "stopped" one.
- **Refreshing.** "Refresh the plan" proposes the same kind of plan again: the same undo, or the same quote update. A stale quote update keeps its files until then.
- **Your own folders.** A folder of your own named "Renovations" is yours: no index, project or type folder from Kiki goes in it.
- **Counts.** Counts and summaries leave out skipped steps.

## Findings settled

All Step 4 findings and the acceptance gaps were reproduced first (`test/repro/S4*.test.ts`, now part of the suite). One test depended on an implementation detail: Kiki used to create the index and then write it a second time. It now injects its passing error on the read-back instead, and still checks that a retry never overwrites an index you edited in between.
