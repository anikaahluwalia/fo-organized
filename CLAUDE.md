# Kiki (repository: fo-organized)

Kiki keeps a Google Drive workspace organized; Fo (Wajo's assistant) is who the user talks to. Kiki proposes, Fo brings the decision to the user, Kiki applies only what was approved and verifies it in Drive. What it does and how to run it: `README.md`. The goal, the architecture and the current step: `docs/ROADMAP.md`.

## How to work here

- Work one roadmap step at a time with the process in `.claude/skills/kiki-step/SKILL.md`: acceptance check first, settle the findings filed under the step, report, and stop before the next step.
- Measure model behavior with evaluation sets (`kiki-eval`), review changes against Kiki's trust rules (`kiki-review`), look at UI in a real browser (`kiki-ui-check`) and follow `kiki-design` for anything the user sees.

## Commands

- `npm test`, `npm run typecheck`, `npx vite build`
- `npm start` (live app, port 8787), `npm run start:mock`
- `node --env-file=.env scripts/eval-reading.ts [--live]` (Step 1 evaluation)
- `node scripts/ui/mock-kiki.mjs <port> [--demo|--organized]`, `scripts/ui/shot.mjs`, `scripts/ui/extension.mjs`

## Conventions

- Node 24 with native TypeScript (imports end in `.ts`, erasable syntax only), `node:sqlite`, React 19 with Vite, zod. The server has no build step.
- Match the surrounding code: naming, comment density, plain user-facing text.
- Commit and push each working milestone to `main` (github.com/anikaahluwalia/fo-organized). No AI attribution lines in commits or pull requests.

## Safety

- Never change real business documents or send a message to anyone during development without the user's explicit OK. Use the dedicated test folder, mock mode or FakeDrive.
- Port 8787 is the user's live app: read-only screenshots at most. Mock instances go on other ports.
- Tokens and API keys stay server-side (`.env`, `.data/`): never in prompts, logs, the browser bundle or the repository.
