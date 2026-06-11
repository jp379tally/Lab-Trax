---
name: Vitest mock completeness causes cross-file flakes
description: Adding a new export to a vi.mock factory can expose timing gaps in unrelated test files that previously errored out early.
---

## The Rule

When you add a new hook/export to a `vi.mock("@workspace/api-client-react", ...)` factory, some previously-failing tests will now run to completion for the first time. This changes the micro-task scheduling for tests that run *after* them in the same suite. Any bare `expect(...)` assertion that immediately follows a `waitFor(...)` block can now fail due to a React render not having committed yet.

**Fix:** Wrap every post-`waitFor` assertion that checks newly rendered content in its own `waitFor(() => { expect(...); })`.

## Why

Before the new mock was added, `cases.smoke.test.tsx` tests threw "no export" errors before any React render work completed. After the fix, those tests render fully and flush async work. The tail of that flush bleeds into `scan.smoke.test.tsx` (which runs next in file-system order), leaving the duplicate-prompt modal in a partially committed state when the bare assertion fires.

## How to Apply

- After adding any export to the global `@workspace/api-client-react` vi.mock in `vitest.setup.ts`, run the full suite (not just the file you changed) to surface newly-exposed timing gaps.
- Pattern to fix: `await waitFor(() => { assertA; }); assertB;` → change to `await waitFor(() => { assertA; }); await waitFor(() => { assertB; });`
- Running the affected test *in isolation* (`vitest run path/to/file`) will always pass because there's no prior-test async bleed; the flake only manifests in a full suite run.
