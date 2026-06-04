---
name: EAS submit silent account-level block
description: How to diagnose `eas submit` failing instantly with no error when the IPA is fine — points to an Apple account-level delivery block (pending agreement), not a build problem.
---

# EAS submit "Something went wrong" with no detail = Apple account-level block

When `eas submit --platform ios --latest` fails instantly with
`✖ Something went wrong when submitting your app to Apple App Store Connect.`
and the EAS submission record shows `error: null`, `logFiles: []`, `canRetry: false`,
the failure is on EAS's submission **worker** (server-side), so the local CLI/DEBUG
shows nothing. Do NOT assume it's the IPA or a build-number collision.

**How to tell binary problems apart from account blocks:**
- The ASC API key reading everything as HTTP 200 (`/v1/builds`, `/v1/apps/{id}`,
  `betaGroups`, `appStoreVersions`, etc.) proves the key + key-role are fine.
- Download the IPA and read `CFBundleVersion` from `Payload/*.app/Info.plist`
  (Python `zipfile`+`plistlib`; `unzip` isn't installed). If it's a **unique** build
  number and bundle id/version/encryption look right, the binary is deliverable — so
  the block is account-level, not the IPA.
- List EAS submissions via GraphQL `app.byFullName(...).submissions(filter:{platform:IOS})`
  and look at `status` over time. **FINISHED = the build actually landed in ASC;
  ERRORED = it did not.** If submissions were FINISHED earlier today then every one
  after a certain time is ERRORED, something changed at Apple, not in your repo.

**Most likely cause:** a newly-pending App Store Connect **agreement** (Apple Developer
Program License Agreement, or Paid/Free Apps agreement) that the **Account Holder** must
accept in the App Store Connect web UI. Agreements gate *binary delivery* but NOT API
reads — exactly this symptom. Secondary check: the ASC API key's role wasn't downgraded
below App Manager. Both require the user; an API key cannot accept agreements.

**Don't waste build minutes:** the existing IPA is fine. Once the user clears the block,
re-run `eas submit --platform ios --latest` (seconds) — no rebuild.

**Mapping which build has which source:** cross-reference the ASC build `uploadedDate`
against `git log` commit times. A build uploaded *before* a rollback commit contains the
pre-rollback (buggy) code even if it's the newest one in TestFlight.
