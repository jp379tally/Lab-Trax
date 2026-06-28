---
name: pnpm 10 build-script approvals
description: How pnpm 10 stores build-script approval state and what the CI warning means
---

## Rule
In pnpm 10, `pnpm approve-builds` writes approved package names into `onlyBuiltDependencies` in `pnpm-workspace.yaml` (or `package.json` → `pnpm.onlyBuiltDependencies`). There is no separate `.pnpmfile.cjs` or approval-metadata file generated.

"Ignored build scripts: <pkg>" is a **warning** printed during `pnpm install` with **exit code 0**. It does not fail `pnpm install --frozen-lockfile` and cannot be the root cause of a CI job failure.

`ignoredBuilts:` in `node_modules/.modules.yaml` is pnpm's own internal generated state — not user config.

**Why:** Misattributing this warning as a CI error leads to chasing non-problems (renaming config keys, generating phantom approval files). The real CI failure mechanism is whatever script the job runs after install (e.g. `check-expo-deps` exits 1 on actionable drift).

**How to apply:** When someone reports a "build approvals" CI error, first confirm the actual exit-1 step. If `pnpm install` itself is the failing step, look at lockfile/frozen-lockfile issues — not approval warnings.
