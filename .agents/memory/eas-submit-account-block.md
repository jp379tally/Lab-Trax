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

EAS submission worker crashed before contacting Apple. `--id` and `--latest` both fail this way
when the S3 pre-signed URL expires. Submitting via **local file path** bypasses the issue:

1. Get the IPA artifact URL via GraphQL:
   ```bash
   curl -s -X POST https://api.expo.dev/graphql \
     -H "Authorization: Bearer $EXPO_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ app { byFullName(fullName: \"@jp379/labtrax\") { builds(offset:0,limit:3,filter:{platform:IOS}) { id artifacts { buildUrl } } } } }"}' \
     | python3 -m json.tool
   ```
2. Download the IPA: `curl -sL -H "Authorization: Bearer $EXPO_TOKEN" "<buildUrl>" -o /tmp/build.ipa`
3. Submit: `eas submit --platform ios --path /tmp/build.ipa --non-interactive`

**The build script (`scripts/eas-ios-build.sh`) has a built-in submit-only mode** for exactly this case.
Drop two sentinel files and restart the workflow (no build credit consumed):
```bash
echo "<BUILD_ID>" > .local/.eas-submit-build-id
echo "<IPA_URL>"  > .local/.eas-submit-ipa-url
touch .local/.eas-submit-only
# then restart "EAS iOS Build + Submit" workflow
```
The script detects both files, downloads the IPA, and submits via --path.

**Why --id keeps failing while --path works:** `--id` tells EAS to re-fetch the IPA
from its own artifact store using a freshly generated pre-signed URL that EAS-Submit
then hands to Apple's transporter. If EAS-Submit's worker crashes between URL generation
and upload start (900 s window), Apple never sees it. `--path` uploads the IPA directly
to EAS Submit's staging area first, which doesn't rely on the per-artifact S3 URL.

## Pattern B — SUBMISSION_SERVICE_IOS_OLD_APP_VERSION

"You've already submitted this version of the app. Versions are identified by
CFBundleShortVersionString."

EAS blocks resubmitting the same `expo.version` (CFBundleShortVersionString) even with a
different build number. Apple itself allows multiple builds per version string; EAS does not.

**Fix:** bump `expo.version` in `app.json` manually (e.g. 1.0.10 → 1.0.11) and rebuild.
The `bump-build-number` script only bumps `ios.buildNumber`/`android.versionCode`, NOT
`expo.version` — that must be changed by hand before starting a new build.

**Do NOT pre-bump `expo.version` defensively.** Only bump when `eas submit` returns the
explicit `SUBMISSION_SERVICE_IOS_OLD_APP_VERSION` error. Multiple consecutive builds at
the same version string (e.g. 1.0.10 build 236 through 240, or 1.0.11 build 260+) each
submit successfully as long as the version string hasn't already been submitted via `--path`.
Verify with the GraphQL `submissions { status }` query before assuming a version is blocked.

## Pattern A → B escalation (what happened June 2026)

Build 259 compiled fine. `--id` submit crashed twice (Pattern A). Forced local-file submit
via `--path` reached Apple, which returned SUBMISSION_SERVICE_IOS_OLD_APP_VERSION (Pattern B)
because version 1.0.10 had already been submitted in a prior build. Bumped to 1.0.11,
rebuilt as build 260, submitted — success on first attempt.

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
