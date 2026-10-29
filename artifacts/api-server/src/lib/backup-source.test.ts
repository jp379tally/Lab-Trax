import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBackupSourceEnvironment, requireMatchingBackupSource, requireProductionApplicationBackup } from "./backup-source";

const state = vi.hoisted(() => ({ production: false }));
vi.mock("./onedrive", () => ({ isProductionDeployment: () => state.production }));

describe("connected backup source cannot rebind a database", () => {
  beforeEach(() => { state.production = false; });
  for (const source of ["development", "production"] as const) {
    it(`labels and accepts the connected ${source} source`, async () => {
      state.production = source === "production";
      const app = express();
      const capture = vi.fn((_req, res) => res.json({ source: getBackupSourceEnvironment() }));
      app.post("/backup", requireMatchingBackupSource, capture);
      const response = await request(app).post("/backup").set("X-LabTrax-Backup-Source", source);
      expect(response.status).toBe(200);
      expect(response.body.source).toBe(source);
      expect(response.headers["x-labtrax-backup-source"]).toBe(source);
      expect(capture).toHaveBeenCalledTimes(1);
    });
    it(`refuses the other source before ${source} capture or scheduling`, async () => {
      state.production = source === "production";
      const app = express();
      const capture = vi.fn((_req, res) => res.sendStatus(200));
      app.post("/backup", requireMatchingBackupSource, capture);
      const response = await request(app).post("/backup")
        .set("X-LabTrax-Backup-Source", source === "production" ? "development" : "production");
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("No backup or schedule change was started");
      expect(capture).not.toHaveBeenCalled();
    });
  }
  it("rejects an invalid source rather than accepting a connection string", async () => {
    const app = express();
    const capture = vi.fn((_req, res) => res.sendStatus(200));
    app.post("/backup", requireMatchingBackupSource, capture);
    expect((await request(app).post("/backup")
      .set("X-LabTrax-Backup-Source", "another-database")).status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });
  it("retains compatibility for existing clients without a source header", async () => {
    const app = express();
    app.post("/backup", requireMatchingBackupSource, (_req, res) => res.sendStatus(200));
    expect((await request(app).post("/backup")).status).toBe(200);
  });
});

describe("interactive application backups are production-only", () => {
  afterEach(() => vi.unstubAllEnvs());
  function fixture() {
    const app = express();
    const capture = vi.fn((_req, res) => res.json({ ok: true }));
    app.post("/backup", requireProductionApplicationBackup, capture);
    return { app, capture };
  }
  it("rejects development application capture before any work starts", async () => {
    state.production = false; vi.stubEnv("PLATFORM_ADMIN_SECRET", "synthetic-operator-secret");
    const { app, capture } = fixture();
    expect((await request(app).post("/backup")).status).toBe(403);
    expect(capture).not.toHaveBeenCalled();
  });
  it("accepts production application capture", async () => {
    state.production = true; const { app, capture } = fixture();
    expect((await request(app).post("/backup")).status).toBe(200);
    expect(capture).toHaveBeenCalledOnce();
  });
  it("keeps explicit operator development exports separate from app-user backups", async () => {
    state.production = false; vi.stubEnv("PLATFORM_ADMIN_SECRET", "synthetic-operator-secret");
    const { app } = fixture();
    expect((await request(app).post("/backup").set("X-Platform-Admin-Secret", "wrong")).status).toBe(403);
    expect((await request(app).post("/backup").set("X-Platform-Admin-Secret", "synthetic-operator-secret")).status).toBe(200);
  });
});
