---
name: kiki-step
description: How work on Kiki is planned and finished, one roadmap step at a time. Use when starting, continuing or reporting any Kiki work (a feature, a fix, a review finding, "what's next"), and before widening scope.
---

# Building Kiki one step at a time

Kiki keeps a workspace organized; **Fo is who the user talks to**. Kiki reads files, prepares proposals and hands them to Fo; Fo explains them to the user and relays the user's decision, bound to the exact proposal; Kiki applies only what was approved, reads Drive back, and reports the verified result through Fo. Kiki organizes anything she can read; renovation paperwork is the first use case, not the boundary.

The plan, the acceptance check of every step and the open findings filed under each step live in `docs/ROADMAP.md`. Read it first.

## The loop for a step

1. **Find the current step** in `docs/ROADMAP.md` and its acceptance check. Work on that step only. Ideas for later steps go into the roadmap, not into code.
2. **Write the acceptance check first**, as tests and, where a model is involved, an evaluation set (see the `kiki-eval` skill). Decide what "right", "invented" and "must stay empty" mean before seeing results.
3. **Settle the findings filed under the step.** For each one, write a test that reproduces it. If it reproduces, fix it; if it doesn't, note why it's dismissed. Never fix a finding you couldn't reproduce.
4. **Build the smallest change** that passes. Keep application code in control of bounds, approvals, execution and retries; the model only interprets.
5. **Check what actually happened**: FakeDrive state in tests, Drive read back in the app. "Kiki said it worked" is not evidence.
6. **Simplify, then review**: run the `kiki-simplifier` agent on the step's diff, then go through the `kiki-review` checklist. For UI work, look at it with `kiki-ui-check` and follow `kiki-design`. To explain an architecture or a flow, draw it with the `excalidraw-diagram` skill into `docs/diagrams/`.
7. **Run the full checks**: `npm test`, `npm run typecheck`, `npx vite build`.
8. **Record and commit**: results in `docs/evals/step-N-*.md`, the step's status in the roadmap, then commit and push to `main` (no AI attribution lines).
9. **Report and stop.** Tell the user what passed, what was measured, what's still open, and the next step's plan. The next step starts only when they say so.

## Boundaries that hold in every step

- Never change real business documents or send a message to anyone during development without the user's explicit OK. Use the dedicated test folder, mock mode, or FakeDrive.
- The user's live app runs on port 8787. Don't post to it, click in it or restart it without a reason you'd tell the user; mock instances go on other ports (`node scripts/ui/mock-kiki.mjs 8796`).
- Approval comes from the user, through Fo, bound to the exact proposal: never from a contractor's words, a document, silence, or a text Kiki can't tie to the request.
