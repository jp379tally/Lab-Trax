/**
 * Per-run storage isolation for the installer end-to-end suites.
 *
 * `installer-storage-e2e.test.ts` and `installer-publish-e2e.test.ts` exercise
 * REAL App Storage. To keep them safe to run *anywhere* — including a
 * developer's Replit workspace where `PRIVATE_OBJECT_DIR` points at the
 * production bucket — they never read `PRIVATE_OBJECT_DIR` directly. Instead
 * they are gated on a dedicated, non-production storage target supplied via
 * the `INSTALLER_E2E_OBJECT_DIR` env var and write under a unique per-run
 * prefix beneath it.
 *
 * Two properties fall out of this:
 *  1. The suites can never overwrite the live desktop installer, because they
 *     only ever touch `INSTALLER_E2E_OBJECT_DIR/...`, never the production
 *     `PRIVATE_OBJECT_DIR`. When `INSTALLER_E2E_OBJECT_DIR` is unset the suites
 *     skip entirely.
 *  2. Every run/fork gets its own object prefix, so the two suites can never
 *     collide on the same object key. This replaces the cross-process advisory
 *     lock the suites previously shared with true per-run isolation.
 *
 * The production storage layer (`lib/desktop-installer-storage.ts`) reads
 * `process.env.PRIVATE_OBJECT_DIR` lazily on every call, so pointing the suite
 * at its isolated target is done by overriding that env var in-process for the
 * duration of the test file. Vitest runs each test file in its own fork, and
 * the override is restored in `afterAll`, so it never leaks into other suites.
 */

const E2E_DIR_ENV = "INSTALLER_E2E_OBJECT_DIR";

export interface InstallerE2ETarget {
  /** The isolated per-run object dir now active as `PRIVATE_OBJECT_DIR`. */
  dir: string;
  /** Restore `PRIVATE_OBJECT_DIR` to its pre-override value. */
  restore: () => void;
}

/**
 * Point the production storage layer at a unique per-run object dir beneath
 * `INSTALLER_E2E_OBJECT_DIR` by overriding `process.env.PRIVATE_OBJECT_DIR`.
 *
 * Returns the applied target plus a `restore()` to undo the override, or
 * `null` when no dedicated test target is configured (the suite should skip).
 */
export function applyInstallerE2EStorageTarget(): InstallerE2ETarget | null {
  const base = process.env[E2E_DIR_ENV];
  if (!base) return null;

  const previous = process.env.PRIVATE_OBJECT_DIR;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = `${trimmed}/e2e-run-${runId}`;
  process.env.PRIVATE_OBJECT_DIR = dir;

  return {
    dir,
    restore: () => {
      if (previous === undefined) {
        delete process.env.PRIVATE_OBJECT_DIR;
      } else {
        process.env.PRIVATE_OBJECT_DIR = previous;
      }
    },
  };
}
