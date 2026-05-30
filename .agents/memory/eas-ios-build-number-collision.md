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

## Workspace gotcha: no `origin` remote (don't let git abort the run)

The script is run both in GitHub Actions CI *and* directly in the Replit
workspace (the "EAS iOS Build + Submit" workflow = `bash scripts/eas-ios-build.sh`).
The Replit workspace has **no `origin` git remote** (only `gitsafe-backup` and
`subrepl-*`). A bare `git push origin <branch>` therefore fails with
`fatal: 'origin' does not appear to be a git repository`, and under `set -e`
that aborts the script *after a successful (paid) build but before submit* —
stranding the build (this is exactly how build 155 got built but never
submitted). Two fixes, both required:
1. Flip `persisted=true` **immediately after `eas build` succeeds**, before any
   git/commit/push/submit step (not after the push). Otherwise the cleanup trap
   reverts the consumed number on a push/submit failure.
2. Make the push best-effort: only `git push` when `git remote get-url origin`
   exists, and `|| echo` so a failed push never aborts the run.

## Submitting an already-built IPA without rebuilding

If a build succeeded but submit was stranded, do NOT rebuild (wastes a paid
build + burns another number). Submit the existing one:
`eas submit --platform ios --profile production --latest`. In the Replit
workspace the bash tool caps at ~2 min and backgrounded jobs are killed when
the tool's shell tears down, so a plain `nohup … &` dies. Use
`setsid bash -c '… eas submit … > /tmp/log 2>&1' < /dev/null &` to fully detach;
once EAS prints "Scheduled iOS submission" the job runs server-side and finishes
regardless of the local CLI. Creds: `python3 scripts/write-asc-key.py` writes
`/tmp/AuthKey_RV23AJ8V62.p8` from `ASC_API_KEY_P8`; `EXPO_TOKEN` authenticates
eas-cli; eas.json `submit.production` carries the ASC app/key IDs.
