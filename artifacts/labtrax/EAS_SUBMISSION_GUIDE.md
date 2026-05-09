# Submitting LabTrax to the App Store via EAS

All commands run on **your local machine**, not inside Replit.

---

## Current state (confirmed from App Store Connect)

| Field | Value |
|---|---|
| Bundle ID | `com.allieddl.labtrax` |
| App Store Connect App ID | `6760672646` (the original LabTrax listing — **not** the duplicate `6767755163`) |
| Last uploaded build (accepted) | `1.0.8 (102)` — May 6 |
| Last failed attempt | `1.0.7 (104)` — May 8 (rejected: marketing version regressed below 1.0.8) |
| Next build (in this repo) | `1.0.9 (105)` |
| ASC API key ID | `R6PFFXT9TN` (file: `AuthKey_R6PFFXT9TN.p8`, must sit next to `eas.json` at submit time; gitignored) |
| ASC API key issuer ID | `1d2faabc-3d66-4e64-b514-c234043e143a` |
| EAS project ID in app.json | `a22db9d5-6925-4348-9827-3455a22d2ca0` |

---

## Step 1 — Install EAS CLI

```bash
npm install -g eas-cli
eas --version   # confirm
```

---

## Step 2 — Pull the latest code

Make sure you have the latest repo — it now includes `eas.json` with
`ascAppId` pre-filled.

---

## Step 3 — Log in to Expo

```bash
eas login
```

Use your expo.dev credentials (same account that was used for the
"Team (Expo)" TestFlight tester group).

---

## Step 4 — Link this repo to your Expo project

```bash
cd artifacts/labtrax
eas init
```

This writes `extra.eas.projectId` into `app.json` and links this codebase
to your existing expo.dev project. If asked whether to create a new project
or link to an existing one, choose **link to existing** and select `labtrax`.

---

## Step 5 — Build for the App Store

```bash
eas build --platform ios --profile production
```

On first run EAS will ask about Apple Developer credentials.
Choose **"Let EAS handle credentials"** — it generates the signing certificate
and provisioning profile automatically. No Xcode required.

Build runs on EAS servers (~15–30 min). Monitor at:
expo.dev → your account → Projects → labtrax → Builds

---

## Step 7 — Submit to App Store Review

Once the build is complete:

```bash
eas submit --platform ios --latest
```

`eas.json` already has the App Store Connect App ID pre-filled (`6760672646`).
You'll only be prompted for:

- **Apple ID**: your Apple Developer account email
- **Apple Team ID**: 10-character string from developer.apple.com → Membership

EAS uploads the `.ipa` to App Store Connect automatically.

---

## Step 8 — Finalize in App Store Connect

Go to appstoreconnect.apple.com → LabTrax → your version → confirm:

- Screenshots are present
- Description and keywords are filled in
- Export compliance answered (choose **No** — standard HTTPS, no custom encryption)
- Privacy policy URL set

Then click **Submit for Review**.

---

## Subsequent releases

1. Increment `buildNumber` in `app.json` (must always exceed last uploaded build)
2. Increment `version` for a user-visible App Store version bump — and **never** set it lower than a version already accepted on the same train, even if the build number is higher
3. Re-run steps 6 and 7

---

## If submit fails

Three regressions have caused failed submissions before. Check these first
before re-submitting:

1. **Marketing version regressed below an accepted build.** Apple rejects
   any upload whose `expo.version` (`CFBundleShortVersionString`) is lower
   than a version already accepted on the same train, even if
   `buildNumber` is higher. Bump `version` in `app.json` past the highest
   accepted version. (This is what killed `1.0.7 (104)` on May 8 — 1.0.8
   was already accepted.)
2. **`ascAppId` points at the wrong App Store Connect record.** The real
   LabTrax listing is `6760672646`. A duplicate listing `6767755163` was
   accidentally created and should not be used. Confirm
   `submit.production.ios.ascAppId` in `eas.json` is `6760672646`.
3. **`.p8` ASC API key file missing or revoked.** `eas.json` references
   `./AuthKey_R6PFFXT9TN.p8`. The file is gitignored, so it must sit next
   to `eas.json` on the machine running `eas submit`. If the key ID was
   revoked or rotated in App Store Connect (Users and Access →
   Integrations → App Store Connect API), generate a new key, drop the
   new `.p8` next to `eas.json`, and update `ascApiKeyPath` /
   `ascApiKeyId` in `eas.json` to match.

---

## Troubleshooting

**"Build number already in use"** — Increment `buildNumber` past whatever
is currently in App Store Connect and rebuild.

**"Bundle ID not found"** — Register `com.allieddl.labtrax` at
developer.apple.com → Identifiers first.

**"No distribution certificate"** — Choose "Generate new certificate" at
the EAS prompt. Fully automated.

**"Missing compliance"** — Answer the export compliance question in App Store
Connect: No (standard HTTPS, not custom encryption).

---

## Production API

Backend is already wired: `https://lab-trax.replit.app/`  
EAS builds use this automatically — no extra environment variables needed.
