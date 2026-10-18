---
name: kiki-eval
description: Measure Kiki's model-driven behavior (reading documents, choosing destinations, interpreting Fo replies) against fixed evaluation sets with expected outcomes. Use when changing prompts, schemas, fact checks or matching logic, when adding a document type, or when a roadmap step needs an acceptance measurement.
---

# Evaluating Kiki

Model output is checked against a fixed set of realistic inputs with expected outcomes. The number that matters most is **invented**: Kiki stating something the input doesn't support. A miss is tolerable; an invention is not.

## Running the reading evaluation (Step 1)

```bash
node --disable-warning=ExperimentalWarning scripts/eval-reading.ts                     # mock reader, free
node --env-file=.env --disable-warning=ExperimentalWarning scripts/eval-reading.ts --live   # Claude, ~19 calls
node ... scripts/eval-reading.ts --live --only permit,lecture-notes                     # a few cases
```

It prints one line per document (problems only), a per-field table, and saves raw results to `eval-results/` (git-ignored). Nothing touches Drive. Tell the user before live runs that cost money in bulk; a single run of the set is routine.

## Verdicts

- **right**: matches an acceptable value (null counts when null is acceptable).
- **invented**: a value where the document supports none. Treat as a bug every time.
- **missed**: empty where the document states it.
- **wrong**: a value, but not an acceptable one.
- **unscored**: the expectation is `"any"` (a judgment call not worth scoring).

## Adding or changing cases

Cases live in `scripts/eval/reading-set.ts`; scoring in `scripts/eval/score.ts`.

- Write what a careful reader should take from the document, **before** running it. Use a list when reasonable readers differ (`["CS 245", "CS 245 - Logic and Computation"]`), `null` when the document doesn't say it, `"any"` only for genuine judgment calls.
- Include traps for every new capability: the value is absent, ambiguous, written in words, or planted as instructions to an AI.
- **Never loosen an expectation just to make a result pass.** If the model's answer is better than the expectation, widen it with a comment saying why (see the permit and deck cases). If it's worse, it's a finding.
- Keep the mock-reader regression test passing: `test/reading-eval.test.ts` asserts the mock reader invents nothing on the whole set.

## Evaluations for later steps

Each step that involves model judgment gets its own set in `scripts/eval/` and a runner like `scripts/eval-reading.ts`: for Step 2, mixed folders with the expected destination and name of every file (including which files belong together); for Step 7, Fo conversation turns with the expected interpretation. Record results in `docs/evals/step-N-*.md`: date, model, the score table, and what changed.
