---
name: kiki-design
description: Kiki's look, voice and UI rules for the web app and the Chrome side panel (character states, layout order, copy, honest labels). Use when adding or changing anything the user sees, including messages Kiki or Fo show or send.
---

# Designing for Kiki

The character, her states and her motion are specified in `docs/KIKI-DESIGN.md`; the UI order and labels come from `docs/FO-RGANIZED-BRIEF.md`. Read the relevant part before changing UI. For visual decisions, follow the `frontend-design` skill's process (plan, check the plan against the brief, build, critique with screenshots) with those two documents and this file as the brief: the brief always wins over generic aesthetic advice. Its list of "AI-generated tells" (all-caps eyebrow labels, middle-dot meta strings, the same card everywhere) applies to Kiki too. Tokens and components live in `web/src/styles.css` (side panel: `extension/panel.css`): reuse them rather than adding new colors or one-off styles.

## Voice

- Plain, specific, short. Say what happened and what the user can do: "Kiki moved 9 files and checked each one in Drive", not "Successfully completed the operation."
- No filler, hype or AI clichés ("seamlessly", "effortlessly", "I've gone ahead and", "Great news!"). No emoji in UI text.
- Kiki is she; Fo is Fo. Kiki prepares and checks; Fo talks to people. Never say Kiki sent a message, or that Fo changed files.
- No technical identifiers in normal UI (IDs, hashes, job names, JSON). Put them in expandable evidence only when they help.

## Honesty in labels

- Distinguish **Proposed**, **Approved**, **Applied and verified**, **Waiting**, **Needs review**, **Failed or uncertain**. Never show "done" for something that isn't read back from Drive.
- "Fo reports it sent the email" is a report, not a fact. Label sources: the contractor's quoted words, Fo's summary, a reply the user pasted.
- **Live**, **Mock** and **Staged demo file** labels are visible wherever they apply. Mock never stands in for a failed live call.
- Marking a quote current is not accepting its price; keep those visually and verbally separate.

## Layout

- Order (main column): the workspace, a plan waiting for the user, Needs a look, files, finished plans (collapsed), the index, activity. Kiki and the decisions sit in the side column on desktop and come first and last on a phone.
- Works at 390px wide with no horizontal scroll; long file names and paths wrap.
- Kiki's expression follows persisted state only, never a timer; respect reduced motion.
- Every control has a label; status changes are announced (`aria-live`); focus is visible.

## Check it

Look at the result with the `kiki-ui-check` skill (desktop and phone screenshots, and the side panel when it changed) before calling UI work done.
