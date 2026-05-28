---
name: Installer e2e tests share one live storage slot
description: Why installer-publish-e2e and installer-storage-e2e must be serialized, not run in parallel
---

# Installer e2e tests share one live App Storage slot

The api-server installer e2e suites (`installer-publish-e2e.test.ts`,
`installer-storage-e2e.test.ts`) both snapshot/overwrite/download/restore the
**same fixed** App Storage object key (`<PRIVATE_OBJECT_DIR>/desktop-installer/
LabTrax-Setup.exe`). Vitest runs files in parallel forks (`pool: "forks"`,
`maxForks: 4`), so when both are enabled (PRIVATE_OBJECT_DIR +
PLATFORM_ADMIN_SECRET set) they race: one reads back the other's bytes (wrong
size) or hits a 503 after the other deletes the object mid-flight.

**Rule:** these two suites must be mutually exclusive. They serialize on a
shared filesystem advisory lock (`installer-e2e-lock.ts`) acquired in
`beforeAll` / released in `afterAll`.

**Why:** the publish endpoint writes a fixed object key — the slot can't be
parameterized per-suite without changing production code. The failure is flaky
(passes in isolation / when forks happen not to overlap), so a green local run
does NOT prove it's fixed; the race only surfaces under fork contention.

**How to apply:** any new test that touches the live desktop-installer slots
must take the same lock, or use a dedicated test bucket / per-run prefix. Don't
"fix" a flaky size/503 assertion by loosening it — check for slot contention.
