---
name: Metro stale cache after bulk route deletions
description: Expo iOS bundle ENOENTs on deleted files even when typecheck and web bundle pass; fix is a dev-server restart
---

After bulk-deleting Expo Router screens/routes while the expo dev server is running,
Metro's dependency graph can hold stale references to the deleted files. Symptom:
the iOS bundle fails with `ENOENT: no such file or directory, open '.../<deleted>.tsx'`
while the **web bundle still succeeds** and `tsc` typecheck passes.

**Why it happens:** typecheck and the web graph don't include the stale entries, but
Metro's cached native graph still tries to `readFileSync` the removed modules. A real
dangling import would instead fail typecheck — so a green typecheck + failing iOS
ENOENT on a *deleted* path points at cache staleness, not a code reference.

**How to apply:**
- First confirm it's cache, not a real ref: `rg` the app/lib/components tree for the
  deleted route names; if nothing references them and the files are truly gone, it's
  the cache.
- Restart the expo workflow (`restart_workflow "artifacts/labtrax: expo"`). The fresh
  start rebuilds the graph; both `Web Bundled` and `iOS Bundled` should report success.
