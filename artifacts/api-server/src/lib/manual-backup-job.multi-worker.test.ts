import { afterAll, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const maybe = process.env.DATABASE_URL ? describe : describe.skip;
const workerPath = fileURLToPath(new URL("./manual-backup-job.multi-worker.ts", import.meta.url));
const adminSecret = randomUUID();
const sessionHash = createHash("sha256").update(`shared-admin:${adminSecret}`).digest("hex");

function startWorker(args: string[]): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LABTRAX_ENABLE_DEMO_SEEDS: "false",
    LOG_LEVEL: "silent",
    PLATFORM_ADMIN_SECRET: adminSecret,
  };
  delete env.REPLIT_DEPLOYMENT;
  delete env.PRIVATE_OBJECT_DIR;
  return fork(workerPath, args, {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

function waitForMessage<T extends { type: string }>(
  child: ChildProcess,
  type: T["type"],
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for worker message: ${type}`));
    }, timeoutMs);
    const onMessage = (message: T & { error?: string }) => {
      if (message?.type === "worker_error") {
        cleanup();
        reject(new Error(`Worker failed: ${message.error ?? "unknown error"}`));
        return;
      }
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Worker exited before ${type} (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

maybe("manual backup cancellation across API workers", () => {
  let scratchDir: string | undefined;
  const children: ChildProcess[] = [];

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  it("stops and cleans a transfer owned by another worker without recording a successful backup", async () => {
    const { pool } = await import("@workspace/db");
    const { readBackupLiveStatus } = await import("./backup-live-status-store");
    const runId = randomUUID();
    scratchDir = await mkdtemp(path.join(os.tmpdir(), "manual-backup-worker-"));
    const partialOutput = path.join(scratchDir, "destination.partial");
    const owner = startWorker(["start", runId, "null", sessionHash, partialOutput]);
    children.push(owner);

    try {
      await waitForMessage(owner, "transfer_started", 45_000);
      await expect(access(partialOutput)).resolves.toBeUndefined();

      const canceller = startWorker(["cancel", runId, adminSecret]);
      children.push(canceller);
      const [cancelled] = await Promise.all([waitForMessage<{
        type: string;
        status: number;
        result: { ok?: boolean; state?: string };
      }>(canceller, "cancel_result", 45_000),
      waitForMessage(owner, "transfer_stopped", 45_000)]);
      expect(cancelled.status).toBe(200);
      expect(cancelled.result).toMatchObject({ ok: true, state: "cancelled" });

      await expect(access(partialOutput)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readBackupLiveStatus(runId)).toMatchObject({
        runId,
        state: "cancelled",
        phase: "backup cancelled",
      });
      const history = await pool.query(
        "SELECT count(*)::int AS count FROM backup_runs WHERE download_run_id = $1",
        [runId],
      );
      expect(history.rows[0].count).toBe(0);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
      await pool.query("DELETE FROM backup_live_status WHERE run_id = $1::uuid", [runId]);
    }
  }, 75_000);
});
