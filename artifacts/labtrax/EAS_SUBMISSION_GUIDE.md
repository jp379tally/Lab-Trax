# LabTrax iOS build and submission

This guide describes the repository's **existing, separately approved EAS route**.
It is not a fix for Replit's App Store publishing button. Replit Expo Launch and
the repository's `EAS iOS Build + Submit` workflow are different entry points.
Do not use either to bypass a failing release gate.

## Direct checked release from Replit Shell

Run `pnpm run ios:check` from the repository root to run and record all required source-bound checks. API and backup/restore tests use disposable local databases. Logs are retained under `.local/ios-release-checks/`.

Run `pnpm run ios:ready` for a read-only live Expo/Apple account and bundle-identity check. It never starts a build or upload.

Run `pnpm run ios:release` only to explicitly authorize one iOS build and its submission. It repeats verification, arms one build after every check passes, and invokes the existing exact-build upload path. Failed checks, source changes, concurrent preparation, and unresolved submissions block the release. `pnpm run ios:status` reports the current state.

These commands do not use Replit Agent or require the hosted App Store publishing button. Check mode never starts a build. An accepted upload still requires Apple processing before TestFlight availability can be confirmed.

## Verified identity — October 9, 2026

| Field | Verified value / source |
|---|---|
| iOS bundle ID | `app.replit.labtrax` — `app.json`, resolved Expo config, and live App Store Connect |
| App Store Connect app ID | `6760672646` — `eas.json` and successful read-only Apple lookup |
| Local marketing version / build | `1.0.13 (333)` — `app.json`; not an instruction to reuse build 333 |
| Latest queried EAS iOS store build | `1.0.13 (333)`, finished September 23, 2026 |
| Latest queried Apple upload | `1.0.13 (333)`, processing state `VALID`, September 23, 2026 |
| Latest queried public App Store version | `1.0.12`, state `READY_FOR_SALE` |
| EAS project | `a22db9d5-6925-4348-9827-3455a22d2ca0`, configured owner `jp379` |
| Share extension | Target `LabTraxShare`, bundle ID `app.replit.labtrax.share-extension` |
| App Group | `group.app.replit.labtrax.sdr` — resolved config and active main/share provisioning entitlements |
| Apple team | `2D9XT8L3D2` — active main/share provisioning entitlements match script configuration |
| ASC key metadata | Key ID `RV23AJ8V62`; issuer `1d2faabc-3d66-4e64-b514-c234043e143a` |
| Temporary credential path | `/tmp/AuthKey_RV23AJ8V62.p8` — `eas.json` and credential writer |
| API origin | `https://lab-trax.replit.app` — verified public deployment; native builds use the existing application configuration |

These are dated observations, not permanent claims. Re-check Apple/EAS immediately
before an approved release. A successful build is not an upload; a `VALID` upload
is not App Store review approval. The queried version list did **not** show an
App Store review record for `1.0.13`.

## Prerequisites

1. Run the Required Pre-Release Checklist in `REGRESSION_GUARDRAILS.md`, starting
   with `check-test-harness:collect`. Every automated gate must pass. The
   diagnostic `bash scripts/run-workspace-audit.sh` records checks in that order
   and continues after failures for investigation; its output is **not release
   approval**. Raw logs are private/ignored under `generated-artifacts/`.
2. After distributing the exact artifact, complete the protected real-device/TestFlight checklist. Web screenshots,
   TypeScript, mocked tests and configuration introspection do not prove native
   camera, scanner, share extension, printing, depth or device authentication.
3. Confirm current App Store Connect version/build history and choose the
   intended release version. `appVersionSource` is `local`; no automatic EAS
   version increment is configured. The approved workflow reserves the next
   local build number. Starting from this snapshot that would be 334, but
   **do not assume 334 is still unused at release time**.
4. The operator environment needs `pnpm`, Node, Python 3, OpenSSL, `flock`,
   the installed EAS CLI, and (only for the IPA-download retry) `curl` and `unzip`.
   Existing `EXPO_TOKEN` and `ASC_API_KEY_P8` secrets must be available. Never
   paste them into chat, logs, source, an approval token, or a shell argument.
5. Keep the existing EAS project and Apple listing. Do not run project
   initialization, create a replacement listing, change bundle IDs, or rotate
   credentials to work around the Replit button error.
6. Active App Store profiles were found for the main app and share extension,
   with matching App Group entitlements. Older invalid main profiles also exist.
   This audit did not change them or inspect which cached profile EAS will
   select in a future build. A real authorized build is the final signing check.

## Credential handling

`artifacts/labtrax/scripts/write-asc-key.py` reads the saved `ASC_API_KEY_P8`
secret. It validates an EC P-256 PKCS#8 key and atomically writes the configured
temporary file with owner-only permissions. It supports real, escaped, CRLF,
and space-separated PEM newlines. Release scripts remove the file on exit.

The key does **not** belong next to `eas.json`, and the old key/file instructions
are obsolete. The API key authenticated the audit's read-only Apple calls.
The saved Expo token also authenticated a read-only identity query and read the
linked project with an owner matching the configuration. Neither check
establishes the status of Replit's separate publishing authentication.
Apple ID/password secrets are not used by this API-key upload route.

## After separate approval: build and upload

Do not run these steps during an audit. Obtain explicit approval for both the
paid cloud build and the upload first:

From the repository root, run `pnpm run ios:release`. It verifies live Expo and Apple account access, runs every automated release check, arms one approval, and invokes the guarded build/upload script with `--run-approved`. Validate the exact artifact on a physical device after distribution.

Do not just restart **EAS iOS Build + Submit**: its ordinary invocation stays idle on automatic restarts, including when an approval file exists. The hosted Replit Publish wizard is not required for this direct Expo path.

The token is consumed once. The script serializes release operations, snapshots
the current app configuration, increments the build number, builds the production
iOS profile, and uploads **the exact completed build ID**, not whichever build
another operator made most recently. It records a retry ID before submission.

A credential/pre-build failure restores the exact pre-bump worktree file,
including uncommitted configuration. Once the remote build command has started,
an ambiguous failure retains the reserved number: inspect the remote result
before retrying. Never lower a reserved or uploaded build number. The completed
build number remains reserved even if committing or uploading subsequently fails.
Conflicting build/submit-only approvals are refused. A recorded pending upload
also blocks a new paid build: reconcile that existing artifact first rather than
overwriting its retry ID. The blocked build approval is consumed and must be
explicitly renewed after reconciliation.

## After separate approval: retry an existing build upload

First confirm the exact build is the intended iOS production artifact and has
not already uploaded successfully. An upload retry must not launch another build.

The existing submit-only helper requires explicit approval and an exact build ID:

```bash
EAS_SUBMIT_APPROVED=1 EAS_BUILD_ID=<approved-build-uuid> bash scripts/eas-ios-submit-only.sh
```

On successful upload, the helper clears pending retry metadata only if it belongs
to that same build ID. Failed uploads and different-build metadata are retained.

Alternatively, save that UUID in `.local/.eas-submit-build-id`, create the
one-shot `.local/.eas-submit-only` token, and explicitly run `bash scripts/eas-ios-build.sh --submit-approved`.
No build number is incremented in this mode. A failed attempt consumes its
approval but retains the retry metadata. Re-approve only after inspecting the
failure and checking whether Apple received the upload.

For the existing expired-artifact-link workaround, `.local/.eas-submit-ipa-url`
may contain the matching HTTPS `expo.dev` artifact URL. Keep it private. The
workflow first fetches read-only EAS build metadata and requires the URL to match
the exact approved completed production/store iOS build in this configured
project. A stale/mismatched URL or failed metadata lookup stops before download
or upload. It then checks HTTP success, ZIP integrity and an iOS app payload;
it never sends the Expo bearer credential to an arbitrary URL host.
This branch is optional; prefer the exact build ID route when it works.

## What happens after upload

The workflow uploads to **App Store Connect/TestFlight**. It does **not** submit
the app for App Store review or release it publicly.

After Apple finishes processing, verify the intended version/build in App Store
Connect and complete TestFlight/device checks. For an App Store release, the
owner separately creates/selects the intended version, chooses the processed
build, checks screenshots/metadata/privacy information and actual encryption
compliance, then explicitly submits for review in App Store Connect. Do not
answer compliance questions from an old guide without checking the app's use.

## Replit button fails immediately

See `docs/ios-publishing-escalation.md`. The October 9 audit found **no Expo
Launch session**, despite the reported immediate “Something unexpected happened”
message. No retained workflow means there is no build log to blame on Apple or
EAS. Browser request details were requested but were not provided. The precise
cause remains unconfirmed; documentation and local dependency repairs do not
establish that this platform-entry error is fixed.
