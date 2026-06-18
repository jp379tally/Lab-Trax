# Auto-update end-to-end runbook

## Release trigger — two operating modes

### Mode A: Replit-native (active in this environment)

Auto-update is powered by the **generic** electron-updater provider. The
publish pipeline writes `latest.yml` (SHA-512 manifest) to App Storage and
serves it at `GET /downloads/latest.yml`. electron-builder bakes the feed
URL into `resources/app-update.yml` inside the packaged app so every
installed copy knows where to check for updates — **no `UPDATE_FEED_URL`
environment variable is required on the end-user's machine.**

The GitHub Actions auto-tag pipeline (`auto-tag-desktop-release.yml` +
`release.yml`) requires a GitHub remote and `BUILD_BOT_TOKEN` — **neither
is available in this Replit subrepl**. The effective release mechanism is:

| Path | When it fires |
|---|---|
| **Automatic** — `scripts/post-merge.sh` | After every merge whose diff (from `ORIG_HEAD` to `HEAD`) touches `artifacts/labtrax-desktop/**`, `lib/**`, or `artifacts/api-server/src/**` |
| **Manual** — "Desktop Build + Publish" Replit workflow | Restart from the workflow pane at any time |
| **CLI** — `bash scripts/desktop-build-publish.sh` | Run directly from the repo root |

All three paths:
1. Build the Vite renderer + electron-builder packager (produces `win-unpacked/`)
2. Zip `win-unpacked` → `LabTrax-Windows-Portable.zip` (~146 MB)
3. Generate `electron-dist/latest.yml` from the ZIP's SHA-512 digest
4. Upload ZIP + `latest.yml` to App Storage
5. Serve at `GET /downloads/LabTrax-Windows-Portable.zip` and `GET /downloads/latest.yml`
6. Bake `UPDATE_FEED_URL` (= `${BASE_URL}/downloads`) into `app-update.yml` inside the packaged app so electron-updater knows where to check for updates

**Skip a rebuild:** include `[skip desktop-release]` or `[skip ci]` in the merge commit subject.

**REGRESSION_GUARDRAILS.md** has the authoritative parity rule and step-by-step publish verification checklist.

---

### Mode B: GitHub Actions (requires GitHub remote + secrets)

Every merge to `main` automatically tags a new patch release via
`.github/workflows/auto-tag-desktop-release.yml`. That workflow:

1. Skips when only non-desktop paths (`docs/**`, `**.md`, mobile app,
   mockup sandbox, attached assets, EAS workflow, `.local/**`,
   `.agents/**`) changed, or when the head commit message contains
   `[skip desktop-release]` or `[skip ci]`.
2. Bumps the patch version in `artifacts/labtrax-desktop/package.json`,
   commits with `[skip ci]` (so the bump itself doesn't loop), tags
   `vX.Y.Z`, and pushes both using `BUILD_BOT_TOKEN` (a fine-grained PAT
   that can push to protected `main`).
3. The pushed tag fires `.github/workflows/release.yml` which builds
   Windows + macOS and **must** auto-publish to `/downloads/`. Both
   publish steps now exit non-zero (not silently 0) when
   `PLATFORM_ADMIN_SECRET` or `PUBLISH_API_BASE_URL` is missing — auto-
   release is the primary delivery path, so a missing secret is a real
   misconfiguration to surface, not a benign opt-out.

To pause auto-release temporarily, disable the
`auto-tag-desktop-release.yml` workflow in Actions → Workflows. To skip
a single merge, append `[skip desktop-release]` to the merge commit
message.

The runbook below verifies the *download / install swap* mechanics that
unit tests can't cover. Run it before any release that changes
`electron-builder.yml`, `electron/main.cjs` updater wiring, or the
publish provider.

---


This runbook verifies that a packaged LabTrax Desktop build will actually
download a newer version, swap binaries, and relaunch on the new version.
Unit tests cover the IPC wiring and `releaseNotes` shape handling, but they
stub `electron-updater`. Run this runbook before every major release to catch
regressions in `electron-builder` config (wrong publish provider, missing
`latest.yml`, signature mismatch, etc.) that unit tests cannot see.

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
Quit the app fully (Windows: right-click tray icon → Quit; macOS:
`Cmd-Q`). Auto-update only triggers on the next launch.

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
> `scripts/desktop-build-publish.sh`. The runtime env-var override is a
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
