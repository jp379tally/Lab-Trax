---
name: EAS iOS submission failure playbook
description: Diagnosing eas submit failures — null error vs SUBMISSION_SERVICE_IOS_OLD_APP_VERSION vs Apple account blocks.
---

# EAS iOS submission failure playbook

## Step 1 — get the real error via GraphQL

`error: null, logFiles: []` in the CLI output means NOTHING. Always pull the actual record:

```bash
EXPO_TOKEN=$(printenv EXPO_TOKEN)
curl -s -X POST https://api.expo.dev/graphql \
  -H "Authorization: Bearer $EXPO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ app { byFullName(fullName: \"@jp379/labtrax\") { submissions(filter: {}, offset: 0, limit: 3) { id status error { errorCode message } logFiles } } } }"}' \
  | python3 -m json.tool
```

Then fetch each `logFiles` URL immediately (they expire in 900 s) via `urllib.request.urlopen`.

## Pattern A — null error, empty logFiles, immediate ERRORED

EAS submission worker crashed before contacting Apple. Most likely the S3 artifact URL
(900-second pre-signed, generated when the worker starts) expired before upload began.

**Fix:** submit via local file instead of `--latest`:
1. `curl -sL -H "Authorization: Bearer $EXPO_TOKEN" "https://api.expo.dev/v2/artifacts/eas/<id>" -o /tmp/build.ipa`
2. `eas submit --platform ios --path /tmp/build.ipa --non-interactive`

## Pattern B — SUBMISSION_SERVICE_IOS_OLD_APP_VERSION

"You've already submitted this version of the app. Versions are identified by
CFBundleShortVersionString."

EAS blocks resubmitting the same `expo.version` (CFBundleShortVersionString) even with a
different build number. Apple itself allows multiple builds per version string; EAS does not.

**Fix:** bump `expo.version` in `app.json` manually (e.g. 1.0.9 → 1.0.10) and rebuild.
The `bump-build-number` script only bumps `ios.buildNumber`/`android.versionCode`, NOT
`expo.version` — that must be changed by hand before starting a new build.

**CORRECTION (verified June 2026): this block is NOT automatic — do NOT pre-bump
`expo.version` defensively.** For LabTrax's TestFlight flow, builds 236→240 were ALL
version 1.0.10 with only the build number bumped, and EACH one submitted successfully
(5 consecutive FINISHED submissions at the same version string). So the established,
working path is **bump build number only, keep `expo.version`** until Apple/EAS actually
rejects it. Only bump `expo.version` when `eas submit` returns the explicit
`SUBMISSION_SERVICE_IOS_OLD_APP_VERSION` error — never speculatively (it needlessly
churns the user-facing version). Verify current state first with the per-build
`submissions { status }` GraphQL query, not from memory.

## Pattern C — Apple account-level delivery block

Agreements tab in App Store Connect shows Active for all agreements, yet the build never
appears in ASC (check via ASC API `/v1/builds?filter[app]=<id>&sort=-uploadedDate`).
Most likely a newly-pushed Program License Agreement that only the Account Holder can
accept — or the ASC API key's role was downgraded below App Manager.

## Inspecting a downloaded IPA (unzip not installed)

```python
import zipfile, plistlib
with zipfile.ZipFile("/tmp/build.ipa") as z:
    plists = [n for n in z.namelist() if n.endswith("Info.plist") and n.count("/")==2]
    pl = plistlib.load(z.open(plists[0]))
    print(pl["CFBundleIdentifier"], pl["CFBundleVersion"], pl["CFBundleShortVersionString"])
```

## Mapping builds to source code

Cross-reference ASC build `uploadedDate` against `git log` commit times. A build uploaded
*before* a rollback commit contains the pre-rollback (buggy) code even if it's the newest
one in TestFlight.
