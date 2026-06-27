# Desktop Installer Download

Installers (`LabTrax-Windows-Portable.zip`, `LabTrax-Setup.exe`, `LabTrax.dmg`) are stored in App Storage and served at `GET /downloads/<filename>` (no auth). Object keys: `<PRIVATE_OBJECT_DIR>/desktop-installer/<filename>`.

To publish a new installer:
1. **Auto-tag desktop release (manual dispatch):** `.github/workflows/auto-tag-desktop-release.yml` is `workflow_dispatch`-only (the push trigger was removed). When run, it bumps the patch in `artifacts/labtrax-desktop/package.json`, commits with `[skip ci]`, tags `vX.Y.Z`, and pushes via `BUILD_BOT_TOKEN`. The tag fires `release.yml` → builds + publishes to `/downloads/`. An internal changed-files guard skips cleanly (no bump, no tag) when the changes since the last `v*` tag are confined to non-desktop paths (`artifacts/labtrax/**` mobile, `docs/`, `artifacts/mockup-sandbox/`, `.local/`), and also honors `[skip desktop-release]` / `[skip ci]` in the commit message. Because secrets cannot be referenced in any `if:` (GitHub raises `Unrecognized named-value: 'secrets'`, a startup failure), `ci.yml` gates its optional GCS storage-test steps via a preflight step that maps the secret into `env` and emits a non-secret `enabled` output (same pattern as `rotate-ci-key.yml`).
2. **In-app (manual):** Settings → Desktop App → "Choose installer and upload" → `POST /api/admin/desktop-installer/upload`
3. **CLI bootstrap:** `pnpm --filter @workspace/scripts run upload-desktop-installer`
4. **CI tag-push (manual override):** push a `v*` tag yourself to re-run `release.yml` for a specific commit.

The publish endpoint (`/publish`) accepts `X-Platform-Admin-Secret` without a user JWT so CI doesn't need an account. The Windows + macOS publish steps in `release.yml` now **fail loudly** (exit 1) when `PLATFORM_ADMIN_SECRET` or `PUBLISH_API_BASE_URL` is unset — auto-release on merge made silent skip a real foot-gun. A deduped alert email fires at most once per 6 h window for any publish failure or health-check failure. Full runbook: [`desktop-publish-pipeline.md`](desktop-publish-pipeline.md), [`../artifacts/labtrax-desktop/docs/auto-update-runbook.md`](../artifacts/labtrax-desktop/docs/auto-update-runbook.md).

End-users see the current installed version and a **Check for updates** button in Settings → Desktop App (admin-only). The card mirrors auto-updater state (checking / available / downloading / ready-to-install) and exposes **Restart & install** when a build is staged. IPC: `check-for-updates`, `download-update`, `get-update-state`, plus the `update-state` broadcast channel.

Auto-update channel for existing installs uses the **generic** electron-updater provider pointed at `GET /downloads/latest.yml` on the same App Storage-backed API server that serves the installer ZIPs. The feed URL is baked into `resources/app-update.yml` at build time by `scripts/desktop-build-publish.sh` (via `UPDATE_FEED_URL`). No GitHub remote or `GH_TOKEN` is required for auto-update to work.
