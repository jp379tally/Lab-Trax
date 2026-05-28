/**
 * Cross-process advisory lock for the installer end-to-end suites.
 *
 * `installer-publish-e2e.test.ts` and `installer-storage-e2e.test.ts` both
 * snapshot, overwrite, download, and restore the single shared "exe" slot in
 * live App Storage (object key `<PRIVATE_OBJECT_DIR>/desktop-installer/
 * LabTrax-Setup.exe`). Vitest runs test files in parallel forks
 * (`pool: "forks"`, `maxForks: 4`), so when both suites are enabled they race:
 * one suite reads back the other's bytes (wrong size) or hits a 503 after the
 * other deletes the object mid-flight.
 *
 * The object key is fixed by the production publish endpoint, so the slot
 * cannot be parameterized per-suite. Instead, both suites serialize on this
 * filesystem mutex: acquire at the start of `beforeAll`, release at the end of
 * `afterAll`. The lock lives in the OS temp dir so it is shared across forks.
 */
import { writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_PATH = path.join(os.tmpdir(), "labtrax-installer-e2e.lock");

/** Lock is considered stale (orphaned by a crashed fork) after this long. */
const STALE_MS = 90_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Block until the installer-storage lock is acquired. Polls with jittered
 * backoff. Reclaims a stale lock left behind by a crashed fork so a single
 * failure can't deadlock the whole suite.
 *
 * @param timeoutMs give up after this long and throw (kept under the 30s
 *   vitest hookTimeout's budget headroom by the caller's expectations).
 */
export async function acquireInstallerE2ELock(timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await writeFile(LOCK_PATH, `${process.pid}:${Date.now()}`, { flag: "wx" });
      return;
    } catch {
      // Lock held by another fork. Reclaim it if it is stale.
      try {
        const s = await stat(LOCK_PATH);
        if (Date.now() - s.mtimeMs > STALE_MS) {
          await rm(LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between the failed write and the stat — retry now.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `[installer-e2e-lock] timed out after ${timeoutMs}ms waiting for ${LOCK_PATH}`,
        );
      }
      await sleep(75 + Math.random() * 150);
    }
  }
}

/** Release the lock. Safe to call even if the lock was never held. */
export async function releaseInstallerE2ELock(): Promise<void> {
  await rm(LOCK_PATH, { force: true });
}
