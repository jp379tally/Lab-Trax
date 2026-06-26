---
name: Replitignore must not exclude runtime assets
description: node_modules, dist, build, static-build must stay OUT of .replitignore or the deployment container image is broken at runtime.
---

The rule: never add `node_modules`, `dist`, `build`, or `static-build` to `.replitignore`.

**Why:** `.replitignore` (identical format to `.dockerignore`) controls what gets included in the deployment container image snapshot taken after the build phase. If you exclude `dist/` or `static-build/`, the files the build phase just created are stripped from the image before the container starts. The run command (`node artifacts/api-server/dist/index.mjs`) fails immediately — file not found. If you exclude `node_modules/`, externalized esbuild packages (pdfkit, sharp, etc.) are unavailable at runtime.

The failure mode is subtle: the BUILD phase logs show everything succeeding (api-server bundle 6.4 MB, Metro iOS/Android bundles complete, Vite desktop build complete, image layers pushed), and then "Creating Autoscale service" appears in the log — but the container crashes silently with no runtime logs, and the promote step times out ~2 minutes later. No runtime logs appear because the server crashes before it can serve any request.

**How to apply:** Review `.replitignore` before any change that touches it. Safe exclusions:
- `.local` — agent-only files
- `.expo`, `.cache` — dev caches
- `electron-dist` — Electron installer output, shipped via App Storage/GitHub releases, not needed in the cloud container
- `attached_assets`, `logs` — static/log files not needed at runtime
- `*.zip`, `*.exe`, `*.dmg`, `*.msi`, `*.pkg`, `*.ipa`, `*.tar.gz` — installer binaries

Unsafe exclusions (will break the deployment):
- `node_modules` — externalized packages (pdfkit, sharp, fontkit, etc.) resolve from here at runtime
- `dist` — api-server production bundle lives here
- `build` — other build outputs
- `static-build` — labtrax mobile static files served by `server/serve.js`
