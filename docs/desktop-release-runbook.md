# Desktop Release Runbook

## Overview

LabTrax Desktop (the installed Electron app) is a **separate build from the web app**. Republishing the API server or web preview updates the web app and mobile app only — it has **no effect** on existing Electron installs. The desktop app auto-updates itself via electron-updater, but only from a new installer that was built and published via the pipeline below.

---

## When to Run a Desktop Release

Run a desktop release when you want installed users to receive:
- New features or bug fixes (code changes)
- A corrected update feed (e.g., a stale `latest.yml`)
- A security patch

A web-only Publish is sufficient when only the web app UI is changing and no desktop-specific code changed.

---

## Release Steps

### 1 — Approve and trigger the build

```sh
# One-shot sentinel: the build script is a no-op unless this file exists.
touch .local/.eas-build-approved

# Then start (or restart) the "Desktop Build + Publish" workflow in Replit.
# The script reads .local/.eas-build-approved, deletes it immediately, and
# proceeds with the paid build. A stray Replit Run press is harmless because
# the sentinel is already gone.
```

The build script (`scripts/desktop-build-publish.sh`) runs:
1. `pnpm --filter @workspace/labtrax-desktop run build` — Vite + Electron builder
2. Signs the resulting installer (macOS DMG or Windows NSIS)
3. Uploads the installer and `latest.yml` feed to App Storage via `GET /api/admin/settings/desktop-installer`
4. Bumps and commits the build counter (see `docs/build-counter-recovery.md` if this push fails)

### 2 — Verify the feed

After the script finishes, confirm the auto-update feed is reachable:

```sh
curl -s https://lab-trax.replit.app/api/downloads/latest.yml
```

The response must be a valid `latest.yml` referencing the new version.

### 3 — Smoke-test an existing install

On a machine running the previous version, wait up to 4 hours for the background poll, or manually trigger:  
**Settings → Desktop app → Check for updates**

The Settings panel shows the current version, update status (idle / checking / available / downloading / downloaded), and the **Restart & install** button once the update is ready. This panel is always visible (not transient) so you can confirm the update is in-progress at any time.

---

## When a One-Time Reinstall Is Required

Auto-update requires a running Electron build that was already built with the auto-updater configured (i.e., it has a baked-in `app-update.yml` pointing at the feed). Builds created before the auto-updater was wired cannot pull updates automatically.

If a staff member's Electron app cannot update itself:
1. Direct them to **Settings → Desktop app** → Download the latest installer link
2. Quit the old app and run the new installer
3. After that one reinstall, all future updates arrive automatically

---

## Confirming Future Auto-Updates Arrive

1. Note the current version shown in **Settings → Desktop app**.
2. After a new build is published, the update check runs automatically every 4 hours.
3. Manually trigger: **Settings → Desktop app → Check for updates**.
4. Status changes: idle → checking → available → downloading → downloaded → the **Restart & install** button appears.
5. After restarting, confirm the new version is shown in **Settings → Desktop app**.

---

## Regression Guardrails

Before any release, run the full pre-release checklist from `REGRESSION_GUARDRAILS.md`. Key automated checks relevant to the desktop build:

| Check | Command |
|---|---|
| Desktop typecheck | `pnpm --filter @workspace/labtrax-desktop run typecheck` |
| Desktop unit tests | `pnpm --filter @workspace/labtrax-desktop run test` |
| Signing verification | `bash scripts/test-signing-verification.sh` |
| Latest.yml feed guard | `pnpm --filter @workspace/scripts run test` |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Update check shows "auto-update disabled (dev build)" | Running in Electron dev mode or `LABTRAX_SKIP_AUTOUPDATER=1` | Use the packaged installer, not the dev Electron launch |
| "Check for updates" returns error immediately | Build was packaged without a baked-in `app-update.yml` | Rebuild via the pipeline; the feed URL must be baked in at build time |
| No update after publishing | Feed URL unreachable, or wrong version in `latest.yml` | `curl` the feed URL; check the installer slot via Settings → Desktop app (admin view) |
| Staff machine shows old version after reinstall | Installed the old `.exe`/`.dmg` again | Re-download from the latest installer link in Settings → Desktop app |
