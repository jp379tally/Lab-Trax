# Submitting LabTrax to the App Store via EAS

This bypasses Replit's publishing pipeline entirely.
All commands run on **your local machine**, not inside Replit.

---

## What you need before starting

| Requirement | Status |
|---|---|
| **Bundle ID** | `com.allieddl.labtrax` ✅ |
| **App Store Connect app** | App ID `6760672646` ✅ |
| **Version / build** | `1.0.8 (104)` ✅ |
| **Expo account** (free) | expo.dev — sign up if you don't have one |
| **Apple Developer membership** ($99/yr) | developer.apple.com |
| **Apple Team ID** | developer.apple.com → Account → Membership → Team ID |
| **Apple ID email** | Your Apple Developer account email |

---

## Step 1 — Install EAS CLI on your local machine

```bash
npm install -g eas-cli
eas --version   # confirm it installed
```

---

## Step 2 — Pull the latest code

Make sure you have the latest repo (includes the `eas.json` that was just added).

---

## Step 3 — Log in to your Expo account

```bash
eas login
```

---

## Step 4 — Link the project to your Expo account

From the repo root or from inside `artifacts/labtrax`:

```bash
cd artifacts/labtrax
eas init
```

This creates a project on expo.dev under your account and automatically adds
your Expo `owner` and `extra.eas.projectId` to `app.json`.

---

## Step 5 — Build for the App Store

```bash
eas build --platform ios --profile production
```

On first run EAS will prompt you to sign in to your Apple Developer account.  
Choose **"Let EAS handle credentials"** — it generates the signing certificate
and provisioning profile automatically. No Xcode required.

The build runs on EAS's servers and takes about 15–30 minutes.
Monitor progress at expo.dev → your account → Projects → labtrax.

---

## Step 6 — Submit to App Store Review

Once the build completes:

```bash
eas submit --platform ios --latest
```

EAS already knows the App Store Connect App ID (`6760672646` — pre-filled in
`eas.json`). You'll only be prompted for:

- **Apple ID**: your Apple Developer email address
- **Apple Team ID**: 10-character string from developer.apple.com → Membership

EAS uploads the `.ipa` directly to App Store Connect and marks it ready for review.

---

## Step 7 — Complete metadata in App Store Connect

Go to appstoreconnect.apple.com → LabTrax and confirm everything is filled in:

- Screenshots (required: 6.7" iPhone; iPad optional)
- Description, keywords, support URL
- Privacy policy URL
- Export compliance (answer **No** — app uses standard HTTPS only)

Then click **Submit for Review**.

---

## Subsequent releases

1. Increment `buildNumber` in `app.json` (must always be higher than last upload)
2. Increment `version` for a user-visible version bump
3. Re-run steps 5 and 6

---

## Troubleshooting

**"Bundle ID not found"** — Register `com.allieddl.labtrax` at
developer.apple.com → Certificates, IDs & Profiles → Identifiers.

**"No distribution certificate"** — Choose "Generate new certificate" when
EAS prompts. It handles this end-to-end.

**"Invalid binary — build number already used"** — The build number in
`app.json` must be strictly higher than the last uploaded build. Increment it
and rebuild.

**"Missing compliance"** — Answer the export compliance question in App Store
Connect: No (standard HTTPS, not custom encryption).

---

## Production API

Backend URL is already hardcoded: `https://lab-trax.replit.app/`  
EAS builds use this automatically — no extra environment variables needed.
