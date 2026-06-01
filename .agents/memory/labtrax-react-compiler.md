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

## Confound: zombie console errors from stale iframes
After disabling the compiler, the `Invalid hook call` kept appearing in the
captured browser console — but it was a **zombie**, not a live failure. The canvas
often has **multiple iframes** of the labtrax app open at once, and Expo runs in
**CI mode (`CI=1`) which disables auto-reload**. So iframes that don't happen to
reload keep executing the *old* bundle and re-throw the stale error. Tell-tale
sign: the error timestamp falls a few seconds *before* a fresh
`Running application "main"` boot line (old iframe dying on its way out). To get a
trustworthy console reading after a Metro/config change: restart the expo workflow,
then force a fresh load (e.g. screenshot the app_preview) and read *that* boot's
console — don't trust lingering errors that predate the latest boot.

## Ruling out the three official "Invalid hook call" causes (kept current)
- react `19.1.0` === react-dom `19.1.0` (matched renderer), scheduler `0.26.0`,
  react-native-web `0.21.2` — all React-19-correct.
- single React in the tree; `react-test-renderer` is **devDependencies only** and
  never imported in source, so it is NOT in the runtime web bundle (a bundled 2nd
  renderer would fight react-dom over the dispatcher = null-dispatcher errors).
- no static Rules-of-Hooks violations in TechDashboard or its render subtree.
