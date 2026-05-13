# Recovery runbook — Desktop "Failed to fetch" on the login screen

This runbook captures the May 2026 diagnosis behind task #408 and the
recovery path to hand to any user still hitting "Failed to fetch" on the
LabTrax Desktop login screen. Two prior tasks (#317, #400) shipped fixes
for this same symptom but it kept resurfacing, so this document records
exactly what was wrong and how to verify before sending the user another
"please reinstall" message.

## What the diagnosis actually found (May 2026)

Three failure modes were possible (see task #408 description). Live
production probes ruled out two of them and pinned down the real one:

1. **Server CORS — RULED OUT.** A real preflight against the deployed
   API confirmed CORS for `app://labtrax` is correct:

   ```sh
   curl -sI -X OPTIONS \
     -H "Origin: app://labtrax" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: content-type,authorization" \
     "https://<your-deployment>/api/auth/login"
   ```

   Returned (truncated):

   ```
   HTTP/2 204
   access-control-allow-credentials: true
   access-control-allow-headers: content-type,authorization
   access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE
   access-control-allow-origin: app://labtrax
   vary: Origin, Access-Control-Request-Headers
   ```

   The CORS allowlist in `artifacts/api-server/src/lib/cors.ts` is
   in place and live.

2. **Stale local copy on the user's machine — POSSIBLE, treat in
   recovery.** Even with a fresh server and fresh hosted installer,
   any user who installed before the fix shipped is still on the
   broken bundle until they uninstall + reinstall.

3. **Stale / broken hosted installer — CONFIRMED ROOT CAUSE.** A HEAD
   against the live `/downloads/LabTrax-Setup.exe` returned a 200 with
   `content-length: 64`. The "installer" served from that URL was a
   64-byte file containing only the `MZ` PE header — i.e. a
   placeholder, not a real installer at all. Anyone clicking that
   link got an unusable file, which is exactly what produces a "Failed
   to fetch" experience: the install completes (it's 64 bytes, of
   course it does), the renderer launches a broken bundle, and every
   API request fails. The portable ZIP at
   `/downloads/LabTrax-Windows-Portable.zip` was a real 151 MB build
   from the same period, so users who took the ZIP path were fine.

   **Fix applied in this task:** the broken stub was deleted from
   App Storage. `/downloads/LabTrax-Setup.exe` now returns:

   ```
   HTTP/2 404
   content-type: application/json; charset=utf-8

   {"ok":false,"message":"The Windows installer has not been
   uploaded yet. An admin must upload LabTrax-Setup.exe via
   Settings → Desktop App."}
   ```

   That is strictly better than serving a 64-byte file: users now
   get a clear error and a recovery hint instead of a broken
   install. A real signed `.exe` must be republished by re-running
   the GitHub Actions Windows release job (`.github/workflows/release.yml`)
   or by an admin uploading a freshly-built EXE through Settings →
   Desktop App. This is tracked as a follow-up task.

## How we'll catch this faster next time

`artifacts/labtrax-desktop/src/pages/login.tsx` now renders a small
muted line on the login screen below the existing Server URL:

```
Build: vX.Y.Z · <short-sha>
```

The version + commit SHA are baked in at packaging time by
`artifacts/labtrax-desktop/scripts/electron-build.mjs`, which threads
`VITE_APP_VERSION` and `VITE_COMMIT_SHA` through Vite. Any future
"Failed to fetch" screenshot now tells us immediately whether the
user is on a fresh build or a stale local copy — no more guessing
across multi-day support loops.

## Re-running the diagnosis on demand

The same checks are scripted in
`scripts/src/diagnose-desktop-installer.ts`, so anyone can re-verify
the live environment in one command:

```sh
PUBLISH_API_BASE_URL=https://<your-deployment> \
  pnpm --filter @workspace/scripts run diagnose-desktop-installer
```

It performs the CORS preflight from `Origin: app://labtrax`, HEADs
each of the three installer slots (EXE / portable ZIP / DMG), and
prints a verdict for each so a stale or stub artifact can be spotted
in seconds.

## Recovery steps to send the user (Windows)

Short, non-technical, copy-pasteable:

> 1. Open **Settings → Apps → Installed apps**, find **LabTrax**,
>    and click **Uninstall**. Confirm the uninstall.
> 2. Download the working build:
>    `https://<your-deployment>/downloads/LabTrax-Windows-Portable.zip`
> 3. Right-click the downloaded ZIP → **Extract All…** Make sure to
>    extract the **entire LabTrax folder**, not just `LabTrax.exe`
>    on its own.
> 4. Open the extracted **LabTrax** folder and double-click
>    **LabTrax.exe**.
> 5. On the sign-in screen, look for the small grey line at the
>    bottom that says **Build: v…**. As long as that line is
>    present and the version matches the latest release, you're on
>    the fixed build. Sign in with your normal LabTrax account.

The Windows one-click installer (`LabTrax-Setup.exe`) is offline
until the next CI release republishes it — the portable ZIP is the
recommended download in the meantime.

## Recovery steps for macOS

> 1. Quit LabTrax and drag the LabTrax app from **Applications** to
>    the Trash.
> 2. Empty the Trash.
> 3. Download the latest DMG from `https://<your-deployment>/downloads/LabTrax.dmg`.
> 4. Open the DMG and drag LabTrax into **Applications**.
> 5. Open LabTrax from the Applications folder and confirm the
>    **Build: v…** line appears under the sign-in form.
