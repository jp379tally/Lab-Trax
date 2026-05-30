---
name: LabTrax mobile theming constraints
description: How the Expo app's theme/token system is wired and which files must stay hardcoded.
---

# LabTrax mobile (`artifacts/labtrax`) theming

- Tokens: `constants/tokens.ts` (Spacing/Radius/Typography/makeShadows) + semantic color palette
  in `constants/colors.ts`. All exposed on `useTheme()` (`colors, isDark, spacing, radius,
  typography, shadows`); `ThemeColors = typeof Colors.light` is exported from `lib/theme-context.tsx`.
- **`ThemeProvider` only wraps the authenticated tree.** Anything rendering before it (auth gate,
  error boundary) CANNOT call `useTheme()` — it must keep hardcoded colors. These are the only
  intentional holdouts; don't "fix" them: `app/_layout.tsx`, `components/LoginScreen.tsx`,
  `components/LockScreen.tsx`, `components/ErrorFallback.tsx`.

- **No raw hex in `app/**` + `components/**`** — enforced by `pnpm --filter @workspace/labtrax run
  lint:hex` (`scripts/lint-hex-colors.mjs`). Use `colors.*` tokens. Allowed exceptions only:
  (1) files in the script's `FILE_ALLOWLIST` (the pre-provider files above + fixed-dark media
  surfaces `ScanViewerModal`/`StlViewerModal` + Messenger-brand `ChatButton`); (2) `#000`/`#000000`
  shadows/scrims; (3) a line carrying a `hex-allow` marker comment with a reason (one-off fixed-dark
  accents, printed-label HTML templates). Adding a new color literal will fail the guard.

## Migration pattern (proven)
- `import Colors` → `import { useTheme, type ThemeColors }`.
- Module-level `StyleSheet.create({...})` → `const makeX = (colors: ThemeColors) => StyleSheet.create({...})`.
- In component: `const { colors } = useTheme(); const styles = useMemo(() => makeX(colors), [colors]);`
- Edge cases: module-level helpers/sub-components take `colors`/`styles` as params; rename any local
  var already named `colors`; StyleSheets with no colors stay as-is. Detail: `.local/theme-migration-recipe.md`.

**How to apply:** Verify with `pnpm --filter @workspace/labtrax run typecheck` (NOT `build` — needs
workflow-provided PORT/BASE_PATH). Metro can throw a transient "Unable to resolve module
.../expo-router/entry" 500; restart the expo workflow to clear it.
