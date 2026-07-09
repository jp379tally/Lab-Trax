---
name: doctors.test.ts full-suite flake
description: Doctor-merge DB-integration tests flake under full api-server suite contention but pass in isolation.
---

# doctors.test.ts flakes under full-suite DB contention

The doctor-merge DB-integration tests in `src/routes/doctors.test.ts` intermittently
fail when the full api-server suite runs (rel-api-tests or mark_task_complete
validation), with varying symptoms across runs:

- 30s timeout on "undo within window restores; tampered state refuses"
- 500-instead-of-200 on "dedupes redundant capitalization variants"
- casesMoved off-by-one (expected 3, got 4) on "merges multi-source: cases + pricing overrides"

**Why:** shared dev DB + full-suite parallelism; the merge tests do heavy multi-row
setup and are sensitive to concurrent load / residual rows. Symptoms differ per run —
same root cause.

**How to apply:** verify by running the file in isolation with the with-db-lock
wrapper via the validation runner (exceeds 120s bash cap):
`pnpm --filter @workspace/scripts run with-db-lock 'pnpm --filter @workspace/api-server exec vitest run src/routes/doctors.test.ts'`
If the isolated run passes, treat the full-suite failure as flake, not a regression —
especially when the change under review touched no server code.
