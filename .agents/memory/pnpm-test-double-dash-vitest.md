---
name: pnpm run test -- passes literal -- to vitest
description: Why `pnpm run test -- <files>` runs the whole vitest suite instead of the listed files
---

`pnpm --filter <pkg> run test -- --reporter=verbose fileA.test.ts fileB.test.ts` does NOT filter to those files. pnpm forwards the literal `--` to the script, and vitest treats everything after `--` as ignored/positional-terminated, so it runs the ENTIRE suite.

**Why:** The `rel-backup-restore` protected gate used this form and silently ran all 113 api-server test files — slow, flaky (shared-DB contention → false "Case count mismatch"), and a real backup-restore regression could be masked by unrelated noise.

**How to apply:** To run specific vitest files from a pnpm workspace, use `cd artifacts/<pkg> && npx vitest run <files>` (or `pnpm --filter <pkg> exec vitest run <files>`). Never add `--` between `run test` and the file list. If a "single-file" gate is unexpectedly slow or shows unrelated failures, check whether its command has this bug.
