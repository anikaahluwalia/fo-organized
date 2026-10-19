---
name: kiki-design
description: Kiki's look, voice and UI rules for the web app and the Chrome side panel (character states, layout order, copy, honest labels). Use when adding or changing anything the user sees, including messages Kiki or Fo show or send.
---

# Designing for Kiki

The character, Kiki's states and motion are specified in `docs/KIKI-DESIGN.md`; the UI order and labels come from `docs/FO-RGANIZED-BRIEF.md`. Read the relevant part before changing UI. For visual decisions, follow the `frontend-design` skill's process (plan, check the plan against the brief, build, critique with screenshots) with those two documents and this file as the brief: the brief always wins over generic aesthetic advice. Its list of "AI-generated tells" (all-caps eyebrow labels, middle-dot meta strings, the same card everywhere) applies to Kiki too. Tokens and components live in `web/src/styles.css` (side panel: `extension/panel.css`): reuse them rather than adding new colors or one-off styles.

## Voice

- Plain, specific, short. Say what happened and what the user can do: "Kiki moved 9 files and checked each one in Drive", not "Successfully completed the operation."
- No filler, hype or AI clichés ("seamlessly", "effortlessly", "I've gone ahead and", "Great news!"). No emoji in UI text.
- Kiki is gender neutral: always "Kiki", never "she" or "her" (nor "it" or "they"); repeat the name or reword. Fo is Fo. Kiki prepares and checks; Fo talks to people. Never say Kiki sent a message, or that Fo changed files.
- No technical identifiers in normal UI (IDs, hashes, job names, JSON). Put them in expandable evidence only when they help.

## Honesty in labels

- Distinguish **Proposed**, **Approved**, **Applied and verified**, **Waiting**, **Needs review**, **Failed or uncertain**. Never show "done" for something that isn't read back from Drive.
- "Fo reports it sent the email" is a report, not a fact. Label sources: the contractor's quoted words, Fo's summary, a reply the user pasted.
- **Live**, **Mock** and **Staged demo file** labels are visible wherever they apply. Mock never stands in for a failed live call.
- Marking a quote current is not accepting its price; keep those visually and verbally separate.

## Layout

- A left sidebar (Kiki in a circle, "kiki" and Kiki's status line, the only live region; Activity, Browse, Settings; the Fo and Drive connection with Live or Mock at the bottom) and one content column up to 1040px. At 760px and below the sidebar is a top bar and the nav a row of tabs.
- Activity: breadcrumb, "Your Drive, organized.", one muted line, the folder control, then tabs With Fo (waiting on you), In progress, Completed. Each item is a card: icon, type and time, a one-sentence headline, one muted sentence, a footer with who it's with and View details. Then Needs a look, Recently completed, and the last-checked line.
- A plan opens as its own page: breadcrumb, the status badge, the plan's title, "Review exactly what Kiki will change.", one row per change (new folders folded into the moves), then Approve N changes and Request a change. Browse holds the folders, their files and project indexes; Settings holds the theme and connections.
- Dark and light themes from the tokens in `web/src/styles.css`, following the system unless you pick one in Settings. Kiki's pink is the only accent; status colours appear only as text or a thin line.
- Works at 390px wide with no horizontal scroll; long file names and paths wrap.
- Kiki's expression follows persisted state only, never a timer; respect reduced motion.
- Every control has a label; status changes are announced (`aria-live`); focus is visible.

## Check it

Look at the result with the `kiki-ui-check` skill (desktop and phone screenshots, and the side panel when it changed) before calling UI work done.
