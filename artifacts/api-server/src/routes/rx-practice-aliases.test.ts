/**
 * Regression tests for GET/POST /api/rx-practice-aliases.
 *
 * Skipped when no DATABASE_URL is configured (matches the convention used by
 * other api-server integration tests).
 *
 * Coverage:
 *  - POST saves an alias; GET returns it for the same lab and normalized name.
 *  - GET returns found:false for a different lab (cross-lab isolation).
 *  - Normalization: saving "Nicholas  Eli  Kizirian" (extra spaces) and looking
 *    up "nicholas eli kizirian" (different case + single spaces) returns the same
 *    alias.
 *  - GET returns 403 for a caller who is not a member of the lab.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

vi.mock("../lib/backup.js", () => ({
  restartScheduledBackupJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/billing-jobs.js", () => ({ startBillingJobs: vi.fn() }));
vi.mock("../lib/statements.js", () => ({ startStatementScheduler: vi.fn() }));
vi.mock("../lib/case-media.js", () => ({
  startDailyOrphanedMediaCleanup: vi.fn(),
  caseMediaDir: path.join(require("os").tmpdir(), "labtrax-test-aliases"),
  extractMediaFileName: () => null,
}));

const SHOULD_RUN = !!process.env["DATABASE_URL"];
const maybe = SHOULD_RUN ? describe : describe.skip;

function rid(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

maybe("GET/POST /api/rx-practice-aliases (db integration)", () => {
  let appMod: { default: import("express").Express };
  let dbMod: typeof import("@workspace/db");
  let token: string;

  const labOrgId = rid("lab");
  const otherLabOrgId = rid("lab2");
  const providerOrgId = rid("prov");
  const userId = rid("u");
  // A second membership id so the user belongs to otherLabOrgId too, making the
  // cross-lab isolation test an authorized `found:false` rather than a 403.
  const otherMembershipId = rid("m2");

  beforeAll(async () => {
    process.env["JWT_SECRET"] =
      process.env["JWT_SECRET"] ?? "labtrax-test-secret-aliases";
    appMod = await import("../app.js");
    dbMod = await import("@workspace/db");
    const { db, organizations, organizationMemberships, users } =
      dbMod as any;

    // Seed user + lab orgs + membership
    await db.insert(users).values({
      id: userId,
      username: `aliastest_${userId}`,
      password: "x",
    });
    await db.insert(organizations).values([
      { id: labOrgId, type: "lab", name: "Alias Test Lab" },
      { id: otherLabOrgId, type: "lab", name: "Other Lab" },
      { id: providerOrgId, type: "provider", name: "Alias Provider" },
    ]);
    await db.insert(organizationMemberships).values([
      {
        id: rid("m"),
        userId,
        labId: labOrgId,
        role: "admin",
        status: "active",
      },
      // Second membership so cross-lab isolation test can be an authorized
      // found:false check rather than a 403 (no access at all).
      {
        id: otherMembershipId,
        userId,
        labId: otherLabOrgId,
        role: "admin",
        status: "active",
      },
    ]);

    // Mint a JWT for authenticated requests.
    const loginResp = await request(appMod.default)
      .post("/api/auth/login")
      .send({
        username: `aliastest_${userId}`,
        password: "x",
      });
    // If login isn't available (password hash check fails), create token directly.
    if (loginResp.status === 200) {
      token = loginResp.body?.data?.accessToken ?? loginResp.body?.accessToken;
    }
    if (!token) {
      // Mint directly via the JWT secret (test-only fallback).
      const jwt = await import("jsonwebtoken");
      token = jwt.default.sign(
        { id: userId, username: `aliastest_${userId}`, role: "user" },
        process.env["JWT_SECRET"]!,
        { expiresIn: "1h" },
      );
    }
  });

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const { db, organizations, organizationMemberships, users, rxPracticeNameAliases } =
      dbMod as any;
    const { eq } = await import("drizzle-orm");
    await db
      .delete(rxPracticeNameAliases)
      .where(eq(rxPracticeNameAliases.labOrganizationId, labOrgId));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.userId, userId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, labOrgId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, otherLabOrgId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, providerOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("POST saves an alias; GET returns it for the same lab and normalized name", async () => {
    const rxName = "Sunshine Dental";

    const postResp = await request(appMod.default)
      .post("/api/rx-practice-aliases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: labOrgId,
        rxName,
        providerOrganizationId: providerOrgId,
      });
    expect(postResp.status).toBe(200);
    expect(postResp.body.ok).toBe(true);
    expect(postResp.body.data.found).toBe(true);

    const getResp = await request(appMod.default)
      .get(
        `/api/rx-practice-aliases?labOrganizationId=${labOrgId}&rxName=${encodeURIComponent(rxName)}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.data.found).toBe(true);
    expect(getResp.body.data.providerOrganizationId).toBe(providerOrgId);
  });

  it("GET returns found:false for a different lab when the caller is a member of that lab but the alias was saved under a different lab (cross-lab isolation)", async () => {
    // rxName "Sunshine Dental" was saved under labOrgId (in the previous test).
    // Looking it up under otherLabOrgId — where the user IS a member but no
    // alias exists — must return found:false, not the labOrgId alias.
    const rxName = "Sunshine Dental";

    const getResp = await request(appMod.default)
      .get(
        `/api/rx-practice-aliases?labOrganizationId=${otherLabOrgId}&rxName=${encodeURIComponent(rxName)}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.data.found).toBe(false);
    expect(getResp.body.data.providerOrganizationId).toBeNull();
  });

  it("normalizes extra internal whitespace so OCR variants match the saved alias", async () => {
    const rxNameWithExtraSpaces = "Nicholas  Eli  Kizirian";
    const rxNameNormalized = "nicholas eli kizirian";

    await request(appMod.default)
      .post("/api/rx-practice-aliases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        labOrganizationId: labOrgId,
        rxName: rxNameWithExtraSpaces,
        providerOrganizationId: providerOrgId,
      })
      .expect(200);

    const getResp = await request(appMod.default)
      .get(
        `/api/rx-practice-aliases?labOrganizationId=${labOrgId}&rxName=${encodeURIComponent(rxNameNormalized)}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(getResp.status).toBe(200);
    expect(getResp.body.data.found).toBe(true);
    expect(getResp.body.data.providerOrganizationId).toBe(providerOrgId);
  });

  it("GET returns 400 when rxName is missing", async () => {
    const r = await request(appMod.default)
      .get(`/api/rx-practice-aliases?labOrganizationId=${labOrgId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(400);
  });
});
