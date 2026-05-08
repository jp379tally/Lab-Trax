# Submitting LabTrax to the App Store via EAS

This bypasses Replit's publishing pipeline entirely.
All commands run on **your local machine**, not inside Replit.

---

## What you need before starting

| Requirement | Where to get it |
|---|---|
| **Expo account** (free) | expo.dev — sign up if you don't have one |
| **Apple Developer membership** ($99/yr) | developer.apple.com |
| **Apple Team ID** | developer.apple.com → Account → Membership → Team ID |
| **App Store Connect app entry** | Create LabTrax at appstoreconnect.apple.com if not already there |
| **App Store Connect App ID** | appstoreconnect.apple.com → Your app → URL contains the numeric ID |

Your bundle ID is already set: `com.allieddl.labtrax`
Your current version/build: `1.0.8 (104)`

---

## Step 1 — Install EAS CLI on your local machine

```bash
npm install -g eas-cli
```

Verify it installed:
```bash
eas --version
```

---

## Step 2 — Clone/pull the latest code to your local machine

Make sure you have the latest version of the repo (including the `eas.json` that was just added).

---

## Step 3 — Log in to your Expo account

```bash
eas login
```

Enter your expo.dev email and password.

---

## Step 4 — Link the project to your Expo account

Run this from inside the `artifacts/labtrax` directory:

```bash
cd artifacts/labtrax
eas init
```

This will:
- Create a project on expo.dev under your account
- Add your Expo `owner` and `extra.eas.projectId` to `app.json` automatically
- Commit those changes

---

## Step 5 — Build for the App Store

```bash
eas build --platform ios --profile production
```

EAS will ask you to log in to your Apple Developer account on first run.  
Choose **"Let EAS handle credentials"** — it will generate the signing certificate and provisioning profile for you automatically. You will not need Xcode.

The build runs on EAS's servers (not your machine). It takes about 15–30 minutes.
You'll get a link to monitor progress at expo.dev/accounts/[you]/projects/labtrax.

---

## Step 6 — Submit to App Store Review

Once the build finishes:

```bash
eas submit --platform ios --latest
```

You'll be prompted for:
- **Apple ID**: your Apple Developer email
- **Apple Team ID**: from developer.apple.com → Membership (format: `XXXXXXXXXX`)
- **App Store Connect App ID**: the 10-digit numeric ID from the App Store Connect URL

EAS will upload the `.ipa` directly to App Store Connect and submit it for review.

---

## Step 7 — Complete metadata in App Store Connect

After submission, go to appstoreconnect.apple.com and fill in anything missing:
- Screenshots (required: 6.7" iPhone, optionally iPad)
- App description, keywords, support URL
- Privacy policy URL
- Age rating

Then click **Submit for Review**.

---

## Subsequent releases

For future updates:
1. Increment `buildNumber` in `app.json` (each submission must be higher than the last)
2. Increment `version` if you want the App Store to show a new version number
3. Re-run steps 5 and 6

---

## Troubleshooting

**"Bundle ID not found"** — Register `com.allieddl.labtrax` at developer.apple.com → Identifiers first.

**"No distribution certificate"** — Choose "Generate new certificate" when EAS asks. It handles this automatically.

**"Missing compliance"** — In App Store Connect, answer the export compliance question (answer: No — the app uses standard HTTPS, not custom encryption).

**"Invalid binary"** — Make sure the build number (104) is higher than any previously uploaded build.

---

## Production API

Your production backend is already wired: `https://lab-trax.replit.app/`
EAS builds fall back to this automatically when `EXPO_PUBLIC_DOMAIN` is not set.
No extra environment configuration needed.
