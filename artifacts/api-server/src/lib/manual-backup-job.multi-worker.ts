import { access, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readBackupLiveStatus } from "./backup-live-status-store";
import { BackupCancelledError } from "./backup-phase";
import {
  finishManualBackupJob,
  registerManualBackupCleanup,
  startManualBackupJob,
} from "./manual-backup-job";

const [mode, runId, userId, sessionHash, partialOutput] = process.argv.slice(2);

function send(message: Record<string, unknown>): void {
  if (process.send) process.send(message);
}

async function run(): Promise<void> {
  const { pool } = await import("@workspace/db");
  if (mode === "start") {
    const cleanup = async () => rm(partialOutput, { force: true });
    let resolveTransferStopped!: () => void;
    const transferStopped = new Promise<void>(resolve => { resolveTransferStopped = resolve; });
    await startManualBackupJob(runId, {
      destination: "network",
      archiveKind: "full",
      source: "development",
      actor: "synthetic-multi-worker-test",
    }, userId === "null" ? null : userId, sessionHash, async signal => {
      await writeFile(partialOutput, "synthetic partial destination transfer");
      registerManualBackupCleanup(runId, cleanup);
      send({ type: "transfer_started" });
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          resolveTransferStopped();
          reject(new BackupCancelledError());
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    });

    await transferStopped;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [status, outputExists] = await Promise.all([
        readBackupLiveStatus(runId),
        access(partialOutput).then(() => true, () => false),
      ]);
      if (status?.state === "cancelled" && !outputExists) {
        finishManualBackupJob(runId);
        send({ type: "transfer_stopped" });
        await pool.end();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("The manual backup did not reach its cancelled terminal state.");
  }

  if (mode === "cancel") {
    const adminSecret = userId;
    process.env.PLATFORM_ADMIN_SECRET = adminSecret;
    (globalThis as typeof globalThis & { require?: NodeRequire }).require ??=
      createRequire(fileURLToPath(new URL("../routes/finance.ts", import.meta.url)));
    const app = (await import("../app")).default;
    await (await import("../routes/index")).labtraxRoutesReady;
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("API worker did not bind a TCP port.");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/backup/cancel/${runId}`, {
        method: "POST",
        headers: {
          "X-Platform-Admin-Secret": adminSecret,
          "X-LabTrax-Backup-Source": "development",
        },
      });
      send({ type: "cancel_result", status: response.status, result: await response.json() });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.end();
    }
    return;
  }

  throw new Error(`Unknown worker mode: ${mode}`);
}

void run().catch(async error => {
  send({ type: "worker_error", error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});
