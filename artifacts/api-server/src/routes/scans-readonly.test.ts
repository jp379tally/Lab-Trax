import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-1",
  job: {
    id: "scan-1",
    labOrganizationId: "lab-1",
    status: "completed",
  },
  output: {
    jobId: "scan-1",
    format: "ply",
    readyAt: new Date(),
    storageKey: "scan-1/output.ply",
    mimeType: "model/ply",
  },
  member: true,
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: state.userId };
    next();
  },
}));

vi.mock("@workspace/db", () => {
  const tables = {
    scanJobs: { name: "scanJobs" },
    scanOutputs: { name: "scanOutputs" },
    users: { name: "users" },
    organizations: { name: "organizations" },
    organizationMemberships: { name: "organizationMemberships" },
  };
  return {
    ...tables,
    db: {
      select: () => {
        let tableName = "";
        const builder: any = {
          from(table: any) {
            tableName = table.name;
            return builder;
          },
          innerJoin() {
            return builder;
          },
          where() {
            return builder;
          },
          limit: async () => {
            if (tableName === "scanJobs") return [state.job];
            if (tableName === "scanOutputs") return [state.output];
            return state.member ? [{ id: "membership-1", userType: "lab" }] : [];
          },
        };
        return builder;
      },
    },
  };
});

vi.mock("../lib/case-media-object-storage", () => ({
  openCaseMediaObjectStream: vi.fn(async () => ({
    stream: {
      pipe(res: any) {
        res.end("ply-bytes");
      },
    },
  })),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  isNull: (arg: unknown) => arg,
  isNotNull: (arg: unknown) => arg,
}));

import scansReadonlyRouter from "./scans-readonly";

function makeApp() {
  const app = express();
  app.use("/api", scansReadonlyRouter);
  return app;
}

describe("read-only legacy scan output route", () => {
  beforeEach(() => {
    state.member = true;
    state.job.status = "completed";
  });

  it("serves a completed pre-existing PLY output to an active lab member", async () => {
    const response = await request(makeApp()).get("/api/labtrax/scans/scan-1/outputs/ply");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("model/ply");
    expect(response.headers["content-disposition"]).toContain("scan-scan-1.ply");
    expect(response.text).toBe("ply-bytes");
  });

  it("denies unauthorized or cross-lab access", async () => {
    state.member = false;
    const response = await request(makeApp()).get("/api/labtrax/scans/scan-1/outputs/ply");
    expect(response.status).toBe(404);
  });

  it("rejects formats outside the read-only PLY/STL allowlist", async () => {
    const response = await request(makeApp()).get("/api/labtrax/scans/scan-1/outputs/obj");
    expect(response.status).toBe(400);
  });
});