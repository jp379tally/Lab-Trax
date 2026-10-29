# Auto-update end-to-end runbook

## Release channels

### Replit/Linux portable download

`scripts/desktop-build-publish.sh` produces a Windows portable ZIP on Linux
and publishes it at `/downloads/LabTrax-Windows-Portable.zip`. The package is
marked as `portable`; the app disables electron-updater and does not modify
`latest.yml`. Portable users install a newer ZIP manually. It is not a
supported in-place update channel.

### Signed Windows and macOS installer updates

The supported in-place update channel is the API's generic electron-updater
feed. Signed Windows NSIS and macOS packages built by `.github/workflows/release.yml`
record `${PUBLISH_API_BASE_URL}/downloads/` in the packaged build stamp and
include `resources/app-update.yml` for electron-updater compatibility. At
startup the desktop main process explicitly selects the generic API feed from
the build stamp, falling back to the production API `/downloads/` endpoint if
the stamp is missing that field. The installer build does not publish directly
from electron-builder.

The release workflow stages signed installers, update manifests, and macOS
update ZIPs as a GitHub draft. It also publishes the fresh Windows installer
and macOS DMG for direct download; the in-app update feed remains on its
previous version until the draft is reviewed. Run **Publish Draft Release**
after verifying the assets. It publishes the release, copies the macOS update
ZIPs to App Storage with their manifest SHA-512/size verified, then publishes:

- `GET /downloads/latest.yml` → Windows `LabTrax-Setup.exe` from App Storage.
- `GET /downloads/latest-mac.yml` → macOS manifest whose versioned ZIP names
  resolve to `/downloads/<filename>` and are served from App Storage.

The API refuses the new feed if the Windows EXE does not match `latest.yml`
or any referenced macOS ZIP is missing. The release workflow also rejects a
manifest that points Windows at the portable ZIP. Installed clients check
the generic feed; the GitHub Release is a staging/release channel, not their
runtime update provider.

To publish a release:

1. Run the desktop release workflow or auto-tag workflow for a tag `vX.Y.Z`.
   The build produces the signed Windows and macOS artifacts and a draft
   GitHub Release.
2. Inspect the draft assets. Windows `latest.yml` must point to
   `LabTrax-Setup.exe`; `latest-mac.yml` must reference the versioned signed
   macOS update ZIPs.
3. Run **Publish Draft Release** with the same tag. It validates, publishes,
   uploads the macOS update payloads, and updates the API feed.
4. Verify:
   `curl -fsS "${PUBLISH_API_BASE_URL}/downloads/latest.yml" | head`
   and
   `curl -fsS "${PUBLISH_API_BASE_URL}/downloads/latest-mac.yml" | head`.

The feed fallback is code, so it cannot be added retroactively to an executable
that is already installed. Older builds that still have a working updater can
receive the build that selects the API feed and then continue updating in
place. If an installed build cannot check for updates, install the signed
platform installer once; Settings → Software updates in builds with the
transition guidance links directly to `LabTrax-Setup.exe` on Windows or
`LabTrax.dmg` on macOS. These links deliberately bypass the download-page
installer selection and never point to the portable ZIP.

Do not claim that the old-to-new in-place path is available until a packaged
N-to-N+1 update has been exercised on the matching operating system. For each
supported OS, verify on an actual installed build:

1. Install signed version N, then publish signed N+1 to the API generic feed.
   For the compatibility check, install version N built with this transition
   code and its normal installed location, but without a usable URL in
   `app-update.yml`. Confirm the packaged `build-stamp.json` URL or the
   production fallback is selected. This tests an absent/stale manifest URL;
   it does not retrofit code into an already-installed binary.
2. Launch version N and confirm `main.log` reports the generic
   `${PUBLISH_API_BASE_URL}/downloads/` feed, then check for updates.
3. Confirm the downloaded Windows payload is `LabTrax-Setup.exe` (not
   `LabTrax-Windows-Portable.zip`), or the macOS manifest resolves to its
   signed update ZIP. Restart and verify the installed version is N+1.
4. Repeat with a portable Windows build and confirm it cannot check/install
   through the updater, while its guidance links to `LabTrax-Setup.exe`.
5. Install a Microsoft Store MSIX and confirm it remains Store-managed and
   never advertises the standalone installer.

Record the OS, installed N/N+1 versions, feed URL, payload filenames, and
result in the release verification record. The source-level tests do not
replace these installed-build checks.

### Users with broken shortcuts

If an installed update fails or a shortcut points at a stale path, reinstall
from the current signed installer. The NSIS installer uses the same
`%LOCALAPPDATA%\Programs\LabTrax\` directory; user-data migration still needs
to be verified on packaged N-to-N+1 builds rather than inferred from source.

**Skip a rebuild:** include `[skip desktop-release]` or `[skip ci]` in the merge commit subject.

**REGRESSION_GUARDRAILS.md** has the authoritative parity rule and step-by-step publish verification checklist.

### Microsoft Store MSIX channel

The Microsoft Store package is built and submitted separately from the
standalone NSIS installer. The Store app relies on Store-managed updates and
must not update itself with `LabTrax-Setup.exe`; `process.windowsStore` disables
the generic `electron-updater` path only for the Store package. Direct NSIS
installs use `/downloads/latest.yml`. The update Settings panel gives Store
users a Store-specific message and does not show a direct-installer link.

Use [microsoft-store-submission-checklist.md](./microsoft-store-submission-checklist.md)
for the Partner Center variables, independent Store-package checks, direct
installer update smoke, listing requirements, and certification handoff.

---

The auto-tag workflow can build and stage a desktop release after desktop
changes, but the stable in-app feed is updated only when **Publish Draft
Release** succeeds. That explicit approval gate prevents a failed or
unreviewed build from becoming an installed update.

---


This runbook describes how to verify that a packaged LabTrax Desktop build will actually
download a newer version, swap binaries, and relaunch on the new version.
Unit tests cover the IPC wiring and `releaseNotes` shape handling, but they
stub `electron-updater`. Run this runbook before every major release to catch
regressions in `electron-builder` config (wrong publish provider, missing
`latest.yml`, signature mismatch, etc.) that unit tests cannot see.

## Sign-in and preference retention status

Automated tests simulate an app restart and check that encrypted sign-in data
and a hidden Cases-table column can be read again from the same per-user data
stores. These tests do **not** install or update a signed Windows or macOS app.
Actual signed installer retention has not been verified on either operating
system; no Windows/macOS build or update channel is recorded as tested.

The signed-installer procedure in section 5a is the real-device check for a
future Windows/macOS tester. Do not report its results as passed until it has
been run on those computers.

The runbook uses `electron-builder`'s **generic** publish provider against a
local HTTP server, so no GitHub Release or code-signing certificate is
required. Code-signing is still recommended for real releases — see "Notes
on signing" at the end.

> Estimated time: ~25 min on a Windows machine, ~30 min on a Mac.
> You need a Windows or macOS host (not Replit / Linux) because the packaged
> app must actually run.

---

## 0. Prerequisites

- A clean working tree on the branch you want to release.
- Node 24 + pnpm installed locally.
- A Windows 10/11 machine for the Windows path, or a macOS 12+ machine for
  the macOS path. (You only need to verify one platform per run; do both
  before a major release.)
- An API base URL the packaged app can reach. The dev/staging Replit URL
  is fine: `https://your-app.replit.dev`.

Pick a working directory outside the repo to host the update feed:

```bash
export FEED_DIR="$HOME/labtrax-update-feed"
mkdir -p "$FEED_DIR"
```

Pick a feed URL the packaged app can reach. For a same-machine test:

```bash
export UPDATE_FEED_URL="http://127.0.0.1:8765/"
```

> The trailing slash matters — `electron-updater` appends `latest.yml` /
> `latest-mac.yml` / the installer filename to the base URL.

---

## 1. Build version N (the "old" build)

From the repo root:

```bash
# 1a. Pin version N in package.json
cd artifacts/labtrax-desktop
node -e "const p=require('./package.json'); p.version='9.9.0'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');"

# 1b. Build and publish to the local feed dir
VITE_API_BASE_URL=https://your-app.replit.dev \
UPDATE_FEED_URL="file://$FEED_DIR/" \
pnpm run electron:build
```

`scripts/electron-build.mjs` sees `UPDATE_FEED_URL`, switches the publish
provider to `generic`, and runs `electron-builder --publish always`.
electron-builder will write the installer + `latest.yml` (Windows) or
`latest-mac.yml` (macOS) into a temp dir and then upload them — for the
generic provider with a `file://` URL it just copies them to `$FEED_DIR`.

After the build:

- **Windows:** install version N by running
  `electron-dist/LabTrax-Setup.exe`. Confirm `LabTrax` appears in the
  Start menu and launches.
- **macOS:** open `electron-dist/LabTrax-9.9.0-*.dmg` and drag LabTrax to
  `/Applications`. Launch it.

Open the app's Settings panel and confirm the version reads **9.9.0**.
Sign in with a dedicated test account and leave **Remember me** enabled. On
the Cases page, open **Columns** and hide one visible column (for example,
**Notes**). Confirm the column stays hidden after closing and reopening the
app once. This establishes both pieces of state before the update.

Quit the app fully (Windows: right-click tray icon → Quit; macOS: `Cmd-Q`).
Auto-update only triggers on the next launch.

> Save the contents of `$FEED_DIR` as the "N" snapshot if you want to
> rerun the test without rebuilding:
> `cp -R "$FEED_DIR" "$FEED_DIR.v9.9.0"`. Then **clear it** before step 2
> so version N+1's manifest replaces it: `rm -rf "$FEED_DIR"/*`.

---

## 2. Build version N+1 (the "new" build)

```bash
cd artifacts/labtrax-desktop

# 2a. Bump version
node -e "const p=require('./package.json'); p.version='9.9.1'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');"

# 2b. Make a visible change so you can confirm the new binary is running
#     e.g. edit src/components/Settings.tsx to display a "v9.9.1 — UPDATED"
#     banner. Any visible diff works.

# 2c. Rebuild + publish into the SAME feed dir (overwrites latest.yml)
rm -rf "$FEED_DIR"/*
VITE_API_BASE_URL=https://your-app.replit.dev \
UPDATE_FEED_URL="file://$FEED_DIR/" \
pnpm run electron:build
```

After this step, `$FEED_DIR` contains:

- `latest.yml` (Windows) or `latest-mac.yml` (macOS)
- `LabTrax-Setup.exe` + `.blockmap` (Windows) or `LabTrax-9.9.1-*.zip` +
  `.blockmap` (macOS — the auto-updater downloads the zip target, not the
  DMG).

Open `latest.yml` and confirm `version: 9.9.1`.

---

## 3. Serve the feed over HTTP

`electron-updater` requires `http(s)://` for the generic provider at
runtime, so serve `$FEED_DIR` locally:

```bash
# Any static server works; this is the simplest:
npx --yes http-server "$FEED_DIR" -p 8765 -a 127.0.0.1 --cors
```

Smoke-check the feed from another terminal:

```bash
curl -fsS http://127.0.0.1:8765/latest.yml | head
# Expect: version: 9.9.1
```

Leave the server running for step 4.

---

## 4. Launch version N pointed at the feed

For the runbook test you need to override the feed URL that was baked into
the version-N binary so it checks the local http-server (not the production
API server). Pass `UPDATE_FEED_URL` as an environment variable on launch —
`setupAutoUpdater()` in `electron/main.cjs` detects it and calls
`autoUpdater.setFeedURL({ provider: "generic", url: feedUrl })`, which
takes precedence over `app-update.yml`.

> **Note for production installs:** end-users never need to set
> `UPDATE_FEED_URL`. The correct generic feed URL is already baked into
> `resources/app-update.yml` at build time by
> the signed installer build in `.github/workflows/release.yml`. The runtime env-var override is a
> runbook testing convenience only.

**Windows (PowerShell):**

```powershell
$env:UPDATE_FEED_URL = "http://127.0.0.1:8765/"
& "$env:LOCALAPPDATA\Programs\LabTrax\LabTrax.exe"
```

**macOS:**

```bash
UPDATE_FEED_URL="http://127.0.0.1:8765/" open -W /Applications/LabTrax.app
```

Within ~30 seconds you should observe, in order:

1. The app launches showing version **9.9.0** in Settings.
2. The download-progress IPC fires (no UI by default — watch the log file).
3. An "update downloaded" toast/banner appears (driven by the
   `update-downloaded` IPC channel; see `src/components/UpdateBanner.tsx`
   or equivalent).
4. Click **Restart to install** in the banner, or quit the app — both
   `quitAndInstall()` (immediate) and `autoInstallOnAppQuit` (on next quit)
   are wired up.

### Where to read the log

`electron-log` writes to:

- **Windows:** `%USERPROFILE%\AppData\Roaming\LabTrax\logs\main.log`
- **macOS:** `~/Library/Logs/LabTrax/main.log`

Tail it in another terminal while step 4 runs. You should see lines like:

```text
Checking for updates…
Update available: v9.9.1 — downloading in background
Download progress: 12%
…
Download progress: 100%
Update downloaded: v9.9.1
```

If you instead see `Update check failed` or `ENOTFOUND`, the packaged app
did not pick up `UPDATE_FEED_URL` — re-launch from the same shell that
exported the variable. (Double-clicking the app icon will not inherit
your shell environment.)

---

## 5. Verify the install swap

After `quitAndInstall()` the app should relaunch automatically.

Confirm **all** of the following:

- [ ] The Settings panel now shows version **9.9.1**.
- [ ] The visible change you introduced in step 2b is present.
- [ ] On Windows, the installed binary at
      `%LOCALAPPDATA%\Programs\LabTrax\LabTrax.exe` has a "Modified"
      timestamp from a few seconds ago.
- [ ] On macOS, `mdls -name kMDItemVersion /Applications/LabTrax.app`
      reports `9.9.1`.
- [ ] `main.log` from step 4 contains no lines beginning with
      `Auto-updater error:`.

If every box is checked, auto-update is working end-to-end. ✅

---


## 5a. Verify signed update keeps sign-in and preferences

Run this check separately on a supported Windows machine and a supported Mac.
Use real signed N and N+1 builds for the same platform and architecture, made
with the **same signing identity**. The update payload and manifest must come
from the generic installer feed (`latest.yml` on Windows or `latest-mac.yml`
on macOS); a portable ZIP, Store/MSIX package, unsigned build, or mocked
updater test is not evidence for this check. The local HTTP feed in this
runbook is acceptable if both builds are signed by the same identity and the
N build receives N+1 through the in-app updater.

Before updating, record the visible N version/build number, the feed channel,
and the preference changed in step 1. Then:

- [ ] Confirm N is signed and installed from its platform installer.
- [ ] Confirm the test account is signed in and **Remember me** was enabled
      when signing in. Do not record or copy any tokens.
- [ ] Confirm the selected Cases column is hidden, then quit and relaunch N
      once to confirm the preference is saved before the update.
- [ ] Launch N with the N+1 feed available, wait for the in-app update to
      download, and choose **Restart to install**.
- [ ] Confirm the relaunched app reports N+1 and shows the visible N+1 marker
      from step 2b.
- [ ] Confirm the test account is still signed in without entering credentials.
- [ ] Confirm the same Cases column is still hidden.
- [ ] Confirm the updater log has no `Auto-updater error:` entries.
- [ ] Confirm the installed app is still signed by the expected publisher /
      Developer ID.

Do not infer a pass from the encrypted token file existing. The proof is that
the app restores the authenticated session and the chosen UI preference after
the signed update and relaunch. The auth blob is stored under Electron's
per-user `userData` directory (`auth-tokens.bin`); the Cases column preference
is stored in the renderer's persistent profile. Never inspect or include token
contents in the test record.

### What the automated tests cover

The Linux test suite covers two pieces of the restart behavior:

- `electron/__tests__/auth-store.test.ts` reinitializes the token-store module
  and checks that it can restore saved tokens from the same test user-data
  directory.
- `src/hooks/__tests__/useTableColumns.test.tsx` remounts the column-preference
  hook and checks that a hidden column is restored from test local storage.

These tests use mocked storage and do not run Electron's signed installer,
`electron-updater`, Windows Authenticode, or macOS notarization. They are
regression checks for persistence code only, not proof that an installed
signed update retains state on either operating system.

## 6. Cleanup

```bash
# Stop the http-server (Ctrl-C in its terminal)
rm -rf "$FEED_DIR"
unset UPDATE_FEED_URL FEED_DIR

# Restore the version bump in package.json
git checkout -- artifacts/labtrax-desktop/package.json
# Revert the visible change you made in step 2b
git checkout -- artifacts/labtrax-desktop/src
```

Uninstall the test build:

- **Windows:** Settings → Apps → LabTrax → Uninstall.
- **macOS:** drag `LabTrax.app` from `/Applications` to the Trash.

---

## Notes on signing

This runbook intentionally skips code-signing so it can be run on any
developer machine without certificates. Signed-build verification has one
extra failure mode: `electron-updater` rejects the downloaded installer
if the signature does not match the currently-installed binary's
publisher. Before a real release, run the runbook a second time using
the same code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) for
both N and N+1 builds — a mismatch here is the most common cause of
"download succeeds but install never happens" reports from the field.

## Automated signature verification in `desktop-build-publish.sh`

`scripts/desktop-build-publish.sh` calls `scripts/verify-signing.sh`
after `pnpm run electron:build` completes and **before** any `latest.yml`
generation or upload to App Storage. This prevents a silently-unsigned or
wrongly-signed installer from reaching users or the auto-update feed.

The verification is implemented as a standalone script so it can be tested
in isolation (see `scripts/test-signing-verification.sh` and the Replit
"Desktop Signed Build Verification" workflow).

### What is verified

Both of the following artifacts are checked when CSC_LINK is set:

| Artifact | Always verified? | Notes |
|---|---|---|
| `electron-dist/win-unpacked/LabTrax.exe` | Yes | The main executable; produced on all platforms |
| `electron-dist/LabTrax-Setup.exe` | When produced (Windows / CI) | The NSIS installer PE; also an Authenticode-signable PE file |
| `electron-dist/LabTrax-Windows-Portable.zip` | No | Not a PE file; not Authenticode-signable. Only the EXE inside it is verified (above). A note is logged. |

### CI output (logged for every verified file)

For each file that is checked, `verify-signing.sh` logs four fields:

```
[signing]   Certificate subject  : /C=US/O=Acme Dental Software LLC/CN=Acme Dental Software LLC
[signing]   Publisher (CN)       : Acme Dental Software LLC
[signing]   Timestamp authority  : /CN=Sectigo RSA Time Stamping CA
[signing]   Signature status     : ✓ VALID (Authenticode chain trusted)
```

These fields are always emitted to make post-build debugging straightforward
without re-running the build manually.

### Verification tools (tried in order)

| Tool | Platform | How to install |
|---|---|---|
| `signtool verify /pa /v` | Windows | Included in the Windows SDK; present on `windows-latest` GitHub Actions runners automatically |
| `osslsigncode verify -verbose` | Linux / macOS | `apt-get install -y osslsigncode` (Ubuntu/Debian) or `brew install osslsigncode` (macOS) |

`/pa` (and the `osslsigncode` equivalent) validates the full Authenticode
certificate chain — an expired or revoked certificate fails the check even
if a signature block is physically present.

### Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `CSC_LINK` | Triggers signing path | Base64-encoded PFX. Absent → verification skipped entirely (unsigned build path) |
| `CSC_KEY_PASSWORD` | Required when `CSC_LINK` is set | PFX password. Absent when `CSC_LINK` is set → hard failure (exit 1) |
| `CSC_EXPECTED_PUBLISHER` | Optional but strongly recommended | Exact CN (Common Name) from the code-signing certificate, e.g. `"Acme Dental Software LLC"`. When set, the signer's subject in every verified file must contain this string — catches wrong-cert scenarios (expired cert renewed under a new name, dev cert in a production build, etc.) |

### Behaviour by scenario

| Condition | Outcome |
|---|---|
| `CSC_LINK` absent | Step is **skipped** — log: "Signing disabled; verification skipped." Upload proceeds (unsigned path) |
| `CSC_LINK` set, `CSC_KEY_PASSWORD` absent | **Exits non-zero** — misconfiguration; build aborted before upload |
| `CSC_LINK` set, both files have valid signatures | Proceeds to publisher check; then to upload if publisher passes |
| `CSC_LINK` set, any file has invalid / missing signature | **Exits non-zero** — upload blocked; `latest.yml` not generated |
| `CSC_LINK` set, certificate expired or revoked | **Exits non-zero** — upload blocked; `latest.yml` not generated |
| `CSC_LINK` set, `CSC_EXPECTED_PUBLISHER` set, CN matches | Proceeds to upload |
| `CSC_LINK` set, `CSC_EXPECTED_PUBLISHER` set, CN mismatch | **Exits non-zero** — wrong certificate; upload blocked |
| `CSC_LINK` set, `CSC_EXPECTED_PUBLISHER` absent | Signature + chain check only; publisher name not validated (warning logged) |
| `CSC_LINK` set, no verification tool found | **Exits non-zero** — cannot safely proceed; upload blocked |
| Installer is a ZIP (portable path) | Only `LabTrax.exe` verified; note logged |

### Auto-update protection

`desktop-build-publish.sh` uses `set -euo pipefail`. `verify-signing.sh` is
called **before** `latest.yml` generation and before the upload step. A
non-zero exit from `verify-signing.sh` stops the entire script — neither the
auto-update manifest nor the installer binary is ever written to App Storage
when verification fails.

### CI setup (GitHub Actions `windows-latest`)

`signtool` is available without any extra installation step on
`windows-latest` runners. Ensure `CSC_LINK`, `CSC_KEY_PASSWORD`, and
(strongly recommended) `CSC_EXPECTED_PUBLISHER` are set as repository secrets.
The `.github/workflows/release.yml` Windows publish step inherits all three
and will abort with a clear error message if any verified file is unsigned,
expired, or signed with the wrong certificate.

### Replit / Linux builds

Portable-ZIP builds produced on Linux do not go through the Windows code-signing
path (Wine is not present). When `CSC_LINK` is set on Replit, install
`osslsigncode` in the environment so the check can run:

```bash
apt-get install -y osslsigncode
```

The script aborts rather than upload an unverified binary.

### Standalone verifier

`verify-signing.sh` can be called directly for ad-hoc checks:

```bash
# Verify just the EXE
CSC_LINK=... CSC_KEY_PASSWORD=... CSC_EXPECTED_PUBLISHER="Acme Dental Software LLC" \
  bash scripts/verify-signing.sh electron-dist/win-unpacked/LabTrax.exe

# Verify both EXE and NSIS installer
CSC_LINK=... CSC_KEY_PASSWORD=... CSC_EXPECTED_PUBLISHER="Acme Dental Software LLC" \
  bash scripts/verify-signing.sh \
    electron-dist/win-unpacked/LabTrax.exe \
    electron-dist/LabTrax-Setup.exe
```

### Automated test suite

`scripts/test-signing-verification.sh` tests all five required scenarios using
a configurable mock `osslsigncode` injected via `PATH`. Runs on Linux / Replit
without certificates. Run it from the Replit "Desktop Signed Build Verification"
workflow or directly:

```bash
bash scripts/test-signing-verification.sh
```

### Diagnosing a failure

```
[signing]   Signature status     : ✗ FAILED (exit 1)
[signing] Full signtool output:
[signing]   ...
[signing] DIAGNOSIS: Certificate is expired, revoked, or not yet valid.
[signing] Aborting publish — do not upload an unverified artifact.
```

```
[signing]   ✗ Publisher mismatch!
[signing]       Expected (CSC_EXPECTED_PUBLISHER): "Acme Dental Software LLC"
[signing]       Actual publisher                 : "Wrong Company LLC"
[signing]     A build signed with the wrong certificate must never be published.
[signing]     Check that CSC_LINK contains the correct certificate.
```

Common causes:

| Symptom | Likely cause |
|---|---|
| `FAILED (exit 1)` immediately after build | `CSC_LINK` base64 is truncated or padded incorrectly — re-encode: `base64 -w 0 certificate.pfx` |
| `CSC_KEY_PASSWORD is absent` error | `CSC_KEY_PASSWORD` secret not set — add it alongside `CSC_LINK` |
| `Certificate chain … not trusted` | OV certificate not in the trusted root store on the build runner (normal for self-signed test certs) |
| `Certificate is expired, revoked, or not yet valid` | Certificate expired — renew with your CA |
| Publisher name mismatch | Wrong PFX in `CSC_LINK` (e.g. dev cert used in a production build, or renewed cert with a different CN) |
| `osslsigncode verify` fails but Windows `signtool` passes | `osslsigncode` version <2.5 has stricter SHA-1 rejection; upgrade to ≥2.5 |
| `No signature verification tool found` on Linux | Run `apt-get install -y osslsigncode` in the build environment |

## Notes on macOS

- The auto-updater downloads the **zip** target from `electron-builder.yml`,
  not the DMG. Make sure both `dmg` and `zip` targets are present (they
  are by default).
- Apple notarization caches by bundle ID + version. If you re-build
  `9.9.1` repeatedly during testing, bump to `9.9.2`, `9.9.3`, etc., or
  the cached notarization ticket from the first build can mask
  signature-staple bugs.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Update check failed: ENOTFOUND 127.0.0.1` | App was launched without `UPDATE_FEED_URL` in env. |
| `404 Not Found` on `latest.yml` | `$FEED_DIR` is empty or `http-server` is serving the wrong dir. |
| `sha512 mismatch` in log | `latest.yml` is from an older build; rebuild step 2 with `$FEED_DIR` cleared first. |
| App downloads but never relaunches | On Windows, antivirus (esp. SmartScreen for unsigned builds) is blocking the swap — re-test with a signed build. |
| `Code signature at URL … did not pass validation` (macOS) | The new build is signed with a different certificate than the installed build. Re-sign both with the same identity. |

### Signed state-retention test record

Complete one record for each operating system. Leave a field blank until the
corresponding run has actually been performed; a blank record is not a pass.

| Field | Windows NSIS | macOS |
|---|---|---|
| Test date (UTC) |  |  |
| OS version/build and device architecture |  |  |
| Installer architecture | x64 | x64 or arm64 |
| Signing publisher / Developer ID team |  |  |
| N version and platform build number |  |  |
| N+1 version and platform build number |  |  |
| Release tag and workflow run URL |  |  |
| Update channel (`installer`) and feed type |  |  |
| Preference changed (hidden Cases column) |  |  |
| Still signed in after update (pass/fail) |  |  |
| Preference retained after update (pass/fail) |  |  |
| Updater errors absent (pass/fail) |  |  |
| Signature valid after update (pass/fail) |  |  |
| Overall result and tester initials |  |  |

The release workflow builds Windows and macOS with distinct platform build
numbers. Record the number assigned to each platform artifact, not just the
shared app version. Do not claim signed update state retention for an OS until
its completed record is attached to the release evidence.

---
