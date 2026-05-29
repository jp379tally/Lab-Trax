---
name: EAS iOS build-number collision loop
description: Why the iOS build script must persist the bumped build number before submitting, not after.
---

# iOS build-number collision loop

App Store Connect consumes a build number (`expo.ios.buildNumber` / CFBundleVersion)
the moment a build's IPA is uploaded. A later failure does NOT free it.

**Rule:** in `scripts/eas-ios-build.sh`, commit/push the bumped `app.json` build
number as soon as `eas build` succeeds, BEFORE `eas submit`. Only revert the bump
on a pre-build failure (nothing uploaded yet).

**Why:** the old script ran `eas build --auto-submit` (build+submit as one
command) and reverted the bump in an EXIT trap whenever the command exited
non-zero. When the build uploaded fine but the *submit* step failed (e.g. that
version was already submitted), the revert rolled the number back — so the next
run reused a number Apple had already seen and failed with
`CFBundleVersion ... has already been used / must be higher than NNN (-19232)`.
That made every subsequent attempt collide forever.

**How to apply:** keep build and submit as separate steps (`eas build` then
`eas submit --platform ios --latest`). Set the `persisted=true` flag right after
the build, so the trap skips the revert on a submit-only failure. Build-number
gaps are harmless to Apple; collisions are not — never optimize to "avoid
skipping a slot" by reverting a consumed number.
