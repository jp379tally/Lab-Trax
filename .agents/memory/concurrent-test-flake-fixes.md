---
name: Concurrent test workflow flake fixes
description: Root causes and fixes for DB contention + OOM flakes when api-server-tests and regression-tests fire simultaneously at merge time.
---

## Rule

When two api-server test workflows fire concurrently (api-server-tests + regression-tests), all of the following must hold or the suite flakes:

1. **`maxWorkers: 2` in api-server vitest.config.ts** — caps forks per workflow so 2×2=4 total workers.
2. **`DB_POOL_MAX: "5"` in vitest env** — each fork's pg pool capped at 5; 4×5=20 total connections, within DB max_connections.
3. **`hookTimeout: 90000` globally** — beforeAll hooks wait up to 90s for pool contention to clear.
4. **Per-file `vi.setConfig({ hookTimeout })` must be ≥ 90000** — files that call `vi.setConfig` override the global; two-factor.test.ts and account-epic-verification.test.ts both had `hookTimeout: 30000` which broke beforeAll under load.
5. **Wall-clock timing assertions** — `cases-patient-similarity.test.ts` asserted `< 3000 ms`; raised to 10 s because the query is fast in isolation but slow under concurrent pool pressure.

## Desktop test OOM (separate issue)

Desktop jsdom workers are ~150–200 MB each. Without `maxWorkers: 2` in the desktop vitest.config, all 24 test files fork simultaneously when desktop-full-test runs alongside the api-server workflows — container OOM → "Timeout waiting for worker to respond".

Fix: add `pool: "forks", maxWorkers: 2, minWorkers: 1` to `artifacts/labtrax-desktop/vitest.config.ts`.

## DB pool cap env var

`lib/db/src/index.ts` now reads `DB_POOL_MAX` env var to set `pg Pool { max }`. Production leaves it unset (default 10). Test configs set it to 5.

**Why:** pg doesn't expose a built-in env var for max pool size; the only way to cap it per-test-run is an application-level env var read at pool construction time.

**How to apply:** if you see `connection terminated unexpectedly` or `hookTimeout` failures in concurrent api-server runs, verify DB_POOL_MAX=5 is in vitest env and all per-file `vi.setConfig` hookTimeout values are ≥ 90000.
