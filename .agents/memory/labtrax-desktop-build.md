---
name: LabTrax Desktop build on Replit
description: How to build & republish the Windows portable zip from Replit (no Wine), and the gotchas that brick the renderer.
---

## Building the Windows portable zip on Replit (no Wine)

The pnpm script `electron:build` in `artifacts/labtrax-desktop` is reliable on a Mac/Windows host but has two failure modes in this Replit environment.

1. **The pnpm script silently dies if backgrounded with `nohup`/`setsid`/`&`.**
   Even with `disown`, the child `pnpm run electron:build` exits seconds after the parent bash returns, often with no log output. Run vite + electron-builder in the foreground (one bash call per stage, each within the 120s timeout) instead of trying to background the whole script.

2. **`electron-builder --win` always errors out with `wine is required` after producing `electron-dist/win-unpacked/`.** The "failure" happens at the NSIS packaging step — the `win-unpacked` directory (with a working `LabTrax.exe`) is already on disk. Zipping that directory into `LabTrax-Windows-Portable.zip` is the entire deliverable for the portable channel.

Working sequence from project root:

```bash
cd artifacts/labtrax-desktop && rm -rf dist electron-dist \
  && VITE_API_BASE_URL=https://lab-trax.replit.app \
     VITE_APP_VERSION=$(node -p "require('./package.json').version") \
     VITE_COMMIT_SHA=$(git rev-parse --short HEAD) \
     VITE_BUILD_NUMBER=$(node -p "require('./build-number.json').buildNumber+1") \
  pnpm exec vite build --config vite.electron.config.ts
# electron-builder is expected to exit 1 with "wine is required" — that is fine,
# win-unpacked is produced before NSIS runs.
pnpm exec electron-builder --win --config electron-builder.yml || true
# Then zip win-unpacked → electron-dist/LabTrax-Windows-Portable.zip via the
# archiver-based snippet (same logic as scripts/electron-build.mjs zipUnpacked()).
pnpm --filter @workspace/scripts run upload-desktop-installer
```

## `VITE_API_BASE_URL` must be baked in at build time

The renderer in production runs at `app://labtrax`, which is cross-origin to the API. If `VITE_API_BASE_URL` is not set when the vite electron bundle is built, `_API_ORIGIN` ends up empty and every fetch hits `app://labtrax/api/...` — Electron cannot resolve that scheme, so the user sees "Failed to fetch" on the login screen and nothing else works.

`scripts/electron-build.mjs` exits 1 if the var is missing, but manual `vite build` calls don't. A defensive runtime fallback to the production URL exists in `src/lib/api.ts`, scoped to Electron only (so same-origin web builds still get relative paths). Treat the fallback as a safety net, not a substitute — every build should still bake in the right URL explicitly.

## electron-builder >=26 schema changes that broke `electron-builder.yml`

When bumping `electron-builder` past v25 the config will fail validation with `ValidationError` until you migrate:
- `win.signingHashAlgorithms` and `win.rfc3161TimeStampServer` move under `win.signtoolOptions`.
- `mac.notarize` becomes a boolean. Team ID comes from `APPLE_TEAM_ID` (env) or the cert.

`win-unpacked` is never produced if validation fails, so the "wine required" path can't save you — the whole pipeline aborts before packaging.

## Republishing the zip to App Storage

`pnpm --filter @workspace/scripts run upload-desktop-installer` uses the Replit sidecar OAuth path (`gcs.bucket.file.save`) and works without `PLATFORM_ADMIN_SECRET`. The download endpoint `/downloads/LabTrax-Windows-Portable.zip` then 302s users straight to GCS with a short-lived access token. Verify with `curl -sI -L` against the prod domain — `content-length` should match the uploaded byte count exactly.
