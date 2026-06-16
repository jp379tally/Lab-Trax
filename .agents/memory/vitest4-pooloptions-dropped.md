---
name: Vitest 4 silently drops poolOptions parallelism cap
description: Why the api-server protected regression gate went flaky after the Vitest 4 upgrade — the fork cap stopped applying.
---

# Vitest 4 removed `test.poolOptions` — parallelism cap must be top-level

Vitest 4 removed `test.poolOptions`. A config that still nests
`poolOptions: { forks: { maxForks: N } }` is **silently ignored** (only a
`DEPRECATED` line in the run header signals it), so the suite runs with
**uncapped** worker parallelism.

**Why it matters:** the api-server suite is a protected regression gate whose
~57 integration files each import the full app graph and open a pg pool
(default max 10). Uncapped, that oversubscribes CPU and opens too many DB
connections, so DB `beforeAll` hooks intermittently blow `hookTimeout` and
files "fail" with **zero assertion failures** (they pass in isolation). Looks
like a code bug; it's a config-that-no-longer-applies bug.

**How to apply:** in Vitest 4 set the cap top-level — `pool: "forks"`,
`maxWorkers: 4`, `minWorkers: 1` (plus `hookTimeout`). Verify the fix by
confirming the `DEPRECATED  test.poolOptions ...` header line is gone, not just
that a run happened to pass (it can pass by luck while uncapped). Don't loosen
assertion-level timeouts to paper over this — the real lever is worker count.
The dev DB here is generous (max_connections 112), so 4 forks × ~10 conns is
comfortable; the binding constraint was CPU/event-loop contention, not the raw
connection ceiling.
