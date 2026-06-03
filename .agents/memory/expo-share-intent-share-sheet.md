---
name: Expo share-sheet presence is plugin-gated
description: Why LabTrax silently vanishes from the iOS/Android share sheet and how it's guarded
---

# "Share into LabTrax" disappears from the system share sheet

LabTrax appearing in the iOS/Android share sheet is built **entirely** by the
`expo-share-intent` config plugin block in `artifacts/labtrax/app.json`
(`plugins` array). The native Share Extension is compiled only when that block
is present.

**Failure mode (has happened in prod, twice-felt by the user):** the package
stays installed and the `useShareIntent` hook in `app/_layout.tsx` stays in the
code, but someone trims/rewrites the `plugins` array and drops the
`expo-share-intent` entry. Everything still typechecks and the JS looks fine —
but the extension is never built, so the app silently drops out of the share
sheet. Reads/tests don't catch it because it's pure native-build config.

**Why:** it's native-config-only. There is no runtime JS error to surface it,
and an OTA/JS update cannot restore it — it requires a fresh EAS native build.

**How to apply:**
- Never remove the `expo-share-intent` plugin block from `app.json` unless the
  user explicitly wants to kill the share-sheet feature.
- Required sub-keys that must stay in sync: `iosShareExtensionName`
  ("LabTraxShare"), `iosAppGroupIdentifier` ("group.app.replit.labtrax.sdr" —
  the App Group is what lets the extension hand files to the app),
  `iosActivationRules` (image/movie/file), `androidIntentFilters` +
  `androidMultiIntentFilters` ("image/*").
- A regression firewall test pins all of this:
  `lib/__tests__/share-intent-config.test.ts`. If it fails, the plugin/config
  was stripped — restore it, don't delete the test.
- Any fix here is shipped only by a new native build, never by republishing
  web/JS.

**General principle the user demanded:** once a feature is confirmed working,
protect it with an automated guard (test/lint) so a later edit can't silently
regress it. Native-config features especially need this because nothing else
catches their removal.
