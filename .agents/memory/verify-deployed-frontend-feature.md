---
name: Verifying a feature is live in the deployed frontend
description: How to confirm whether prod actually serves new frontend code, and why "code looks correct but user sees old UI" is usually a stale client, not a bug.
---

# Verifying a feature is live on the deployed frontend

When a user reports a UI feature "missing"/"broken" but the source code is clearly
correct and the backing data is intact, the cause is almost always a **stale client
build**, not a code bug. Confirm before changing any code.

## How to check the live web bundle (Replit static artifacts)

The page code is **lazy-loaded into a per-route chunk**, NOT the top-level
`index-*.js`. Grepping `index.html`'s top-level script tags gives a **false
negative**.

1. `curl <prodURL>/<basePath>/` → get `index.html`, note the top-level
   `assets/index-*.js`.
2. `curl` that `index-*.js` and grep for `"assets/<route>-*.js"` references
   (e.g. `cases-*.js`) — these are the lazy chunks.
3. `curl` the **route chunk** and grep for a **distinctive string literal** from
   the feature (string literals survive minification; variable names do not).
   Pick a literal unique to the feature's commit, plus an older "control" literal
   to prove the chunk is the right one.

## The zero-dependency tell

A render path with **no external dependencies** (e.g. inline note text rendered
straight from API data) is the cleanest probe: if it's blank in the user's
screenshot but present in current code, the client is running an old bundle. Image
thumbnails can fail for auth/CORS reasons, but plain text cannot.

## Detecting a stale *server* deploy (API), not just a stale client

Same principle applies to the API server: "the fix is in the code but the user
(on prod) still sees the bug" is usually a **prod deploy that predates the fix**,
not a code bug. The mobile app points at prod, so server fixes that heal
already-installed apps (e.g. the CSRF cookie-jar rescue, legacy history
union-merge) do **nothing** until the API is republished.

**How to confirm the deployed commit without guessing:**
1. Pick a fix that logs a unique marker at startup or behaves observably
   (e.g. `legacy_case_media: ensure + backfill complete` proves that commit is
   live; a recently-uploaded case-media file serving 200 proves the
   object-storage durability mirror is live).
2. Compare against a fix that should also be live but isn't behaving
   (e.g. cookie-only mobile `POST`s still 403 in ~1ms ⇒ the CSRF rescue is absent).
3. Use `git log -S "<marker>" -- <file>` + `git merge-base --is-ancestor A B`
   and commit dates to bracket the deployed code between "has X, missing Y."
   If a needed fix is newer than the deployed bracket → **republish**, no code
   change and no new mobile build required.

## Web vs. installed desktop (Electron) distribution

**Why:** the Electron desktop app bundles its **own** copy of the frontend at
release time and updates via electron-updater / GitHub Releases. The web "Publish"
deploy does **not** touch installed desktop binaries. So a feature can be live on
the website yet absent in the installed desktop app.

**How to apply:** a screenshot in a native window (no browser chrome, OS close
button) = the installed desktop app → tell the user to update it
(Settings → Desktop App → Check for updates). A browser session → hard refresh to
drop the cached old chunk.
