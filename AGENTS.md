# Agent instructions

Read `CLAUDE.md` first: the same instructions apply to every coding agent in this repository.

The workflows are written as skills in `.claude/skills/<name>/SKILL.md`. Read the relevant one before working:

- `kiki-step`: how work is planned and finished, one roadmap step at a time (start here).
- `kiki-eval`: evaluation sets for model-driven behavior; "invented" facts are bugs.
- `kiki-review`: the trust and reliability checklist to review changes against.
- `kiki-ui-check`: checking the web app and the Chrome side panel in a real browser.
- `kiki-design`: Kiki's voice, honest labels and layout.

The short version: one step at a time from `docs/ROADMAP.md`; acceptance check first; never change real documents or send messages without the user's OK; port 8787 is the user's live app; commit and push working milestones to `main` without AI attribution lines.
