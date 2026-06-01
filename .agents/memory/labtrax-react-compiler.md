---
name: LabTrax mobile React Compiler instability
description: Why the experimental React Compiler is disabled in artifacts/labtrax, and how to diagnose its "Invalid hook call" crashes.
---

# React Compiler caused intermittent "Invalid hook call" in the mobile app

The Expo app (`artifacts/labtrax`) shipped with the experimental React Compiler
enabled (`app.json` → `experiments.reactCompiler: true`) using an **old beta**
of `babel-plugin-react-compiler` (a `19.0.0-beta-…-20250117` build). This caused
recurring, intermittent `Invalid hook call. Hooks can only be called inside of
the body of a function component` crashes, reported by the error boundary as
occurring in `<TechDashboard>`, typically minutes into a session (not on load)
and correlated with re-renders triggered by background data refreshes.

## Why it was the compiler, not our code
The error text is the **null-dispatcher** variant — a hook invoked *outside*
React's render phase. The three official causes were checked:
- Duplicate/mismatched React → ruled out: `pnpm --filter @workspace/labtrax why react`
  shows a single `react@19.1.0` (react-dom, react-native, radix all peer onto it).
- Static Rules-of-Hooks violation → ruled out: no conditional hooks, no hooks in
  callbacks, no nested components defining hooks, across the whole `app`/`components` tree.
- That leaves code transformation: the beta compiler emits memoized code that can
  call a hook outside render. An old beta has many such codegen bugs since fixed.

## Why per-component `"use no memo"` is NOT a reliable fix here
The miscompiled component can be *any* child in the rendered subtree (TechDashboard
renders dozens), not the component the error boundary names. Sprinkling
`"use no memo"` is whack-a-mole and the crash recurred after opting out only
TechDashboard. The reliable fix is global: turn the compiler off.

**Decision:** `experiments.reactCompiler: false` in `artifacts/labtrax/app.json`.
**Why:** correctness over the marginal auto-memoization perf of an experimental
beta, for a business case-tracking app with recurring user-facing crashes.
**How to apply / re-enable:** only re-enable after upgrading
`babel-plugin-react-compiler` to a **stable 1.0+** release (with the matching
`react-compiler-runtime`) and soak-testing. Confirm the toggle took effect by the
**absence** of the `React Compiler enabled` line in the Expo startup log. Toggling
this flag needs a Metro cache clear (`rm -rf .expo node_modules/.cache` + metro tmp)
because `babel.config.js` uses `api.cache(true)`.
