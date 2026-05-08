# Submitting LabTrax to the App Store via EAS

All commands run on **your local machine**, not inside Replit.

---

## Current state (confirmed from App Store Connect)

| Field | Value |
|---|---|
| Bundle ID | `com.allieddl.labtrax` |
| App Store Connect App ID | `6760672646` |
| Last uploaded build | `1.0.8 (102)` — May 6 |
| Next build (in this repo) | `1.0.7 (104)` ← safe, 104 > 102 |
| EAS project ID in app.json | Not yet — `eas init` still needed (see Step 4) |

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
2. Increment `version` for a user-visible App Store version bump
3. Re-run steps 6 and 7

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
