# Desktop installer publish pipeline — audit & runbook

_Last reviewed: 2026-05-22 (Task #749 — pipeline structural fix.)_

This document maps the **end-to-end pipeline** that takes a tagged commit and
turns it into a downloadable, auto-updating LabTrax Desktop installer. It
exists so the next on-call admin can debug a "the download is broken" report
in minutes instead of spelunking through three GitHub Actions workflows, two
storage backends, and five API endpoints.

## Pipeline stages

```
   ┌──────────────┐      ┌──────────────────┐      ┌─────────────────┐
   │ git push tag │ ───▶ │ GitHub Actions   │ ───▶ │ electron-builder│
   │   v1.2.3     │      │ build-{win,mac}  │      │  .exe / .dmg    │
   └──────────────┘      └──────────────────┘      └────────┬────────┘
                                                            │
                  ┌─────────────────────────────────────────┴─────────┐
                  │                                                   │
                  ▼                                                   ▼
   ┌──────────────────────────────┐               ┌──────────────────────────────┐
   │ POST /admin/desktop-installer│               │ Upload to GitHub Release     │
   │       /publish               │               │  (latest.yml + .exe + .blockmap) │
   │  → uploads to App Storage    │               │  → electron-updater feed      │
   │  → writes system_settings    │               └──────────────┬───────────────┘
   │  → records installer_uploads │                              │
   │  → records installer_changelog                              │
   └──────────────┬───────────────┘                              │
                  │                                              │
                  ▼                                              ▼
   ┌──────────────────────────────┐               ┌──────────────────────────────┐
   │ GET /downloads/LabTrax-…     │               │ existing installs auto-update│
   │ (served by serveInstaller    │               │  via electron-updater on     │
   │  in app.ts; ETag, range, 304)│               │  next launch                  │
   └──────────────────────────────┘               └──────────────────────────────┘
                  │                                              │
                  └──────────────┬───────────────────────────────┘
                                 ▼
                  ┌──────────────────────────────┐
                  │ GET /admin/desktop-installer │
                  │       /health (scheduled)    │
                  │  → HEAD download URL          │
                  │  → fetch GH Release manifest  │
                  │  → compare versions           │
                  │  → emit single dedup'd alert  │
                  └──────────────────────────────┘
```

## Two independent delivery channels — and why both exist

| Channel | Audience | Source of truth | Triggered by |
|---|---|---|---|
| **`/downloads/` on the API server** | New installs (admins click "Download for Windows / macOS" in Settings → Desktop App) | `system_settings.desktop_installer_url` + App Storage objects under `<PRIVATE_OBJECT_DIR>/desktop-installer/` | CI auto-publish or manual upload via Settings |
| **GitHub Release (`latest.yml` / `latest-mac.yml`)** | Existing installs (electron-updater) | The latest GitHub Release on the configured repo, fetched by the `electron-updater` GitHub provider | CI publish-release job, only on tag pushes |

> **Why two channels?** electron-updater's GitHub provider is well-supported and
> requires no auth, so it's the natural fit for auto-updating existing
> installs. But fresh installs need a friendly URL like
> `https://your.replit.app/downloads/LabTrax-Setup.exe`, which is what
> `/downloads/` provides. The two channels are kept in sync by always
> publishing both for every tagged release.

A skew between these two channels (e.g. `/downloads/` serves v1.2.3 but the
GitHub Release only has v1.2.2) is the most common failure mode and is what
the health check below detects.

## Server endpoints

All endpoints listed below live under `/api` and are registered in
`artifacts/api-server/src/routes/labtrax-routes.ts`.

| Method | Path | Caller | Purpose |
|---|---|---|---|
| GET | `/desktop-installer` | Any logged-in user | Public install metadata shown in Settings → Desktop App |
| GET | `/admin/settings/desktop-installer` | Platform admin | Full settings view (includes installer status badge, build-counter warning) |
| POST | `/admin/desktop-installer/upload` | Platform admin (UI or CI) | Upload an installer binary to App Storage (no settings write) |
| PUT | `/admin/settings/desktop-installer` | Platform admin | Update active download URL / version / release notes |
| **POST** | **`/admin/desktop-installer/publish`** | **Platform admin (CI preferred)** | **Atomic: upload + settings + changelog in one multipart call. Use this from CI.** |
| **GET** | **`/admin/desktop-installer/health`** | **Platform admin or scheduled job** | **End-to-end pipeline health check (storage, settings, GitHub Release).** |
| POST | `/admin/desktop-installer/publish-failure` | CI | Legacy per-step alert receiver. Now deduplicated by payload hash to avoid email storms. |
| GET | `/admin/settings/desktop-installer/history` | Platform admin | Per-version publish history (CI vs. manual) |
| GET | `/admin/desktop-installer/uploads` | Platform admin | Per-upload history (checksum, size, who) |

### Why `/publish` exists

The original CI flow was three separate HTTP calls:

1. `POST /admin/desktop-installer/upload` (binary)
2. `PUT  /admin/settings/desktop-installer` (json: url, version, notes)
3. `POST /admin/desktop-installer/publish-failure` (on any non-2xx above)

This was non-atomic: a successful upload followed by a failed settings PUT
left App Storage holding the new binary but `system_settings` still pointing
at the old version — a "silent broken release" failure mode. The new
`/publish` endpoint does both writes inside one request and rolls forward
cleanly: if the settings write fails after a successful upload, the
client gets one consolidated error context (stage + http status + message)
and the audit log records exactly what happened.

CI workflows now use `/publish`. The legacy `upload` and `settings` PUT
endpoints remain for backwards compat (manual UI flow still uses them
separately because the admin upload-then-save UX is more forgiving — a
partial save with a re-upload to follow is fine when a human is in the
loop).

### `publish-failure` deduplication

The legacy alert receiver kept emailing on every CI re-run, so a flaky
release would dispatch the same alert 3-5 times. The receiver now hashes
`(stage, workflow, version, http status, error first 200 chars)` and
suppresses identical alerts within a 6-hour window via the
`installer_publish_alert_last` row in `system_settings`. Distinct failures
still alert immediately; resolved-and-resumed-then-broken-again loops still
alert.

## Health check

`GET /admin/desktop-installer/health` runs three probes in parallel and
returns a single JSON report:

```jsonc
{
  "ok": false,
  "checkedAt": "2026-05-22T08:00:00.000Z",
  "settings":   { "version": "1.2.3", "downloadUrl": "/downloads/LabTrax-Setup.exe", "activeKind": "exe" },
  "storage":    { "ok": true, "size": 184320512, "uploadedAt": "...", "etag": "..." },
  "download":   { "ok": true, "status": 200, "contentLength": 184320512, "etagMatchesStorage": true },
  "githubRelease": {
    "ok": false,
    "configured": true,
    "tagName": "v1.2.2",
    "publishedAt": "...",
    "manifestUrl": "https://github.com/.../releases/download/v1.2.2/latest.yml",
    "hasManifest": true,
    "issue": "GitHub Release tag (v1.2.2) is older than the live download (v1.2.3) — existing installs cannot auto-update."
  },
  "issues": [
    "GitHub Release tag (v1.2.2) is older than the live download (v1.2.3) — existing installs cannot auto-update."
  ]
}
```

The check is read-only and safe to call on demand. A scheduled job runs it
once per day (at `INSTALLER_HEALTH_HOUR_UTC`, default `8`) and emails admins
through the same dedup'd path as `publish-failure` — see "Single alert" below.

## Single consolidated alert (deduped)

All paths that previously emailed admins (CI step failures, scheduled health
check) now route through one helper:

  `dispatchInstallerAlert(...)` in `lib/desktop-installer-alerts.ts`

It:

1. Builds a deterministic hash of the alert payload's identity fields.
2. Looks up the last alert row (`installer_publish_alert_last` in
   `system_settings`).
3. If hash matches **and** the row is fresher than 6 hours, skips email.
4. Otherwise, sends one email via `sendInstallerPublishFailureAlertEmail`
   and records the new hash + timestamp.

This collapses what used to be up to **6 separate alerts per failed CI run**
(Windows upload, Windows settings, macOS upload, macOS settings, build-number-commit, health
check) into at most one per 6-hour window per distinct failure.

## Top failure modes (RCs)

| RC | Failure mode | Detection | Root-cause fix |
|---|---|---|---|
| **RC1** | Upload succeeds but settings PUT fails → App Storage has new bytes, settings still point at old version → `/downloads/...` serves a stale file. | Health check `download.etagMatchesStorage=false` or `settings.version !== storage object header`. | Atomic `/publish` endpoint — both writes in one transaction; the client sees one error context. |
| **RC2** | `/downloads/...` serves v1.2.3 but the latest GitHub Release is still v1.2.2 → fresh installs work, existing installs never see the update. | Health check `githubRelease.tagName !== settings.version`. | Health check emits a single deduped alert; CI workflow's `publish-release` job runs in `needs: [build-windows, build-macos]` to guarantee both channels publish together. |
| **RC3** | CI failure alert spam — every failed step in build-windows.yml, build-macos.yml, and release.yml posted to `/publish-failure`, sometimes 4-6 emails per run. | Inbox volume. | `publish-failure` now hashes + dedupes within 6 hours; CI uses single `/publish` call so partial-failure noise is gone. |

## Runbook: "the desktop download is broken"

1. Open **Settings → Desktop App → Pipeline health** and click **Run health
   check**. The report tells you which stage is broken.
2. If `storage.ok=false` → App Storage / Object Storage is misconfigured.
   Re-provision and re-upload via the in-app uploader.
3. If `download.ok=false` but `storage.ok=true` → the API server can't read
   from App Storage. Check API server logs for credentials errors.
4. If `download.ok=true` but `download.etagMatchesStorage=false` → the
   served bytes differ from storage metadata (very rare, indicates a
   cached/proxied stale copy). Hard-refresh and check the proxy layer.
5. If everything else is `ok` but `githubRelease.tagName` is older than
   `settings.version` → the publish-release job in `release.yml` failed to
   attach assets to the GitHub Release. Re-run that job from the Actions
   tab; existing installs will auto-update on their next launch.

## Where to make pipeline changes

- **Add a new installer kind (e.g. Linux .AppImage):** `desktop-installer-storage.ts`
  → add to `INSTALLER_KIND_CONFIG`; `app.ts` → add a `serveInstaller(...)`
  route; `labtrax-routes.ts` → extend the file-validation switch in the
  upload handler; CI workflow → add a publish step that POSTs to
  `/admin/desktop-installer/publish`.
- **Change the dedup window:** `desktop-installer-alerts.ts` →
  `ALERT_DEDUP_WINDOW_MS` constant.
- **Change health check schedule:** `INSTALLER_HEALTH_HOUR_UTC` env var
  (default `8`).
- **Disable auto-publish from CI entirely:** unset `PLATFORM_ADMIN_SECRET`
  or `PUBLISH_API_BASE_URL` in the GitHub Actions secrets. The publish
  step logs `::notice::` and exits 0.
