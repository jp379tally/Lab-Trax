---
name: Expo drift bump vs maturity policy
description: Why "keep mobile in step with Expo" tasks can stall on the 1-day supply-chain maturity policy, and how to handle it.
---

# Expo dependency drift vs. `minimumReleaseAge`

`expo install --check` always points at the **latest** patch Expo 54 expects.
Expo publishes the matching `expo` / `expo-font` / `expo-file-system` /
`expo-router` patches in a single batch (same minute). The workspace's
`minimumReleaseAge: 1440` (1 day) in `pnpm-workspace.yaml` rejects any version
younger than 24h, so the newest expected versions are **unbumpable for ~24h
after publish** — `pnpm install` fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`
and falls back to the installed (mature) versions.

**Rule:** Do NOT weaken the policy to clear drift — do not add the packages to
`minimumReleaseAgeExclude`. Just wait for the window to pass, then bump the
specs in `artifacts/labtrax/package.json` and run `pnpm install` +
`expo install --check` (should print "Dependencies are up to date").

**Why:** the whole point of `minimumReleaseAge` is supply-chain protection;
forcing brand-new packages through defeats it. A patch bump to Expo's
*expected* versions is low-risk once mature.

**How to apply:** if a drift-bump task is assigned while the target versions
are still < 24h old, the task is genuinely blocked on time — report it and let
it be re-run after the window, rather than excluding packages.

**Automated check:** `pnpm --filter @workspace/scripts run check-expo-deps`
(scheduled daily via `.github/workflows/expo-dep-check.yml`) runs
`expo install --check --json`, then for each outdated package queries the npm
registry publish time to classify drift as **actionable** (a newer in-range
version is past the maturity window → safe to bump, job fails) vs **in-window**
(only newer versions are still < `minimumReleaseAge` → informational, job
stays green). It reads the window from `pnpm-workspace.yaml` and never weakens
it. So a drift-bump task is "actionable" only once the check says so.

**Side note:** the auto-triggered "EAS iOS Build + Submit" workflow runs
independently and has its own pre-existing flakiness (e.g. "Failed to upload
metadata to EAS Build … 400", generic "Unknown error" in the remote install
phase). A failed EAS build there is not evidence that a local dep bump broke
anything — verify locally with `pnpm install` + typecheck + the expo dev
bundle instead.
