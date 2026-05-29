---
name: Installer e2e tests use per-run storage isolation
description: How installer-publish-e2e and installer-storage-e2e avoid touching the live installer slot
---

# Installer e2e tests isolate storage per-run

The api-server installer e2e suites (`installer-publish-e2e.test.ts`,
`installer-storage-e2e.test.ts`) exercise REAL App Storage. They are gated on
`INSTALLER_E2E_OBJECT_DIR` + `PLATFORM_ADMIN_SECRET` and **never read the
production `PRIVATE_OBJECT_DIR` directly**. When `INSTALLER_E2E_OBJECT_DIR` is
set, `applyInstallerE2EStorageTarget()` (`installer-e2e-target.ts`) overrides
`process.env.PRIVATE_OBJECT_DIR` to a unique per-run prefix
(`<INSTALLER_E2E_OBJECT_DIR>/e2e-run-<pid>-<ts>-<rand>`) for that fork, then
restores it in `afterAll`.

**Rule:** anything touching the live desktop-installer slots in a test must use
`applyInstallerE2EStorageTarget()` (or an equivalent dedicated, non-production
target), never the raw `PRIVATE_OBJECT_DIR`.

**Why:** the publish endpoint writes a fixed object key
(`<PRIVATE_OBJECT_DIR>/desktop-installer/LabTrax-Setup.exe`), so two suites
sharing one `PRIVATE_OBJECT_DIR` raced (wrong-size read-back, or 503 after the
other deleted mid-flight) and could overwrite the real installer. Per-run
prefixes make both problems structurally impossible — each run gets its own
empty prefix, so there's nothing to snapshot/restore and no shared lock. The
prior `installer-e2e-lock.ts` advisory lock was removed.

**How to apply:** override the storage target per fork (env-based) rather than
serializing or loosening flaky size/503 assertions. The override relies on
`desktop-installer-storage.ts` reading `PRIVATE_OBJECT_DIR` lazily on each call;
keep that property if you refactor the storage layer.
