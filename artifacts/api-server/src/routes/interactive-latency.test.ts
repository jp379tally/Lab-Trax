/**
 * Isolated dev fixture benchmark, NOT production recovery evidence.
 * Background mode runs a read-only pg_dump to /dev/null, not a backup upload
 * or restore, and never alters real cases. Timing thresholds are not CI gates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";

vi.mock("../lib/backup", () => ({ restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/billing-jobs", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/onedrive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/onedrive")>();
  const forbidden = () => { throw new Error("External OneDrive operations are forbidden in the synthetic benchmark"); };
  return {
    ...actual, isOneDriveConnectorAvailable: () => false,
    uploadBackupToOneDrive: forbidden, uploadBackupFileToOneDrive: forbidden,
    deleteOneDriveBackupFile: forbidden, pruneOneDriveBackups: forbidden,
    listOneDriveBackupFiles: forbidden, getOneDriveFileByName: forbidden,
    downloadFileFromOneDrive: forbidden,
  };
});
// Never add a resource-heavy performance probe to the shared DB release suite.
// The dedicated runner creates its own disposable database.
const maybe = process.env.LABTRAX_ISOLATED_LATENCY === "1" ? describe : describe.skip;
const reportDir = process.env.LABTRAX_LATENCY_REPORT_DIR;
interface BenchmarkProfile {
  cases: number; concurrency: number; rounds: number; mediaFiles: number;
}
maybe("interactive latency under concurrent reads and a background dump", () => {
  const user = randomUUID(), foreignUser = randomUUID(), lab = randomUUID(), practice = randomUUID(), session = randomUUID();
  let caseIds = Array.from({ length: 8 }, () => randomUUID());
  let profile: BenchmarkProfile;
  let mod: typeof import("@workspace/db");
  let app: express.Express, before: express.Express, token: string;
  beforeAll(async () => {
    // Both isolation markers must agree with the local database and temp media
    // root before any fixture writes. A bare opt-in flag is not sufficient.
    const root = process.env.LABTRAX_LATENCY_ROOT;
    const url = new URL(process.env.DATABASE_URL!);
    if (!root?.startsWith("/tmp/labtrax-latency.") || url.hostname !== "127.0.0.1" ||
        url.pathname !== "/latency_probe" || process.env.CASE_MEDIA_ROOT !== path.join(root, "uploads")) {
      throw new Error("Benchmark requires the dedicated disposable runner");
    }
    if (reportDir) {
      profile = JSON.parse(await readFile(path.join(reportDir, "profile.json"), "utf8"));
      caseIds = Array.from({ length: profile.cases }, () => randomUUID());
    }
    mod = await import("@workspace/db");
    const { signAccessToken } = await import("../lib/auth");
    const { getSubjectForUser } = await import("../lib/entitlement");
    const { requestPerformance } = await import("../middlewares/request-performance");
    const { logger } = await import("../lib/logger");
    app = (await import("../app")).default;
    await (await import("../lib/lab-case-projection")).ensureLabCaseProjection();
    await vi.waitFor(async () => expect((await request(app).get("/api/__latency_missing__")).status).toBe(404));
    await mod.db.insert(mod.users).values([
      { id: user, username: `latency-${user}`, password: "fixture", userType: "lab" },
      { id: foreignUser, username: `latency-${foreignUser}`, password: "fixture", userType: "lab" },
    ]);
    await mod.db.insert(mod.organizations).values([
      { id: lab, name: "Latency fixture", type: "lab" },
      { id: practice, name: "Latency practice", type: "provider", parentLabOrganizationId: lab },
    ]);
    await mod.db.insert(mod.organizationMemberships).values({ id: randomUUID(), labId: lab, userId: user, role: "admin", status: "active" });
    token = signAccessToken(user, session);
    await mod.db.insert(mod.userSessions).values({ id: session, userId: user, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000) });
    await mod.db.insert(mod.notifications).values([
      { userId: user, type: "test", title: "Fixture", body: "Fixture" },
      { userId: foreignUser, type: "test", title: "Foreign fixture", body: "Fixture" },
    ]);
    for (let offset = 0; offset < caseIds.length; offset += 500) {
      await mod.db.insert(mod.cases).values(caseIds.slice(offset, offset + 500).map((id) => ({
        id, caseNumber: `LAT-${id}`, labOrganizationId: lab, providerOrganizationId: practice, createdByUserId: user,
        doctorName: "Fixture", patientFirstName: "Fixture", patientLastName: "Fixture",
      })));
    }
    // Previous shared auth algorithm, using only this suite's synthetic
    // identity. The notification query and DB binding match the current path.
    before = express();
    before.use((req, _res, next) => { req.log = logger; next(); }, requestPerformance);
    before.get("/api/notifications", async (_req, res) => {
      const liveSession = await mod.db.query.userSessions.findFirst({
        where: and(eq(mod.userSessions.id, session), eq(mod.userSessions.userId, user), isNull(mod.userSessions.revokedAt), gt(mod.userSessions.expiresAt, new Date())),
        columns: { id: true },
      });
      expect(liveSession).toBeDefined();
      const [identity] = await mod.db.select().from(mod.users).where(eq(mod.users.id, user)).limit(1);
      expect(identity?.isActive).toBe(true);
      await getSubjectForUser(user);
      const rows = await mod.db.select().from(mod.notifications).where(eq(mod.notifications.userId, user)).orderBy(desc(mod.notifications.createdAt)).limit(50);
      res.json({ ok: true, data: rows });
    });
  });
  beforeEach(async () => {
    await mod.db.update(mod.userSessions).set({ revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) }).where(eq(mod.userSessions.id, session));
  });
  afterAll(async () => {
    if (!mod) return;
    await mod.db.delete(mod.notifications).where(inArray(mod.notifications.userId, [user, foreignUser]));
    await mod.db.delete(mod.cases).where(inArray(mod.cases.id, caseIds));
    await mod.db.delete(mod.userSessions).where(eq(mod.userSessions.id, session));
    await mod.db.delete(mod.organizationMemberships).where(eq(mod.organizationMemberships.labId, lab));
    await mod.db.delete(mod.organizations).where(eq(mod.organizations.id, practice));
    await mod.db.delete(mod.organizations).where(eq(mod.organizations.id, lab));
    await mod.db.delete(mod.users).where(inArray(mod.users.id, [user, foreignUser]));
  });
  async function burst(target: express.Express) {
    const values = await Promise.all(Array.from({ length: 18 }, async () => {
      const start = performance.now();
      const r = await request(target).get("/api/notifications").set("Authorization", `Bearer ${token}`);
      expect(r.status).toBe(200);
      expect(r.body.data).toHaveLength(1);
      expect(r.body.data[0].userId).toBe(user);
      expect(r.headers["server-timing"]).toContain("dbCheckout");
      return Math.round(performance.now() - start);
    }));
    values.sort((a, b) => a - b);
    return { minMs: values[0], medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
  }
  (reportDir ? it.skip : it)("records comparable cold/warm and dump-active before/after timings without changing the pool", async () => {
    const result: Record<string, unknown> = {};
    result.beforeIdleCold = await burst(before);
    result.afterIdleCold = await burst(app);
    result.beforeIdleWarm = await burst(before);
    result.afterIdleWarm = await burst(app);
    const dump = spawn("pg_dump", ["--dbname", process.env.DATABASE_URL!, "--format=custom", "--no-sync", "--file=/dev/null"], {
      env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Drain without retaining dump text, paths or credentials.
    dump.stderr?.resume();
    const done = new Promise<number | null>((resolve, reject) => {
      dump.once("error", reject);
      dump.once("exit", resolve);
    });
    // Attach rejection handler immediately; avoid unhandled failures in CI.
    void done.catch(() => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(dump.exitCode, "dump must be active during comparison").toBeNull();
      result.beforeDumpActive = await burst(before);
      expect(dump.exitCode, "dump finished too early to label this active").toBeNull();
      result.afterDumpOverlap = await burst(app);
      result.dumpStillActiveAfter = dump.exitCode === null;
      // Also exercise the unchanged full archive builder (DB + synthetic
      // media + encryption), not only pg_dump. Never invoke OneDrive or a
      // scheduler, and never touch shared upload directories.
      const backup = await vi.importActual<typeof import("../lib/backup")>("../lib/backup");
      const root = process.env.LABTRAX_LATENCY_ROOT!;
      const uploads = path.join(root, "uploads");
      await mkdir(path.join(uploads, "case-media"), { recursive: true });
      await writeFile(path.join(uploads, "case-media", "synthetic-latency.txt"), "Nonclinical backup workload fixture");
      backup._setUploadsRootForTests(uploads);
      let backupActive = true;
      const backupStart = performance.now();
      const archive = backup.runLocalBackup("latency-fixture", path.join(root, "archives"));
      void archive.then(() => { backupActive = false; }, () => { backupActive = false; });
      try {
        result.beforeFullArchiveOverlap = await burst(before);
        result.afterFullArchiveOverlap = await burst(app);
        result.fullArchiveActiveAfterReads = backupActive;
        const built = await archive;
        expect(built.mediaFileCount).toBe(1);
        expect(built.size).toBeGreaterThan(0);
        result.fullArchiveMs = Math.round(performance.now() - backupStart);
      } finally {
        await archive.catch(() => {});
        backup._setUploadsRootForTests(null);
      }
      const caseStart = performance.now();
      const responses = await Promise.all(Array.from({ length: 8 }, () =>
        request(app).get(`/api/cases/worklist?organizationId=${lab}&pageSize=3`).set("Authorization", `Bearer ${token}`)));
      result.caseWorklistBurstMs = Math.round(performance.now() - caseStart);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.body.data.rows).toHaveLength(3);
        expect(response.body.data.total).toBe(8);
      }
      const notification = (await request(app).get("/api/notifications").set("Authorization", `Bearer ${token}`)).body.data[0];
      expect((await request(app).patch(`/api/notifications/${notification.id}/read`).set("Authorization", `Bearer ${token}`)).status).toBe(200);
      const read = await request(app).get("/api/notifications").set("Authorization", `Bearer ${token}`);
      expect(read.body.data[0].readAt).not.toBeNull();
      process.stdout.write(`ISOLATED_INTERACTIVE_LATENCY ${JSON.stringify(result)}\n`);
    } finally {
      dump.kill("SIGTERM");
      await done;
    }
  });
  (reportDir ? it : it.skip)("writes a fresh-process cold/warm sample for the scheduled synthetic report", async () => {
    const mode = process.env.LABTRAX_LATENCY_MODE!;
    const mix = process.env.LABTRAX_LATENCY_MIX!;
    const sample = Number(process.env.LABTRAX_LATENCY_SAMPLE);
    expect(["idle", "dump", "archive"]).toContain(mode);
    expect(["notifications", "worklist", "mixed"]).toContain(mix);
    expect(Number.isInteger(sample) && sample > 0).toBe(true);
    const notificationId = (await mod.db.select({ id: mod.notifications.id }).from(mod.notifications)
      .where(eq(mod.notifications.userId, user)))[0].id;
    let active = mode === "idle";
    let startedAt = 0;
    let background: Promise<unknown> = Promise.resolve();
    let dump: ReturnType<typeof spawn> | undefined;
    let resetUploads = () => {};
    let archivePath: string | undefined;
    const root = process.env.LABTRAX_LATENCY_ROOT!;
    if (mode === "dump") {
      startedAt = performance.now();
      dump = spawn("pg_dump", ["--dbname", process.env.DATABASE_URL!, "--format=custom", "--no-sync", "--file=/dev/null"], {
        env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let dumpError = "";
      dump.stderr?.on("data", (chunk: Buffer) => {
        // Only the disposable binding exists here; still redact connection URLs
        // and bound diagnostics rather than retaining arbitrary command output.
        dumpError = (dumpError + chunk.toString().replace(/postgres(?:ql)?:\/\/\S+/g, "[database]")).slice(-1024);
      });
      background = new Promise<void>((resolve, reject) => {
        dump!.once("spawn", () => { active = true; });
        dump!.once("error", reject);
        dump!.once("exit", (code) => {
          active = false;
          if (code === 0) resolve(); else reject(new Error(`Synthetic dump failed (exit ${code}): ${dumpError}`));
        });
      });
      void background.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else if (mode === "archive") {
      const backup = await vi.importActual<typeof import("../lib/backup")>("../lib/backup");
      backup._setUploadsRootForTests(path.join(root, "uploads"));
      resetUploads = () => backup._setUploadsRootForTests(null);
      startedAt = performance.now();
      active = true;
      background = backup.runLocalBackup("synthetic-performance", path.join(root, "archives")).then((built) => {
        archivePath = built.path;
        expect(built.mediaFileCount).toBe(profile.mediaFiles);
        expect(built.size).toBeGreaterThan(0);
      });
    }
    let finishedAt = 0;
    if (mode !== "idle") background = background.finally(() => { active = false; finishedAt = performance.now(); });
    void background.catch(() => {});
    async function burstMix() {
      if (!active) await background; // Surface command failure before overlap assertion.
      expect(active, "Background must overlap the entire measured request burst").toBe(true);
      const values = await Promise.all(Array.from({ length: profile.concurrency }, async (_, index) => {
        const kind = mix === "mixed" ? ["notifications", "worklist", "mark-read"][index % 3] : mix;
        const start = performance.now();
        const response = kind === "mark-read"
          ? await request(app).patch(`/api/notifications/${notificationId}/read`).set("Authorization", `Bearer ${token}`)
          : await request(app).get(kind === "notifications" ? "/api/notifications" :
            `/api/cases/worklist?organizationId=${lab}&pageSize=25`).set("Authorization", `Bearer ${token}`);
        const elapsed = performance.now() - start;
        expect(response.status).toBe(200);
        if (kind === "notifications") {
          expect(response.body.data).toHaveLength(1);
          expect(response.body.data[0].userId).toBe(user);
        } else if (kind === "worklist") {
          expect(response.body.data.total).toBe(profile.cases);
          expect(response.body.data.rows).toHaveLength(Math.min(25, profile.cases));
        } else {
          const [row] = await mod.db.select({ readAt: mod.notifications.readAt }).from(mod.notifications)
            .where(eq(mod.notifications.id, notificationId));
          expect(row.readAt).not.toBeNull();
        }
        return elapsed;
      }));
      expect(active, "Background ended before the burst completed; never label idle measurements as overlap").toBe(true);
      return values;
    }
    try {
      // Startup/fixture preparation is excluded; first authenticated request
      // burst is cold. No earlier requests to these measured endpoints.
      const cold = await burstMix();
      await burstMix(); // Explicit unmeasured warm-up.
      const warm: number[] = [];
      for (let round = 0; round < profile.rounds; round++) warm.push(...await burstMix());
      if (mode !== "idle") await background;
      await writeFile(path.join(reportDir!, `sample-${sample}-${mode}-${mix}.json`), JSON.stringify({
        sample, mode, mix, profile, overlapVerified: true,
        timings: { cold, warm },
        ...(mode !== "idle" ? { backgroundMs: finishedAt - startedAt } : {}),
      }));
    } finally {
      // Drain all background work before deleting fixtures; never restore data.
      // If failed early, stop dump promptly; archives finish before cleanup.
      if (dump && dump.exitCode === null) dump.kill("SIGTERM");
      await background.catch(() => {});
      resetUploads();
      if (archivePath) await rm(archivePath, { force: true });
    }
  });
  it("honors live authorization revocation on the next request", async () => {
    await mod.db.update(mod.userSessions).set({ revokedAt: new Date() }).where(eq(mod.userSessions.id, session));
    expect((await request(app).get("/api/notifications").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });
});
