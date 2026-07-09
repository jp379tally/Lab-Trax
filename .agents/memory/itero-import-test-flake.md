---
name: iTero import "no-AI stub path" test flake
description: Why cases-ai-reader itero-import tests must force the OpenAI key off, not rely on it being unset
---

# iTero-import "no-AI stub path" tests must force AI off

`cases-ai-reader.test.ts` itero-import tests document themselves as the
"no-AI stub path" (case created with `needsAiReview:true` regardless of AI).
They were written assuming `AI_INTEGRATIONS_OPENAI_API_KEY` is unset.

**Reality:** that key IS set in Replit dev/CI/validation envs. So the route
(`POST /api/cases/import-from-itero-rx`) made a *live* AI call against the
fake test PDF. The AI block is try/caught, so a failed call → 201 (looked
fine locally). But when the live call *succeeds* it returns non-deterministic
junk that occasionally breaks a downstream step → 500. Result: tests passed in
most runs, intermittently failed `expected 500 to be 201` in validation.

**Fix:** the test fork deletes `AI_INTEGRATIONS_OPENAI_API_KEY` in `beforeAll`
(before importing `app.js`, so the module-level `cachedIteroOpenAIClient`
caches null) and restores it in `afterAll`. This makes the documented stub
path run deterministically.

**Why:** a test that depends on an env secret being *absent* is silently
coupled to deployment env; "passes locally" does not prove it's stable.

**How to apply:** any test asserting a "graceful / AI-unconfigured / fallback"
path must force the relevant integration off itself, not assume the env lacks
the key. Don't loosen the status assertion to absorb the 500.

## Real root cause: iTero case-number generation race

The deeper reason `POST /api/cases/import-from-itero-rx` intermittently 500'd
(passes locally, fails under parallel forks / in validation) is NOT the AI
path — it's `generateIteroCaseNumber`, which computes `max(case_number) + 1`
against the **globally-unique** `case_number` column. Two concurrent imports
(poller fan-out in prod, or parallel vitest forks sharing one DB) read the same
max and one INSERT dies with a duplicate-key 23505 → 500.

**Fix:** the import transaction is wrapped in a retry loop that regenerates the
case number on a `case_number` unique violation (`isCaseNumberUniqueViolation`,
bounded attempts). This is the production-correct fix, not just a test fix.

**How to apply:** any "next number = max+1" generator against a unique column is
a read-then-write race. Either serialize via a sequence/atomic counter or
retry-on-23505. The same pattern exists at the other `generateIteroCaseNumber`
call sites (ZIP batch importer, etc.) — harden them if they start flaking.

## Related: full-suite concurrency flakes (different iTero test each run)

Under the full `rel-api-tests` run (all forks in parallel) a *different*
iTero test can fail each run while every one passes in isolation. Observed:
- `cases-ai-reader.test.ts` "mirrors Rx PDF to object storage" —
  `writeCaseMediaToObjectStorage` called 2× instead of 1× (mock call-count
  bleed under concurrency).
- `cases-material-normalization-e2e.test.ts` zip-batch import — returns
  `status:"error"` instead of `"created"` (likely the max+1 case-number race
  at the ZIP-batch call site, which is NOT yet hardened with the retry loop).

**How to apply:** if the full gate fails on exactly one iTero test, rerun the
file in isolation first; a green isolated run means the concurrency flake, not
your change. Rerun the gate rather than loosening assertions.

## Related: shared-dev-DB unique-constraint flakes

`cases-similarity.test.ts` had the same class of "passes locally, fails in
validation" problem for a different reason: it inserted hardcoded
`caseNumber: "A-1"` / `"B-1"` into the `cases` table, which has a *global*
`cases_case_number_unique` constraint. Any interrupted run leaves those rows
behind, and the next run collides on insert. **Rule:** api-server integration
tests run against a *shared* dev DB — never insert hardcoded values into a
globally-unique column; derive them from the per-run `rid()` id so leftover
rows can't collide.
