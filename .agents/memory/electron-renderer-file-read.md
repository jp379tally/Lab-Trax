---
name: Electron renderer can't read local files via fetch
description: Why desktop file pickers silently fail and how to read picked files correctly
---

# Electron renderer file reads

The labtrax-desktop renderer cannot read local files by path. `fetch("file://" + path)`
is blocked by the renderer's security policy and rejects — if that rejection is swallowed
(e.g. `.catch(() => null)`), the picked file silently never loads and the UI looks frozen
("I picked a file and nothing happened").

**Rule:** After picking a path with the open dialog, read the bytes in the **main process**
over IPC (e.g. a `dialog:read-file` handler that `fs.readFileSync`s the path and returns an
`ArrayBuffer`), then build a `File`/`Blob` in the renderer. Never read local paths from the
renderer directly.

**Why:** A real backup-restore bug — the "Choose backup file…" picker in Settings → Restore
loaded nothing because it used `fetch("file://…")`. The fix routes reads through preload IPC.

**How to apply:** Any desktop feature that needs a user-picked local file's contents. Also
surface read failures to the user (set an error state) rather than swallowing them, and add
the new IPC channel name to the `ipc-smoke.test.ts` expected-channels allowlist or that test
fails on "unexpected channel".
