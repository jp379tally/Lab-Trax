---
name: pnpm/action-setup@v4 version input vs packageManager precedence
description: How the version input and packageManager field interact in pnpm/action-setup@v4
---

## Rule
`pnpm/action-setup@v4` with an **explicit `version:` input** (including `version: latest`) ignores the `packageManager` field in `package.json`. An explicit `version` always wins.

To pin via `packageManager` (single source of truth), you must **both**:
1. Add `"packageManager": "pnpm@X.Y.Z"` to `package.json`
2. **Remove** the `version:` line from every `pnpm/action-setup@v4` step in all workflow files

If `version: latest` stays in the workflow, `packageManager` has no effect on CI.

**Why:** This caused a reproducibility gap — Replit ran pnpm 10.26.1 while CI floated on `latest`, making build-approval behavior potentially differ between environments. Fix = pin `version: 10.26.1` directly in each `pnpm/action-setup@v4` step (simpler than the packageManager approach since it doesn't require removing lines).

**How to apply:** When checking if CI and local pnpm versions match, grep all workflow files for `pnpm/action-setup` and confirm the `version:` value is an exact semver, not `latest`.
