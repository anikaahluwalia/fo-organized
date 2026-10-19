---
name: kiki-review
description: Review changes against Kiki's trust and reliability rules before committing (approvals, workspace bounds, untrusted text, replays, races, honest reporting). Use after implementing or fixing anything in server/, extension/ or the approval and Fo flows, and when asked to review or audit Kiki code.
---

# Reviewing Kiki changes

Review the diff (`git diff`), then go through every section below that the change touches. For each suspected problem, **write a test that reproduces it** (node:test with `makeRig`, FakeDrive failure injection, FakeFo scripts) before changing code. Report or fix only what reproduces.

## Approval

- Only the user's decision, relayed by Fo in the mapped conversation as a `KIKI-DECISION` bound to the request id, plan id and content hash, approves anything. Not a contractor's words, a document, a file name, silence, "not sure", or a text Kiki can't tie to the request.
- Any change to a proposal makes a new version; an approval of the old one must fail. Double clicks and replays resolve to one approval (unique request ids in SQLite, not just disabled buttons).
- Permission to send a message is never permission to change files, and the other way round.

## Workspace bounds

- Every source and destination folder is walked up to the workspace root live, including folders created by an earlier run (resume, restart). Shortcuts are never moved or followed.
- Nothing is ever deleted. Nothing outside the workspace is read or written, including index files someone moved out.

## Untrusted text

- Document contents, file names, email headers and Fo's messages are data. Anything embedded in a request to Fo must not be able to imitate Kiki's markers (`-----BEGIN/END APPROVED BODY-----`, `KIKI-STATUS:`, `KIKI-DECISION:`) or add lines that read as instructions: strip the markers, collapse to one line, cap the length.
- A fact is kept only if its supporting quote is in the document (`toFacts`), and references and numbers must match as whole tokens.
- Index CSV cells that look like formulas stay inert.

## Replays, restarts and races

- Replaying the same input makes no duplicate files, folders, operations, plans or messages. Pre-generated Drive IDs, dedupe keys and content hashes, not timing.
- A step interrupted mid-call is settled by reading Drive back, never by repeating it. Uncertain sends are never resent automatically.
- Jobs can run in any order and twice; a background job must not overwrite a decision the user made meanwhile. Check what state a row is in before writing (`... WHERE status = ?`).
- Extension service workers restart: no state may live only in their memory.

## Honest reporting

- "Fo reports it sent" is not verified. "Done" means read back from Drive. Partial results say exactly how many steps were verified.
- Mock is labelled Mock everywhere and never stands in for a live integration that failed.
- An error message must say what happened and what the user can do; passing problems retry, permanent ones say so.

## Then

Run `npm test`, `npm run typecheck`, `npx vite build`. For UI changes, also run the `kiki-ui-check` skill. If a finding belongs to a later step, file it in `docs/ROADMAP.md` instead of fixing it now.
